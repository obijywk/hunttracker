import moment = require("moment");
import * as diacritics from "diacritics";
import * as emoji from "node-emoji";
import { PoolClient } from "pg";
import { ButtonAction, PlainTextOption } from "@slack/bolt";

import { app } from "./app";
import * as db from "./db";
import * as googleDrive from "./google_drive";
import * as googleCalendar from "./google_calendar";
import {
  ChatPostMessageResult,
  ConversationsCreateResult,
  ConversationsHistoryResult,
  ConversationsInfoResult,
} from "./slack_results";
import {
  MAX_CHANNEL_NAME_LENGTH,
  MAX_OPTION_LENGTH,
  getViewStateValues,
} from "./slack_util";
import * as tags from "./tags";
import * as taskQueue from "./task_queue";
import * as users from "./users";
import { ActivityType, recordActivity } from "./activity";

export interface Puzzle {
  id: string;
  name: string;
  url: string;
  complete: boolean;
  answer: string;
  channelName: string;
  channelTopic: string;
  channelTopicModifiedTimestamp: moment.Moment;
  users: Array<users.User>;
  huddleUsers: Array<users.User>;
  formerUsers: Array<users.User>;
  tags: Array<tags.Tag>;
  sheetUrl: string;
  drawingUrl: string;
  calendarEventId: string;
  googleMeetUrl: string;
  registrationTimestamp: moment.Moment;
  chatModifiedTimestamp: moment.Moment;
  sheetModifiedTimestamp: moment.Moment;
  drawingModifiedTimestamp: moment.Moment;
  manualPokeTimestamp: moment.Moment;
  statusMessageTs?: string;
  huddleThreadMessageTs?: string;
}

export function chooseConsistentlyForPuzzle<T>(puzzle: Puzzle, choices: Array<T>): T {
  let h = 0;
  for (let i = 0; i < puzzle.id.length; i++) {
    h = ((h << 5) - h) + puzzle.id.charCodeAt(i);
    h = h & h;
  }
  return choices[Math.abs(h) % choices.length];
}

export const newPuzzleMinutes =
    process.env.NEW_PUZZLE_MINUTES ?
    Number(process.env.NEW_PUZZLE_MINUTES) :
    60;

export function isNew(puzzle: Puzzle): boolean {
  const now = moment().utc();
  return moment.duration(now.diff(puzzle.registrationTimestamp)).asMinutes() <=
      newPuzzleMinutes;
}

export function getPriority(puzzle: Puzzle): number {
  for (const tag of puzzle.tags) {
    if (!tag.name.startsWith("priority/")) {
      continue;
    }
    try {
      return parseInt(tag.name.substring("priority/".length));
    } catch {
      continue;
    }
  }
  return 0;
}

export function getIdleDuration(puzzle: Puzzle): moment.Duration {
  if (puzzle.complete) {
    return moment.duration(0);
  }
  const latestTimestamp = moment.max(
    puzzle.registrationTimestamp,
    puzzle.chatModifiedTimestamp,
    puzzle.sheetModifiedTimestamp,
    puzzle.drawingModifiedTimestamp,
    puzzle.manualPokeTimestamp,
  );
  return moment.duration(moment().utc().diff(latestTimestamp));
}

export function getTopicIdleDuration(puzzle: Puzzle): moment.Duration {
  if (puzzle.complete) {
    return moment.duration(0);
  }
  return moment.duration(moment().utc().diff(puzzle.channelTopicModifiedTimestamp));
}

export function buildIdleStatus(puzzle: Puzzle): string {
  const idleDuration = getIdleDuration(puzzle);
  if (idleDuration.asMinutes() >= Number(process.env.MINIMUM_IDLE_MINUTES)) {
    return `:stopwatch: _idle for ${idleDuration.humanize()}_`;
  }
  return "";
}

export function getLocation(puzzle: Puzzle): string | null {
  const match = puzzle.channelTopic.match(/loc(ation)? *\(([^)]+)\)/i);
  if (match) {
    return match[2];
  }
  if (puzzle.huddleThreadMessageTs) {
    return "Slack huddle";
  }
  return null;
}

export async function clearLocation(puzzle: Puzzle): Promise<void> {
  if (puzzle.channelTopic.match(/loc(ation)? *\(([^)]+)\)/i)) {
    puzzle.channelTopic = puzzle.channelTopic.replace(/loc(ation)? *\([^)]+\)/i, "");
    await app.client.conversations.setTopic({
      token: process.env.SLACK_USER_TOKEN,
      channel: puzzle.id,
      topic: puzzle.channelTopic,
    });
  }
}

interface ReadFromDatabaseOptions {
  id?: string;
  client?: PoolClient;
  excludeComplete?: boolean;
  withTag?: string;
  withSheetUrlIn?: Array<string>;
}

