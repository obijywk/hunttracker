import moment = require("moment");
import * as diacritics from "diacritics";
import { PoolClient } from "pg";
import { ButtonAction, MessageEvent } from "@slack/bolt";
import { ErrorCode } from "@slack/web-api";

import { app } from "./app";
import * as db from "./db";
import * as googleDrive from "./google_drive";
import {
  ChannelsCreateResult,
  ChannelsHistoryResult,
  ChannelsInfoResult,
  ChatPostMessageResult,
  ConversationsListResult,
} from "./slack_results";
import { getViewStateValues } from "./slack_util";
import * as tags from "./tags";
import * as taskQueue from "./task_queue";
import * as users from "./users";

export interface Puzzle {
  id: string;
  name: string;
  url: string;
  complete: boolean;
  answer: string;
  channelName: string;
  channelTopic: string;
  users: Array<users.User>;
  tags: Array<tags.Tag>;
  sheetUrl: string;
  chatModifiedTimestamp: moment.Moment;
  sheetModifiedTimestamp: moment.Moment;
  manualPokeTimestamp: moment.Moment;
  statusMessageTs?: string;
}

export function getIdleDuration(puzzle: Puzzle): moment.Duration {
  if (puzzle.complete) {
    return moment.duration(0);
  }
  const latestTimestamp = moment.max(
    puzzle.chatModifiedTimestamp,
    puzzle.sheetModifiedTimestamp,
    puzzle.manualPokeTimestamp,
  );
  return moment.duration(moment().diff(latestTimestamp));
}

export function buildIdleStatus(puzzle: Puzzle): string {
  const idleDuration = getIdleDuration(puzzle);
  if (idleDuration.asMinutes() >= Number(process.env.MINIMUM_IDLE_MINUTES)) {
    return `:stopwatch: _idle for ${idleDuration.humanize()}_`;
  }
  return "";
}

interface ReadFromDatabaseOptions {
  id?: string;
  client?: PoolClient;
  excludeComplete?: boolean;
  withTag?: string;
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
      sheet_url,
      (
        SELECT json_agg(row_to_json(users))
        FROM users
        JOIN puzzle_user ON puzzle_user.user_id = users.id
        WHERE puzzle_user.puzzle_id = puzzles.id
      ) users,
      (
        SELECT json_agg(row_to_json(tags) ORDER BY name)
        FROM tags
        JOIN puzzle_tag ON puzzle_tag.tag_id = tags.id
        WHERE puzzle_tag.puzzle_id = puzzles.id
      ) tags,
      chat_modified_timestamp,
      sheet_modified_timestamp,
      manual_poke_timestamp,
      status_message_ts
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
      users: row.users || [],
      tags: row.tags || [],
      sheetUrl: row.sheet_url,
      chatModifiedTimestamp: moment(row.chat_modified_timestamp),
      sheetModifiedTimestamp: moment(row.sheet_modified_timestamp),
      manualPokeTimestamp: moment(row.manual_poke_timestamp),
      statusMessageTs: row.status_message_ts,
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
  excludeComplete?: boolean;
  withTag?: string;
}

export async function list(options: ListOptions = {}): Promise<Array<Puzzle>> {
  return await readFromDatabase({
    excludeComplete: options.excludeComplete,
    withTag: options.withTag,
  });
}

export function buildPuzzleNameMrkdwn(puzzle: Puzzle) {
  if (puzzle.url) {
    return `<${puzzle.url}|${puzzle.name}>`;
  } else {
    return puzzle.name;
  }
}

function normalizeStringForChannelName(s: string): string {
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
  return channelName;
}

function buildTopicBlock(puzzle: Puzzle) {
  let topic = puzzle.channelTopic;
  if (!topic) {
    topic = "_Topic not set. Consider adding one for the benefit of your teammates._";
  }
  return {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      text: ":mag_right: " + topic,
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
  const actionButtons = [tags.buildUpdateTagsButton(puzzle.id)];

  const linksBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `${puzzle.complete ? ":notebook:" : ":book:"} ${buildPuzzleNameMrkdwn(puzzle)}`,
    },
    accessory: {
      type: "button",
      text: {
        type: "plain_text",
        text: ":bar_chart: Spreadsheet",
      },
      "action_id": "puzzle_open_spreadsheet",
      url: puzzle.sheetUrl,
    },
  };

  const blocks: Array<any> = [
    linksBlock,
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

app.action("puzzle_open_spreadsheet", async ({ack}) => {
  ack();
});

app.action("puzzle_manual_poke", async ({ack, payload}) => {
  const buttonAction = payload as ButtonAction;
  const id = buttonAction.value;
  ack();
  await db.query(`
    UPDATE puzzles
    SET
      manual_poke_timestamp = NOW()
    WHERE id = $1`,
    [id]);
  await taskQueue.scheduleTask("refresh_puzzle", {id});
});

app.action("puzzle_update_topic", async ({ ack, body, payload }) => {
  ack();
  const id = (payload as ButtonAction).value;
  const puzzlePromise = get(id);

  const channelInfoResult = await app.client.conversations.info({
    token: process.env.SLACK_BOT_TOKEN,
    channel: id,
  }) as ChannelsInfoResult;

  const puzzle = await puzzlePromise;

  let topic = "";
  if (channelInfoResult.channel.topic) {
    topic = channelInfoResult.channel.topic.value;
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
        text: "Submit",
      },
    },
  });
});

app.view("puzzle_update_topic_view", async ({ack, view, body}) => {
  ack();

  const id = JSON.parse(body.view.private_metadata)["id"] as string;
  const values = getViewStateValues(view);
  const topic: string = values["puzzle_topic_input"];

  await app.client.channels.setTopic({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
    topic,
  });
  await taskQueue.scheduleTask("refresh_puzzle", {id});
});