async function readFromDatabase(options: ReadFromDatabaseOptions): Promise<Array<Puzzle>> {
  let query = `
    SELECT
      id,
      name,
      url,
      complete,
      answer,
      channel_name,
      channel_topic,
      channel_topic_modified_timestamp,
      sheet_url,
      drawing_url,
      calendar_event_id,
      google_meet_url,
      (
        SELECT json_agg(row_to_json(users))
        FROM (
          SELECT
            users.*
          FROM users
          JOIN puzzle_user ON
            puzzle_user.user_id = users.id
          LEFT JOIN activity_latest_for_puzzle_and_user ON
            activity_latest_for_puzzle_and_user.user_id = users.id
          WHERE
            puzzle_user.puzzle_id = puzzles.id AND
            activity_latest_for_puzzle_and_user.puzzle_id = puzzles.id
          ORDER BY activity_latest_for_puzzle_and_user.timestamp DESC
        ) AS users
      ) users,
      (
        SELECT json_agg(row_to_json(users))
        FROM users
        JOIN puzzle_huddle_user ON puzzle_huddle_user.user_id = users.id
        WHERE puzzle_huddle_user.puzzle_id = puzzles.id
      ) huddle_users,
      (
        SELECT json_agg(row_to_json(users))
        FROM (
          SELECT
            users.*
          FROM users
          JOIN puzzle_former_user ON
            puzzle_former_user.user_id = users.id
          LEFT JOIN activity_latest_for_puzzle_and_user ON
            activity_latest_for_puzzle_and_user.user_id = users.id
          WHERE
            puzzle_former_user.puzzle_id = puzzles.id AND
            activity_latest_for_puzzle_and_user.puzzle_id = puzzles.id
          ORDER BY activity_latest_for_puzzle_and_user.timestamp DESC
        ) AS users
      ) former_users,
      (
        SELECT
          json_agg(
            json_build_object(
              'id', tags.id,
              'name', tags.name,
              'applied', puzzle_tag.applied
            )
            ORDER BY name
          )
        FROM tags
        JOIN puzzle_tag ON puzzle_tag.tag_id = tags.id
        WHERE puzzle_tag.puzzle_id = puzzles.id
      ) tags,
      registration_timestamp,
      chat_modified_timestamp,
      sheet_modified_timestamp,
      drawing_modified_timestamp,
      manual_poke_timestamp,
      status_message_ts,
      huddle_thread_message_ts
    FROM puzzles`;
  const whereConditions = [];
  const params = [];
  if (options.id) {
    params.push(options.id);
    whereConditions.push(`id = $${params.length}`);
  }
  if (options.excludeComplete) {
    whereConditions.push("complete = FALSE");
  }
  if (options.withTag) {
    params.push(options.withTag);
    whereConditions.push(`EXISTS (
      SELECT 1 FROM puzzle_tag
      JOIN tags ON puzzle_tag.tag_id = tags.id
      WHERE puzzle_tag.puzzle_id = puzzles.id AND tags.name = $${params.length}
    )`);
  }
  if (options.withSheetUrlIn) {
    const values = [];
    for (const sheetUrl of options.withSheetUrlIn) {
      values.push(`'${sheetUrl}'`);
    }
    whereConditions.push(`sheet_url IN (${values.join(",")})`);
  }
  if (whereConditions.length > 0) {
    query += "\nWHERE " + whereConditions.join(" AND ");
  }
  query += "\nORDER BY name ASC";
  const result = await db.query(query, params, options.client);
  const puzzles: Array<Puzzle> = [];
  for (const row of result.rows) {
    puzzles.push({
      id: row.id,
      name: row.name,
      url: row.url,
      complete: row.complete,
      answer: row.answer,
      channelName: row.channel_name,
      channelTopic: row.channel_topic,
      channelTopicModifiedTimestamp: moment.utc(row.channel_topic_modified_timestamp),
      users: (row.users || []).map(users.rowToUser),
      huddleUsers: (row.huddle_users || []).map(users.rowToUser),
      formerUsers: (row.former_users || []).map(users.rowToUser),
      tags: row.tags || [],
      sheetUrl: row.sheet_url,
      drawingUrl: row.drawing_url,
      calendarEventId: row.calendar_event_id,
      googleMeetUrl: row.google_meet_url,
      registrationTimestamp: moment.utc(row.registration_timestamp),
      chatModifiedTimestamp: moment.utc(row.chat_modified_timestamp),
      sheetModifiedTimestamp: moment.utc(row.sheet_modified_timestamp),
      drawingModifiedTimestamp: moment.utc(row.drawing_modified_timestamp),
      manualPokeTimestamp: moment.utc(row.manual_poke_timestamp),
      statusMessageTs: row.status_message_ts,
      huddleThreadMessageTs: row.huddle_thread_message_ts,
    });
  }
  return puzzles;
}

export async function get(id: string, client?: PoolClient): Promise<Puzzle> {
  const puzzles = await readFromDatabase({
    id,
    client,
  });
  if (puzzles.length !== 1) {
    throw `Unexpected number of puzzles for get: ${puzzles.length}`;
  }
  return puzzles[0];
}

export interface ListOptions {
  client?: PoolClient;
  excludeComplete?: boolean;
  withTag?: string;
  withSheetUrlIn?: Array<string>;
}

export async function list(options: ListOptions = {}): Promise<Array<Puzzle>> {
  return await readFromDatabase({
    client: options.client,
    excludeComplete: options.excludeComplete,
    withTag: options.withTag,
    withSheetUrlIn: options.withSheetUrlIn,
  });
}

export async function isPuzzleChannel(channelId: string): Promise<boolean> {
  const result = await db.query(
    "SELECT EXISTS (SELECT 1 FROM puzzles WHERE id = $1)",
    [channelId]);
  return result.rowCount > 0 && result.rows[0].exists;
}

export async function findChannelIdForChannelName(channelName: string): Promise<string | null> {
  const result = await db.query(
    "SELECT id FROM puzzles WHERE channel_name = $1",
    [channelName]);
  if (result.rowCount < 1) {
    return null;
  }
  return result.rows[0].id;
}

export async function isIdlePuzzleChannel(channelId: string): Promise<boolean> {
  const result = await db.query(`
    SELECT
      complete,
      registration_timestamp,
      chat_modified_timestamp,
      sheet_modified_timestamp,
      drawing_modified_timestamp,
      manual_poke_timestamp
    FROM puzzles
    WHERE id = $1
    `, [channelId]);
  if (result.rowCount === 0) {
    return false;
  }
  const row = result.rows[0];
  if (row.complete) {
    return false;
  }
  const latestTimestamp = moment.max(
    moment.utc(row.registration_timestamp),
    moment.utc(row.chat_modified_timestamp),
    moment.utc(row.sheet_modified_timestamp),
    moment.utc(row.drawing_modified_timestamp),
    moment.utc(row.manual_poke_timestamp),
  );
  return moment.duration(moment().utc().diff(latestTimestamp)).asMinutes() >= Number(process.env.MINIMUM_IDLE_MINUTES);
}

export function buildPuzzleNameMrkdwn(puzzle: Puzzle) {
  if (puzzle.url) {
    return `<${puzzle.url}|${puzzle.name}>`;
  } else {
    return puzzle.name;
  }
}

function buildPuzzleDocName(name: string, complete: boolean): string {
  let docName = "";
  if (complete) {
    docName += "✅ ";
  }
  docName += name;
  return docName;
}

function normalizeStringForChannelName(s: string): string {
  s = emoji.unemojify(s);
  return diacritics.remove(s)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function buildChannelName(puzzleName: string): string {
  let channelName = process.env.HUNT_PREFIX || "";
  if (channelName) {
    channelName += "-";
  }
  channelName += normalizeStringForChannelName(puzzleName);
  if (channelName.length > MAX_CHANNEL_NAME_LENGTH) {
    channelName = channelName.substring(0, MAX_CHANNEL_NAME_LENGTH);
  }
  return channelName;
}

export function buildTopicString(puzzle: Puzzle): string {
  let topicText = ":mag_right: ";
  if (puzzle.channelTopic) {
    topicText += puzzle.channelTopic;
    const topicIdleDuration = getTopicIdleDuration(puzzle);
    if (topicIdleDuration.asMinutes() > Number(process.env.MINIMUM_TOPIC_IDLE_MINUTES)) {
      topicText += `   :stopwatch: _updated ${topicIdleDuration.humanize()} ago_`;
    }
  } else {
    topicText += "_Topic not set. Consider adding one for the benefit of your teammates._";
  }
  return topicText;
}

function buildTopicBlock(puzzle: Puzzle) {
  return {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      text: buildTopicString(puzzle),
    },
    "accessory": {
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": ":mag_right: Update topic",
      },
      "action_id": "puzzle_update_topic",
      "value": puzzle.id,
    },
  };
}

function buildIdleStatusBlock(puzzle: Puzzle) {
  const idleStatus = buildIdleStatus(puzzle);
  if (!idleStatus) {
    return null;
  }
  return {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      text: idleStatus,
    },
    "accessory": {
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": ":stopwatch: Still solving",
      },
      "action_id": "puzzle_manual_poke",
      "value": puzzle.id,
    },
  };
}

function buildStatusMessageBlocks(puzzle: Puzzle): any {
  const actionButtons = [];

  if (puzzle.googleMeetUrl.length > 0) {
    actionButtons.push({
      type: "button",
      text: {
        type: "plain_text",
        text: ":movie_camera: Video chat",
      },
      "action_id": "puzzle_video_chat",
      url: puzzle.googleMeetUrl,
    });
  }

  actionButtons.push(tags.buildUpdateTagsButton(puzzle.id));

  const puzzleLinkBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `${puzzle.complete ? ":notebook:" : ":book:"} ${buildPuzzleNameMrkdwn(puzzle)}`,
    },
  };

  const fileButtons = [];

  if (puzzle.sheetUrl.length > 0) {
    fileButtons.push({
      type: "button",
      text: {
        type: "plain_text",
        text: ":bar_chart: Spreadsheet",
      },
      "action_id": "puzzle_open_spreadsheet",
      url: puzzle.sheetUrl,
    });
  }

  if (puzzle.drawingUrl.length > 0) {
    fileButtons.push({
      type: "button",
      text: {
        type: "plain_text",
        text: ":pencil2: Drawing",
      },
      "action_id": "puzzle_open_drawing",
      url: puzzle.drawingUrl,
    });
  }

  if (process.env.ENABLE_RECORD_ACTIVITY) {
    fileButtons.push({
      type: "button",
      text: {
        type: "plain_text",
        text: ":eyes: Activity",
      },
      "action_id": "puzzle_open_activity",
      url: `${process.env.WEB_SERVER_URL}puzzleactivity/${puzzle.id}`,
    });
  }

  const fileLinksBlock = {
    type: "actions",
    elements: fileButtons,
  };

  const blocks: Array<any> = [
    puzzleLinkBlock,
    fileLinksBlock,
  ];

  if (puzzle.answer) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:heavy_check_mark: ${puzzle.answer}`,
      },
      accessory: {
        type: "button",
        text: {
          type: "plain_text",
          text: ":phone: Update answer",
        },
        "action_id": "puzzle_record_confirmed_answer",
        value: puzzle.id,
      },
    });
  } else {
    actionButtons.push({
      type: "button",
      text: {
        type: "plain_text",
        text: ":phone: Record confirmed answer",
      },
      "action_id": "puzzle_record_confirmed_answer",
      value: puzzle.id,
    });
  }

  blocks.push(buildTopicBlock(puzzle));

  const idleStatusBlock = buildIdleStatusBlock(puzzle);
  if (idleStatusBlock) {
    blocks.push(idleStatusBlock);
  }

  const tagBlock = tags.buildTagsBlock(puzzle.id, puzzle.tags);
  if (tagBlock) {
    blocks.push(tagBlock);
  }

  if (puzzle.complete) {
    actionButtons.push({
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": ":card_file_box: Archive",
      },
      "action_id": "puzzle_archive_channel",
      "value": puzzle.id,
    });
  }
  blocks.push({
    "type": "actions",
    "elements": actionButtons,
  });

  return blocks;
}

async function updateStatusMessage(puzzle: Puzzle) {
  const postStatusMessageResult = await app.client.chat.update({
    token: process.env.SLACK_USER_TOKEN,
    channel: puzzle.id,
    text: "[status message]",
    ts: puzzle.statusMessageTs,
    blocks: buildStatusMessageBlocks(puzzle),
  }) as ChatPostMessageResult;
}

async function announceSolve(
    channelName: string, text: string, spoilerText: string) {
  const postMessageResult = await app.client.chat.postMessage({
    token: process.env.SLACK_USER_TOKEN,
    channel: `#${channelName}`,
    text,
  }) as ChatPostMessageResult;
  if (text !== spoilerText) {
    await app.client.chat.postMessage({
      token: process.env.SLACK_USER_TOKEN,
      channel: `#${channelName}`,
      "thread_ts": postMessageResult.ts,
      text: spoilerText,
    });
  }
}

app.action("puzzle_open_spreadsheet", async ({ack}) => {
  ack();
});

app.action("puzzle_open_drawing", async ({ack}) => {
  ack();
});

app.action("puzzle_open_activity", async ({ack}) => {
  ack();
});

app.action("puzzle_video_chat", async ({ack}) => {
  ack();
});

app.action("puzzle_manual_poke", async ({ack, payload}) => {
  const buttonAction = payload as ButtonAction;
  const id = buttonAction.value;
  await db.query(`
    UPDATE puzzles
    SET
      manual_poke_timestamp = NOW()
    WHERE id = $1`,
    [id]);
  await taskQueue.scheduleTask("refresh_puzzle", {id});
  ack();
});