app.action("puzzle_record_confirmed_answer", async ({ ack, body, payload }) => {
  ack();
  const id = (payload as ButtonAction).value;
  const puzzle = await get(id);

  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "puzzle_record_confirmed_answer_view",
      "private_metadata": JSON.stringify({id}),
      title: {
        type: "plain_text",
        text: "Record Confirmed Answer",
      },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Enter the *HQ-confirmed* answer for the puzzle *${buildPuzzleNameMrkdwn(puzzle)}* below.` +
              " Prefer to use only capital letters and spaces, unless there's a good reason not to.",
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
            type: "static_select",
            "initial_option": {
              text: {
                type: "plain_text",
                text: "Mark puzzle solved",
              },
              value: "true",
            },
            options: [
              {
                text: {
                  type: "plain_text",
                  text: "Mark puzzle solved",
                },
                value: "true",
              },
              {
                text: {
                  type: "plain_text",
                  text: "Keep puzzle unsolved (this is unusual)",
                },
                value: "false",
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
});

app.view("puzzle_record_confirmed_answer_view", async ({ack, view, body}) => {
  ack();

  const id = JSON.parse(body.view.private_metadata)["id"] as string;
  const values = getViewStateValues(view);
  const answer: string = values["puzzle_answer_input"];
  const complete: boolean = values["puzzle_solved_input"] === "true";

  await db.query(
    "UPDATE puzzles SET answer = $2, complete = $3 WHERE id = $1",
    [id, answer, complete]);
  await taskQueue.scheduleTask("refresh_puzzle", {id});

  if (complete && process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
    const puzzle = await get(id);
    let text;
    if (answer) {
      text = `${buildPuzzleNameMrkdwn(puzzle)} solved with answer *${puzzle.answer}*.`;
    } else {
      text = `${buildPuzzleNameMrkdwn(puzzle)} completed.`;
    }
    await app.client.chat.postMessage({
      token: process.env.SLACK_USER_TOKEN,
      channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
      text,
    });
  }
});

app.action("puzzle_archive_channel", async ({ack, payload}) => {
  ack();
  const buttonAction = payload as ButtonAction;
  const id = buttonAction.value;
  await app.client.channels.archive({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
  });
});

async function updateStatusMessage(puzzle: Puzzle) {
  const postStatusMessageResult = await app.client.chat.update({
    token: process.env.SLACK_BOT_TOKEN,
    channel: puzzle.id,
    text: "",
    ts: puzzle.statusMessageTs,
    blocks: buildStatusMessageBlocks(puzzle),
  }) as ChatPostMessageResult;
}

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
      chat_modified_timestamp,
      sheet_modified_timestamp,
      manual_poke_timestamp,
      status_message_ts
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      puzzle.id,
      puzzle.name,
      puzzle.url,
      puzzle.complete,
      puzzle.answer,
      puzzle.channelName,
      puzzle.channelTopic,
      puzzle.sheetUrl,
      puzzle.chatModifiedTimestamp.format(),
      puzzle.sheetModifiedTimestamp.format(),
      puzzle.manualPokeTimestamp.format(),
      puzzle.statusMessageTs || "",
    ]);
}

async function getLatestMessageTimestamp(id: string): Promise<moment.Moment | null> {
  const channelHistoryResult = await app.client.channels.history({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
    count: 100,
  }) as ChannelsHistoryResult;
  for (const message of channelHistoryResult.messages) {
    if (message.type === "message" && message.subtype === "channel_leave") {
      continue;
    }
    return moment.unix(Number(message.ts)).utc();
  }
  return null;
}

export async function create(
  name: string,
  url: string,
  selectedTagIds: Array<number>,
  newTagNames: Array<string>,
): Promise<string | null> {
  const channelName = buildChannelName(name);
  const existsResult = await db.query(`
    SELECT EXISTS (
      SELECT 1
      FROM puzzles
      WHERE
        name = $1 OR
        channel_name = $2 OR
        (char_length(url) > 0 AND url = $3)
    )
  `, [name, channelName, url]);
  if (existsResult.rowCount > 0 && existsResult.rows[0].exists) {
    return "This puzzle has already been registered.";
  }
  await taskQueue.scheduleTask("create_puzzle", {
    name,
    url,
    selectedTagIds,
    newTagNames,
  });
  return null;
}

export async function refreshAll() {
  const result = await db.query("SELECT id FROM puzzles");
  for (const row of result.rows) {
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: row.id,
    });
  }
}

export async function refreshStale() {
  const puzzles = await list();
  for (const puzzle of puzzles) {
    if (puzzle.complete) {
      continue;
    }
    if (getIdleDuration(puzzle).asMinutes() < Number(process.env.MINIMUM_IDLE_MINUTES)) {
      continue;
    }
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: puzzle.id,
    });
  }
}

async function findChannelIdForChannelName(channelName: string): Promise<string | null> {
  let cursor = undefined;
  do {
    const listConversationsResult = await app.client.conversations.list({
      token: process.env.SLACK_USER_TOKEN,
      cursor,
    }) as ConversationsListResult;
    for (const channel of listConversationsResult.channels) {
      if (channel.name === channelName) {
        return channel.id;
      }
    }
    cursor = listConversationsResult.response_metadata.next_cursor;
  } while (cursor);
  return null;
}

taskQueue.registerHandler("create_puzzle", async (client, payload) => {
  const name = payload.name;
  const url = payload.url;
  const selectedTagIds: Array<number> = payload.selectedTagIds;
  const newTagNames: Array<string> = payload.newTagNames;

  const sheetUrl = await googleDrive.copySheet(process.env.PUZZLE_SHEET_TEMPLATE_URL, name);

  const channelName = buildChannelName(name);
  let id: string = undefined;
  try {
    const createChannelResult = await app.client.channels.create({
      token: process.env.SLACK_USER_TOKEN,
      name: channelName,
    }) as ChannelsCreateResult;
    id = createChannelResult.channel.id;
  } catch (e) {
    if (e.code === ErrorCode.PlatformError && e.data.error === "name_taken") {
      // Maybe something went wrong with a previous attempt to create this
      // puzzle? Try to adopt an existing channel with this name, instead of
      // creating a new one.
      id = await findChannelIdForChannelName(channelName);
      if (!id) {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const now = moment();
  let puzzle: Puzzle = {
    id,
    name,
    url,
    complete: false,
    answer: "",
    channelName,
    channelTopic: "",
    users: [],
    tags: [],
    sheetUrl,
    chatModifiedTimestamp: now,
    sheetModifiedTimestamp: now,
    manualPokeTimestamp: now,
  };

  const postStatusMessageResult = await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: `#${puzzle.channelName}`,
    text: "",
    blocks: buildStatusMessageBlocks(puzzle),
  }) as ChatPostMessageResult;
  puzzle.statusMessageTs = postStatusMessageResult.ts;

  const pinPromise = app.client.pins.add({
    token: process.env.SLACK_BOT_TOKEN,
    channel: puzzle.id,
    timestamp: puzzle.statusMessageTs,
  });

  await insert(puzzle, client);
  await tags.updateTags(id, selectedTagIds, newTagNames, client);
  puzzle = await get(id, client);

  await updateStatusMessage(puzzle);

  await pinPromise;

  if (process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
    await app.client.chat.postMessage({
      token: process.env.SLACK_USER_TOKEN,
      channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
      text: `<#${id}> created for ${buildPuzzleNameMrkdwn(puzzle)}.`,
    });
  }
});