app.action("puzzle_update_topic", async ({ ack, body, payload }) => {
  const id = (payload as ButtonAction).value;
  const puzzlePromise = get(id);

  const conversationInfoResult = await app.client.conversations.info({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
  }) as ConversationsInfoResult;

  const puzzle = await puzzlePromise;

  let topic = "";
  if (conversationInfoResult.channel.topic) {
    topic = conversationInfoResult.channel.topic.value;
  }

  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "puzzle_update_topic_view",
      "private_metadata": JSON.stringify({id}),
      title: {
        type: "plain_text",
        text: "Update topic",
      },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Enter a topic for the puzzle *${buildPuzzleNameMrkdwn(puzzle)}* below.` +
              " Consider including a summary of the puzzle content, whether or how you're stuck, and" +
              " how other team members might be able to help.",
          },
        },
        {
          type: "input",
          "block_id": "puzzle_topic_input",
          optional: true,
          label: {
            type: "plain_text",
            text: "Topic",
          },
          element: {
            type: "plain_text_input",
            placeholder: {
              type: "plain_text",
              text: "Enter topic",
            },
            "initial_value": topic,
            multiline: true,
          },
        },
      ],
      submit: {
        type: "plain_text",
        text: "Update topic",
      },
    },
  });
  ack();
});

app.view("puzzle_update_topic_view", async ({ack, view, body}) => {
  const id = JSON.parse(body.view.private_metadata)["id"] as string;
  const values = getViewStateValues(view);
  const topic: string = values["puzzle_topic_input"] || "";

  if (topic.length > 250) {
    ack({
      "response_action": "errors",
      errors: {
        "puzzle_topic_input": "A topic may only contain a maximum of 250 characters.",
      },
    } as any);
    return;
  }

  await app.client.conversations.setTopic({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
    topic,
  });
  await taskQueue.scheduleTask("refresh_puzzle", {id});

  ack();
});

app.action("puzzle_record_confirmed_answer", async ({ ack, body, payload }) => {
  const id = (payload as ButtonAction).value;
  const puzzle = await get(id);

  const puzzleSolvedOption: PlainTextOption = {
    text: {
      type: "plain_text",
      text: "Mark puzzle solved",
    },
    value: "true",
  };
  const puzzleUnsolvedOption: PlainTextOption = {
    text: {
      type: "plain_text",
      text: "Keep puzzle unsolved (this is unusual)",
    },
    value: "false",
  };
  const defaultUnsolved = !puzzle.complete && puzzle.answer.length > 0;

  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "puzzle_record_confirmed_answer_view",
      "private_metadata": JSON.stringify({
        id,
        channelName: puzzle.channelName,
      }),
      title: {
        type: "plain_text",
        text: "Record confirmed answer",
      },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Enter the *HQ-confirmed* answer for the puzzle *${buildPuzzleNameMrkdwn(puzzle)}* below.` +
              " Prefer to use only uppercase letters and spaces, unless there's a good reason not to.",
          },
        },
        {
          type: "input",
          "block_id": "puzzle_answer_input",
          optional: true,
          label: {
            type: "plain_text",
            text: "Puzzle answer",
          },
          element: {
            type: "plain_text_input",
            placeholder: {
              type: "plain_text",
              text: "Enter answer",
            },
            "initial_value": puzzle.answer || "",
          },
        },
        {
          type: "input",
          "block_id": "puzzle_solved_input",
          label: {
            type: "plain_text",
            text: "Is it solved?",
          },
          element: {
            type: "radio_buttons",
            "initial_option": defaultUnsolved ? puzzleUnsolvedOption : puzzleSolvedOption,
            options: [puzzleSolvedOption, puzzleUnsolvedOption],
          },
        },
        {
          type: "input",
          "block_id": "answer_allow_lowercase_input",
          optional: true,
          label: {
            type: "plain_text",
            text: "Record confirmed answer options",
          },
          element: {
            type: "checkboxes",
            options: [
              {
                text: {
                  type: "plain_text",
                  text: "Allow lowercase letters in this answer",
                },
                value: "answer_allow_lowercase",
              },
            ],
          },
        },
      ],
      submit: {
        type: "plain_text",
        text: "Submit",
      },
    },
  });
  ack();
});

app.view("puzzle_record_confirmed_answer_view", async ({ack, view, body}) => {
  const privateMetadata = JSON.parse(body.view.private_metadata);
  const id = privateMetadata.id as string;
  const channelName = privateMetadata.channelName as string;
  const values = getViewStateValues(view);
  const answer: string = values["puzzle_answer_input"] || "";
  const complete: boolean = values["puzzle_solved_input"] === "true";
  const allowLowercase: boolean = values["answer_allow_lowercase_input"].length > 0;

  if (!allowLowercase && answer.match(/[a-z]/)) {
    ack({
      "response_action": "errors",
      errors: {
        "puzzle_answer_input": "Prefer to use only uppercase letters. If you have a good reason to include lowercase letters, check the \"Allow lowercase letters in this answer\" box below.",
      },
    });
    return;
  }

  const puzzle = await get(id);
  if (puzzle.answer === answer && puzzle.complete === complete) {
    ack();
    return;
  }

  const renamePromises: Array<Promise<any>> = [];
  if (puzzle.complete !== complete) {
    const docName = buildPuzzleDocName(puzzle.name, complete);
    renamePromises.push(googleDrive.renameSheet(puzzle.sheetUrl, docName));
    if (puzzle.drawingUrl) {
      renamePromises.push(googleDrive.renameDrawing(puzzle.drawingUrl, docName));
    }
    if (process.env.ENABLE_GOOGLE_MEET) {
      if (puzzle.calendarEventId.length > 0) {
        renamePromises.push(googleCalendar.renameEvent(puzzle.calendarEventId, docName));
      }
    }
  }

  const recordActivityPromise = recordActivity(
    id,
    body.user.id,
    ActivityType.RecordAnswer);

  await db.query(
    "UPDATE puzzles SET answer = $2, complete = $3 WHERE id = $1",
    [id, answer, complete]);
  puzzle.answer = answer;
  puzzle.complete = complete;

  if (complete) {
    const tagText = puzzle.tags.length > 0 ? ` (${tags.buildTagLinks(puzzle.tags)})` : "";
    let text;
    let spoilerText;
    if (answer) {
      text = `${buildPuzzleNameMrkdwn(puzzle)} solved!${tagText}`;
      spoilerText = `${buildPuzzleNameMrkdwn(puzzle)} solved with answer *${puzzle.answer}*.`;
    } else {
      text = `${buildPuzzleNameMrkdwn(puzzle)} completed.${tagText}`;
      spoilerText = text;
    }
    const announcementPromises: Array<Promise<any>> = [
      app.client.chat.postMessage({
        token: process.env.SLACK_USER_TOKEN,
        channel: `#${channelName}`,
        text: spoilerText,
      }),
    ];
    if (process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
      announcementPromises.push(announceSolve(
        process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME, text, spoilerText));
    }
    if (process.env.SLACK_SOLVE_ANNOUNCEMENT_CHANNEL_NAME) {
      announcementPromises.push(announceSolve(
        process.env.SLACK_SOLVE_ANNOUNCEMENT_CHANNEL_NAME, text, spoilerText));
    }
    for (const p of announcementPromises) {
      await p;
    }
    await clearLocation(puzzle);
    await updateStatusMessage(puzzle);
    if (process.env.AUTO_ARCHIVE) {
      await app.client.conversations.archive({
        token: process.env.SLACK_USER_TOKEN,
        channel: id,
      });
    }
  } else {
    await taskQueue.scheduleTask("refresh_puzzle", {id});
  }

  for (const p of renamePromises) {
    await p;
  }
  await recordActivityPromise;

  ack();
});

app.action("puzzle_archive_channel", async ({ack, payload}) => {
  const buttonAction = payload as ButtonAction;
  const id = buttonAction.value;
  await app.client.conversations.archive({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
  });
  ack();
});

async function insert(puzzle: Puzzle, client: PoolClient) {
  await client.query(
    `INSERT INTO puzzles (
      id,
      name,
      url,
      complete,
      answer,
      channel_name,
      channel_topic,
      sheet_url,
      drawing_url,
      calendar_event_id,
      google_meet_url,
      registration_timestamp,
      chat_modified_timestamp,
      sheet_modified_timestamp,
      drawing_modified_timestamp,
      manual_poke_timestamp,
      status_message_ts,
      huddle_thread_message_ts
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      puzzle.id,
      puzzle.name,
      puzzle.url,
      puzzle.complete,
      puzzle.answer,
      puzzle.channelName,
      puzzle.channelTopic,
      puzzle.sheetUrl,
      puzzle.drawingUrl,
      puzzle.calendarEventId,
      puzzle.googleMeetUrl,
      puzzle.registrationTimestamp.format(),
      puzzle.chatModifiedTimestamp.format(),
      puzzle.sheetModifiedTimestamp.format(),
      puzzle.drawingModifiedTimestamp.format(),
      puzzle.manualPokeTimestamp.format(),
      puzzle.statusMessageTs || "",
      puzzle.huddleThreadMessageTs || "",
    ]);
}

async function getLatestMessageTimestamp(id: string): Promise<moment.Moment | null> {
  const channelHistoryResult = await app.client.conversations.history({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
    limit: 100,
  }) as ConversationsHistoryResult;
  for (const message of channelHistoryResult.messages) {
    if (message.type === "message" && message.subtype === "channel_join") {
      continue;
    }
    if (message.type === "message" && message.subtype === "channel_leave") {
      continue;
    }
    return moment.utc(moment.unix(Number(message.ts)));
  }
  return null;
}

async function getHuddleParticipantUserIds(puzzle: Puzzle): Promise<string[]> {
  if (!puzzle.huddleThreadMessageTs || puzzle.huddleThreadMessageTs.length === 0) {
    return [];
  }
  const channelHistoryResult = await app.client.conversations.history({
    token: process.env.SLACK_USER_TOKEN,
    channel: puzzle.id,
    inclusive: true,
    latest: puzzle.huddleThreadMessageTs,
    limit: 1,
  }) as ConversationsHistoryResult;
  for (const message of channelHistoryResult.messages) {
    if (message.ts !== puzzle.huddleThreadMessageTs) {
      continue;
    }
    const room = (message as any).room;
    if (room && room.participants) {
      return room.participants;
    }
  }
  return [];
}

async function validatePuzzleName(name: string): Promise<string | null> {
  if (!name || name.length === 0) {
    return "A puzzle name must not be empty.";
  }
  if (name.length > MAX_OPTION_LENGTH) {
    return "A puzzle name may only contain a maximum of 75 characters.";
  }
  const channelName = buildChannelName(name);
  const existsResult = await db.query(`
    SELECT EXISTS (
      SELECT 1
      FROM puzzles
      WHERE
        name = $1 OR
        channel_name = $2
    )
  `, [name, channelName]);
  if (existsResult.rowCount > 0 && existsResult.rows[0].exists) {
    return "A puzzle with the same name or channel has already been registered.";
  }
  return null;
}

async function validatePuzzleUrl(url: string): Promise<string | null> {
  const existsResult = await db.query(`
    SELECT EXISTS (
      SELECT 1
      FROM puzzles
      WHERE url = $1
    )
  `, [url]);
  if (existsResult.rowCount > 0 && existsResult.rows[0].exists) {
    return "A puzzle with that URL has already been registered.";
  }
  return null;
}

export enum PuzzleMetadataErrorField {
  Name,
  Url,
}

export interface PuzzleMetadataError {
  field: PuzzleMetadataErrorField;
  message: string;
}

export async function create(
  name: string,
  url: string,
  allowDuplicatePuzzleUrl: boolean,
  selectedTagIds: Array<number>,
  newTagNames: Array<string>,
  topic: string,
  creatorUserId: string,
): Promise<PuzzleMetadataError | null> {
  const validateName = validatePuzzleName(name);

  let validateUrl = null;
  if (url && url.length > 0 && !allowDuplicatePuzzleUrl) {
    validateUrl = validatePuzzleUrl(url);
  }

  const validateNameResult = await validateName;
  if (validateNameResult !== null) {
    return {
      field: PuzzleMetadataErrorField.Name,
      message: validateNameResult,
    };
  }

  let validateUrlResult = null;
  if (validateUrl !== null) {
    validateUrlResult = await validateUrl;
    if (validateUrlResult !== null) {
      return {
        field: PuzzleMetadataErrorField.Url,
        message: validateUrlResult,
      };
    }
  }

  await taskQueue.scheduleTask("create_puzzle", {
    name,
    url,
    selectedTagIds,
    newTagNames,
    topic,
    creatorUserId,
  });
  return null;
}

export async function edit(
  id: string,
  name: string,
  url: string,
  allowDuplicatePuzzleUrl: boolean,
  creatorUserId: string,
): Promise<PuzzleMetadataError | null> {
  let validateName = null;
  if (name && name.length > 0) {
    validateName = validatePuzzleName(name);
  }

  let validateUrl = null;
  if (url && url.length > 0 && !allowDuplicatePuzzleUrl) {
    validateUrl = validatePuzzleUrl(url);
  }

  let validateNameResult = null;
  if (validateName !== null) {
    validateNameResult = await validateName;
    if (validateNameResult !== null) {
      return {
        field: PuzzleMetadataErrorField.Name,
        message: validateNameResult,
      };
    }
  }

  let validateUrlResult = null;
  if (validateUrl !== null) {
    validateUrlResult = await validateUrl;
    if (validateUrlResult !== null) {
      return {
        field: PuzzleMetadataErrorField.Url,
        message: validateUrlResult,
      };
    }
  }

  await taskQueue.scheduleTask("edit_puzzle", {
    id,
    name,
    url,
    creatorUserId,
  });
  return null;
}

export async function deletePuzzle(id: string, creatorUserId: string) {
  await taskQueue.scheduleTask("delete_puzzle", {
    id,
    creatorUserId,
  });
}

export async function updateHuddleThreadMessageTs(id: string, eventTs: string) {
  await db.query(`
    UPDATE puzzles
    SET
      huddle_thread_message_ts = $2
    WHERE id = $1`,
    [ id, eventTs ]);
}

export async function refreshAll() {
  const result = await db.query("SELECT id FROM puzzles");
  for (const row of result.rows) {
    await taskQueue.scheduleTask(
      "refresh_puzzle",
      { id: row.id },
      undefined  /* client */,
      false,  /* notify */
    );
  }
  await taskQueue.notifyQueue();
}

export async function refreshStale() {
  const puzzles = await list();
  for (const puzzle of puzzles) {
    const hasHuddle = puzzle.huddleThreadMessageTs && puzzle.huddleThreadMessageTs.length > 0;
    const hasLowIdleDuration = getIdleDuration(puzzle).asMinutes() < Number(process.env.MINIMUM_IDLE_MINUTES);
    if (hasHuddle || (!puzzle.complete && !hasLowIdleDuration)) {
      await taskQueue.scheduleTask(
        "refresh_puzzle",
        { id: puzzle.id },
        undefined  /* client */,
        false,  /* notify */
      );
    }
  }
  await taskQueue.notifyQueue();
}

export async function refreshEventUsers(channelId: string, client?: PoolClient) {
  if (process.env.ENABLE_GOOGLE_MEET) {
    const puzzle = await get(channelId, client);
    if (puzzle.calendarEventId.length > 0) {
      await googleCalendar.updateEventUsers(puzzle.calendarEventId, puzzle.users);
    }
  }
}

export async function clearEventUsers(channelId: string) {
  if (process.env.ENABLE_GOOGLE_MEET) {
    const puzzle = await get(channelId);
    if (puzzle.calendarEventId.length > 0) {
      await googleCalendar.updateEventUsers(puzzle.calendarEventId, []);
    }
  }
}

async function syncBookmarks(puzzle: Puzzle): Promise<void> {
  const newBookmarks = new Map([
    { title: "Spreadsheet", emoji: ":bar_chart:", link: puzzle.sheetUrl },
    { title: "Drawing", emoji: ":pencil2:", link: puzzle.drawingUrl },
  ].map(b => [b.title, b]));
  if (puzzle.url !== null) {
    newBookmarks.set("Puzzle", { title: "Puzzle", emoji: ":jigsaw:", link: puzzle.url });
  }

  const existingBookmarks = await app.client.bookmarks.list({
    token: process.env.SLACK_USER_TOKEN,
    channel_id: puzzle.id,
  });

  const requests = [];
  if (existingBookmarks.ok === true) {
    for (const bookmark of existingBookmarks.bookmarks) {
      const newBookmark = newBookmarks.get(bookmark.title);
      if (newBookmark !== undefined) {
        if (bookmark.link !== newBookmark.link) {
          requests.push(app.client.bookmarks.edit({
            token: process.env.SLACK_USER_TOKEN,
            channel_id: puzzle.id,
            bookmark_id: bookmark.id,
            link: newBookmark.link,
          }));
        }
        newBookmarks.delete(bookmark.title);
      }
    }
  }
  for (const title of ["Puzzle", "Spreadsheet", "Drawing"]) {
    const bookmark = newBookmarks.get(title);
    if (bookmark !== undefined) {
      await app.client.bookmarks.add({
        token: process.env.SLACK_USER_TOKEN,
        channel_id: puzzle.id,
        type: "link",
        ...bookmark,
      });
    }
  }
  for (const request of requests) {
    await request;
  }
}

taskQueue.registerHandler("create_puzzle", async (client, payload) => {
  const name = payload.name;
  const url = payload.url;
  const selectedTagIds: Array<number> = payload.selectedTagIds;
  const newTagNames: Array<string> = payload.newTagNames;
  const topic = payload.topic ? payload.topic : "";
  const creatorUserId = payload.creatorUserId;

  const channelName = buildChannelName(name);
  const docName = buildPuzzleDocName(name, false);

  const createConversationResult = await app.client.conversations.create({
    token: process.env.SLACK_USER_TOKEN,
    name: channelName,
  }) as ConversationsCreateResult;
  const id = createConversationResult.channel.id;

  const sheetUrlPromise = googleDrive.copySheet(process.env.PUZZLE_SHEET_TEMPLATE_URL, docName);

  const drawingUrlPromise =
      process.env.PUZZLE_DRAWING_TEMPLATE_URL ?
      googleDrive.copyDrawing(process.env.PUZZLE_DRAWING_TEMPLATE_URL, docName) :
      Promise.resolve("");

  const calendarEventPromise =
      process.env.ENABLE_GOOGLE_MEET ?
      googleCalendar.createEvent(docName) :
      Promise.resolve({
        eventId: "",
        googleMeetUrl: "",
      });

  const sheetUrl = await sheetUrlPromise;
  const drawingUrl = await drawingUrlPromise;
  const calendarEvent = await calendarEventPromise;

  const now = moment().utc();
  let puzzle: Puzzle = {
    id,
    name,
    url,
    complete: false,
    answer: "",
    channelName,
    channelTopic: topic,
    channelTopicModifiedTimestamp: now,
    users: [],
    huddleUsers: [],
    formerUsers: [],
    tags: [],
    sheetUrl,
    drawingUrl,
    calendarEventId: calendarEvent.eventId,
    googleMeetUrl: calendarEvent.googleMeetUrl,
    registrationTimestamp: now,
    chatModifiedTimestamp: now,
    sheetModifiedTimestamp: now,
    drawingModifiedTimestamp: now,
    manualPokeTimestamp: now,
  };

  let setTopicPromise = undefined;
  if (topic) {
    setTopicPromise = app.client.conversations.setTopic({
      token: process.env.SLACK_USER_TOKEN,
      channel: id,
      topic,
    });
  }

  const postStatusMessageResult = await app.client.chat.postMessage({
    token: process.env.SLACK_USER_TOKEN,
    channel: `#${puzzle.channelName}`,
    text: "[status message]",
    blocks: buildStatusMessageBlocks(puzzle),
  }) as ChatPostMessageResult;
  puzzle.statusMessageTs = postStatusMessageResult.ts;

  const pinAndBookmarksPromise = app.client.pins.add({
    token: process.env.SLACK_USER_TOKEN,
    channel: puzzle.id,
    timestamp: puzzle.statusMessageTs,
  }).then(() => syncBookmarks(puzzle));

  const appendPuzzleRowToTrackingSheetPromise =
      googleDrive.appendPuzzleRowToTrackingSheet(name);

  await insert(puzzle, client);
  await tags.updateTags(id, selectedTagIds, newTagNames, client);
  puzzle = await get(id, client);

  await updateStatusMessage(puzzle);

  if (setTopicPromise) {
    await setTopicPromise;
  }
  await pinAndBookmarksPromise;
  await appendPuzzleRowToTrackingSheetPromise;

  if (process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
    await app.client.chat.postMessage({
      token: process.env.SLACK_USER_TOKEN,
      channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
      text: `<#${id}> created for ${buildPuzzleNameMrkdwn(puzzle)}.`,
    });
  }

  if (creatorUserId) {
    await taskQueue.scheduleTask("publish_home", {
      userId: creatorUserId,
    });
  }
});