taskQueue.registerHandler("refresh_puzzle", async (client, payload) => {
  const id: string = payload.id;

  const refreshUsersPromise = users.refreshPuzzleUsers(id, client);

  const latestMessageTimestampPromise = getLatestMessageTimestamp(id);
  const channelInfoResultPromise = app.client.conversations.info({
    token: process.env.SLACK_BOT_TOKEN,
    channel: id,
  }) as Promise<ChannelsInfoResult>;

  const puzzle = await get(id, client);

  const sheetModifiedTimestamp = await googleDrive.getSheetModifiedTimestamp(puzzle.sheetUrl);
  const latestMessageTimestamp = await latestMessageTimestampPromise;
  const channelInfoResult = await channelInfoResultPromise;

  let dirty = false;
  if (channelInfoResult.channel.topic) {
    const topicUpdateTimestamp = moment.unix(channelInfoResult.channel.topic.last_set).utc();
    if (puzzle.chatModifiedTimestamp.isBefore(topicUpdateTimestamp)) {
      dirty = true;
      puzzle.chatModifiedTimestamp = topicUpdateTimestamp;
    }
    if (puzzle.channelTopic !== channelInfoResult.channel.topic.value) {
      dirty = true;
      puzzle.channelTopic = channelInfoResult.channel.topic.value;
      if (process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
        app.client.chat.postMessage({
          token: process.env.SLACK_USER_TOKEN,
          channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
          text: `<#${puzzle.id}> topic updated: ${puzzle.channelTopic}`,
        });
      }
    }
  }
  if (latestMessageTimestamp !== null &&
      puzzle.chatModifiedTimestamp.isBefore(latestMessageTimestamp)) {
    dirty = true;
    puzzle.chatModifiedTimestamp = latestMessageTimestamp;
  }
  if (puzzle.sheetModifiedTimestamp.isBefore(sheetModifiedTimestamp)) {
    dirty = true;
    puzzle.sheetModifiedTimestamp = sheetModifiedTimestamp;
  }

  const updateStatusMessagePromise = updateStatusMessage(puzzle);

  if (dirty) {
    await client.query(`
      UPDATE puzzles
      SET
        channel_topic = $2,
        chat_modified_timestamp = $3,
        sheet_modified_timestamp = $4
      WHERE id = $1`,
      [id, puzzle.channelTopic, puzzle.chatModifiedTimestamp, puzzle.sheetModifiedTimestamp]);
  }

  await updateStatusMessagePromise;

  const affectedUserIds = await refreshUsersPromise;
  for (const userId of affectedUserIds) {
    await taskQueue.scheduleTask("publish_home", {
      userId,
    }, client);
  }
});

const refreshPuzzleSubtypes = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
]);

app.event("message", async ({ event }) => {
  const messageEvent = event as unknown as MessageEvent;
  if (refreshPuzzleSubtypes.has(messageEvent.subtype)) {
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: messageEvent.channel,
    });
  }
});