taskQueue.registerHandler("edit_puzzle", async (client, payload) => {
  const id = payload.id;
  let name: string = payload.name;
  let url: string = payload.url;
  const creatorUserId = payload.creatorUserId;

  const puzzle = await get(id);
  if (!name || name.length == 0) {
    name = puzzle.name;
  }
  if (!url || url.length === 0) {
    url = puzzle.url;
  }

  const channelName = buildChannelName(name);
  if (channelName !== puzzle.channelName) {
    await app.client.conversations.rename({
      token: process.env.SLACK_USER_TOKEN,
      channel: id,
      name: channelName,
    });
  }

  if (name !== puzzle.name) {
    const docName = buildPuzzleDocName(name, puzzle.complete);
    await googleDrive.renameSheet(puzzle.sheetUrl, docName);
    if (puzzle.drawingUrl) {
      await googleDrive.renameDrawing(puzzle.drawingUrl, docName);
    }
    if (process.env.ENABLE_GOOGLE_MEET) {
      if (puzzle.calendarEventId.length > 0) {
        await googleCalendar.renameEvent(puzzle.calendarEventId, docName);
      }
    }
  }

  if (name !== puzzle.name || url !== puzzle.url) {
    await client.query(`
      UPDATE puzzles
      SET
        name = $2,
        url = $3,
        channel_name = $4
      WHERE id = $1`,
      [
        id,
        name,
        url,
        channelName,
      ]);
    await taskQueue.scheduleTask("refresh_puzzle", {id});
  }

  if (creatorUserId) {
    await taskQueue.scheduleTask("publish_home", {
      userId: creatorUserId,
    });
  }
});

taskQueue.registerHandler("delete_puzzle", async (client, payload) => {
  const id = payload.id;
  const creatorUserId = payload.creatorUserId;

  const archiveChannelPromise = app.client.conversations.archive({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
  });

  const puzzle = await get(id);
  const deleteSheetPromise = googleDrive.deleteSheet(puzzle.sheetUrl);
  const deleteDrawingPromise = googleDrive.deleteDrawing(puzzle.drawingUrl);

  await archiveChannelPromise;
  await deleteSheetPromise;
  await deleteDrawingPromise;

  await client.query("DELETE FROM activity WHERE puzzle_id = $1", [id]);
  await client.query("DELETE FROM puzzle_tag WHERE puzzle_id = $1", [id]);
  await client.query("DELETE FROM puzzle_user WHERE puzzle_id = $1", [id]);
  await client.query("DELETE FROM puzzle_huddle_user WHERE puzzle_id = $1", [id]);
  await client.query("DELETE FROM puzzle_former_user WHERE puzzle_id = $1", [id]);
  await client.query("DELETE FROM puzzles WHERE id = $1", [id]);

  if (process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
    await app.client.chat.postMessage({
      token: process.env.SLACK_USER_TOKEN,
      channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
      text: `The puzzle entry for ${buildPuzzleNameMrkdwn(puzzle)} was deleted.`,
    });
  }

  if (creatorUserId) {
    await taskQueue.scheduleTask("publish_home", {
      userId: creatorUserId,
    });
  }
});

export async function refreshPuzzle(id: string, client: PoolClient) {
  const conversationInfoResult = await app.client.conversations.info({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
  }) as ConversationsInfoResult;

  if (conversationInfoResult.channel.is_archived) {
    return;
  }

  const puzzle = await get(id, client);
  const refreshUsersPromise = users.refreshPuzzleUsers(id, client);
  const latestMessageTimestampPromise = getLatestMessageTimestamp(id);
  const huddleParticipantUserIdsPromise = getHuddleParticipantUserIds(puzzle);

  const now = moment().utc();

  let sheetMetadata = null;
  if (moment.duration(now.diff(puzzle.sheetModifiedTimestamp)).asMinutes() >=
      Number(process.env.MINIMUM_IDLE_MINUTES)) {
    sheetMetadata = await googleDrive.getSheetMetadata(puzzle.sheetUrl);
  }

  let drawingMetadata = null;
  if (moment.duration(now.diff(puzzle.drawingModifiedTimestamp)).asMinutes() >=
      Number(process.env.MINIMUM_IDLE_MINUTES)) {
    drawingMetadata = await googleDrive.getDrawingMetadata(puzzle.drawingUrl);
  }

  const renameDocPromises = [];
  const docName = buildPuzzleDocName(puzzle.name, puzzle.complete);
  if (sheetMetadata !== null && docName !== sheetMetadata.name) {
    renameDocPromises.push(googleDrive.renameSheet(puzzle.sheetUrl, docName));
  }
  if (drawingMetadata !== null && docName !== drawingMetadata.name) {
    renameDocPromises.push(googleDrive.renameDrawing(puzzle.drawingUrl, docName));
  }

  const latestMessageTimestamp = await latestMessageTimestampPromise;

  let dirty = false;
  if (conversationInfoResult.channel.topic) {
    const topicUpdateTimestamp = moment.utc(moment.unix(conversationInfoResult.channel.topic.last_set));
    if (puzzle.chatModifiedTimestamp.isBefore(topicUpdateTimestamp)) {
      dirty = true;
      puzzle.chatModifiedTimestamp = topicUpdateTimestamp;
    }
    if (puzzle.channelTopic !== conversationInfoResult.channel.topic.value) {
      dirty = true;
      puzzle.channelTopic = conversationInfoResult.channel.topic.value;
      if (puzzle.channelTopic && process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
        app.client.chat.postMessage({
          token: process.env.SLACK_USER_TOKEN,
          channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
          text: `<#${puzzle.id}> topic updated: ${puzzle.channelTopic}`,
        });
      }
    }
    if (puzzle.channelTopicModifiedTimestamp != topicUpdateTimestamp) {
      dirty = true;
      puzzle.channelTopicModifiedTimestamp = topicUpdateTimestamp;
    }
  }
  if (latestMessageTimestamp !== null &&
      puzzle.chatModifiedTimestamp.isBefore(latestMessageTimestamp)) {
    dirty = true;
    puzzle.chatModifiedTimestamp = latestMessageTimestamp;
  }
  if (sheetMetadata !== null &&
      puzzle.sheetModifiedTimestamp.isBefore(sheetMetadata.modifiedTimestamp)) {
    dirty = true;
    puzzle.sheetModifiedTimestamp = sheetMetadata.modifiedTimestamp;
  }
  if (drawingMetadata !== null &&
      puzzle.drawingModifiedTimestamp.isBefore(drawingMetadata.modifiedTimestamp)) {
    dirty = true;
    puzzle.drawingModifiedTimestamp = drawingMetadata.modifiedTimestamp;
  }

  const huddleParticipantUserIds = await huddleParticipantUserIdsPromise;
  if (huddleParticipantUserIds.length === 0 && (
      puzzle.huddleThreadMessageTs && puzzle.huddleThreadMessageTs.length > 0)) {
    const huddleThreadMessageMoment = moment.utc(moment.unix(Number(puzzle.huddleThreadMessageTs)));
    const huddleThreadMessageAgeSeconds = now.diff(huddleThreadMessageMoment, "seconds");
    if (huddleThreadMessageAgeSeconds > 30) {
      dirty = true;
      puzzle.huddleThreadMessageTs = "";
    }
  }
  const syncPuzzleHuddleUsersPromise = users.syncPuzzleHuddleUsers(
    id, huddleParticipantUserIds, client);

  const updateStatusMessagePromise = updateStatusMessage(puzzle);
  const bookmarksPromise = syncBookmarks(puzzle);

  const affectedUserIds = await refreshUsersPromise;

  if (dirty) {
    await client.query(`
      UPDATE puzzles
      SET
        channel_topic = $2,
        channel_topic_modified_timestamp = $3,
        chat_modified_timestamp = $4,
        sheet_modified_timestamp = $5,
        drawing_modified_timestamp = $6,
        huddle_thread_message_ts = $7
      WHERE id = $1`,
      [
        id,
        puzzle.channelTopic,
        puzzle.channelTopicModifiedTimestamp.format(),
        puzzle.chatModifiedTimestamp.format(),
        puzzle.sheetModifiedTimestamp.format(),
        puzzle.drawingModifiedTimestamp.format(),
        puzzle.huddleThreadMessageTs,
      ]);
  }

  await updateStatusMessagePromise;
  await bookmarksPromise;
  for (const p of renameDocPromises) {
    await p;
  }
  await syncPuzzleHuddleUsersPromise;

  for (const userId of affectedUserIds) {
    await taskQueue.scheduleTask(
      "publish_home",
      { userId },
      client,
      false,  /* notify */
    );
  }
  if (affectedUserIds.length > 0) {
    refreshEventUsers(id, client);
    await taskQueue.notifyQueue();
  }
}

taskQueue.registerHandler("refresh_puzzle", async (client, payload) => {
  const id: string = payload.id;
  await refreshPuzzle(id, client);
});

export async function getParticipantUserIds(id: string): Promise<Array<string>> {
  const channelHistoryResult = await app.client.conversations.history({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
    limit: 200,
  }) as ConversationsHistoryResult;
  const participantUserIds: Set<string> = new Set();
  for (const message of channelHistoryResult.messages) {
    participantUserIds.add(message.user);
  }
  return Array.from(participantUserIds);
}
