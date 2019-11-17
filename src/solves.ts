import moment = require("moment");
import { PoolClient } from "pg";
import { ButtonAction, MessageEvent } from "@slack/bolt";
import { ErrorCode } from "@slack/web-api";

import { app } from "./app";
import * as db from "./db";
import * as googleDrive from "./google_drive";
import * as puzzles from "./puzzles";
import {
  ChannelsCreateResult,
  ChannelsHistoryResult,
  ChannelsInfoResult,
  ChatPostMessageResult,
  ConversationsListResult,
  ConversationsMembersResult
} from "./slack_results";
import { getViewStateValues } from "./slack_util";
import * as taskQueue from "./task_queue";
import * as users from "./users";

export interface Solve {
  id: string;
  puzzle: puzzles.Puzzle;
  instanceName: string;
  channelName: string;
  channelTopic: string;
  users: Array<users.User>;
  sheetUrl: string;
  archived: boolean;
  chatModifiedTimestamp: moment.Moment;
  sheetModifiedTimestamp: moment.Moment;
  manualPokeTimestamp: moment.Moment;
  statusMessageTs?: string;
}

export function getIdleDuration(solve: Solve): moment.Duration {
  if (solve.puzzle.solved) {
    return moment.duration(0);
  }
  const latestTimestamp = moment.max(
    solve.chatModifiedTimestamp,
    solve.sheetModifiedTimestamp,
    solve.manualPokeTimestamp
  );
  return moment.duration(moment().diff(latestTimestamp));
}

export function buildIdleStatus(solve: Solve): string {
  const idleDuration = getIdleDuration(solve);
  if (idleDuration.asMinutes() >= Number(process.env.MINIMUM_IDLE_MINUTES)) {
    return `:stopwatch: _idle for ${idleDuration.humanize()}_`;
  }
  return "";
}

async function readFromDatabase(id?: string, client?: PoolClient): Promise<Array<Solve>> {
  let query = `
    SELECT
      id,
      (
        SELECT row_to_json(puzzles)
        FROM puzzles
        WHERE puzzles.id = solves.puzzle_id
      ) puzzle,
      instance_name,
      channel_name,
      channel_topic,
      sheet_url,
      (
        SELECT json_agg(row_to_json(users))
        FROM users
        JOIN solve_user ON solve_user.user_id = users.id
        WHERE solve_user.solve_id = solves.id
      ) users,
      archived,
      chat_modified_timestamp,
      sheet_modified_timestamp,
      manual_poke_timestamp,
      status_message_ts
    FROM solves`;
  const params = [];
  if (id) {
    query += "\nWHERE id = $1";
    params.push(id);
  }
  const result = await db.query(query, params, client);
  const solves: Array<Solve> = [];
  for (const row of result.rows) {
    solves.push({
      id: row.id,
      puzzle: row.puzzle,
      instanceName: row.instance_name,
      channelName: row.channel_name,
      channelTopic: row.channel_topic,
      users: row.users,
      sheetUrl: row.sheet_url,
      archived: row.archived,
      chatModifiedTimestamp: moment(row.chat_modified_timestamp),
      sheetModifiedTimestamp: moment(row.sheet_modified_timestamp),
      manualPokeTimestamp: moment(row.manual_poke_timestamp),
      statusMessageTs: row.status_message_ts,
    });
  }
  return solves;
}

export async function get(id: string, client?: PoolClient): Promise<Solve> {
  const solves = await readFromDatabase(id, client);
  if (solves.length !== 1) {
    throw `Unexpected number of solves for get: ${solves.length}`;
  }
  return solves[0];
}

export async function list(): Promise<Array<Solve>> {
  return await readFromDatabase();
}

function normalizeStringForChannelName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function buildChannelName(puzzleName: string, instanceName?: string): string {
  let channelName = process.env.HUNT_PREFIX || "";
  if (channelName) {
    channelName += "-";
  }
  if (instanceName) {
    channelName += normalizeStringForChannelName(instanceName) + "-";
  }
  channelName += normalizeStringForChannelName(puzzleName);
  return channelName;
}

function buildStatusMessageBlocks(solve: Solve): any {
  const idleStatus = buildIdleStatus(solve);
  let manualPokeAccessory = undefined;
  if (idleStatus) {
    manualPokeAccessory = {
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": ":stopwatch: Still solving!",
      },
      "action_id": "solve_manual_poke",
      "value": solve.id,
    };
  }

  let text = `*${solve.puzzle.name}*`;
  if (idleStatus) {
    text += `\n${idleStatus}`;
  }
  text += `\n:thinking_face: <${solve.puzzle.url}|Open puzzle>`;
  text += `   :nerd_face: <${solve.sheetUrl}|Open spreadsheet>`;
  if (!solve.channelTopic) {
    text += "\nHey! Consider *adding a channel topic* describing this puzzle for the benfit of your teammates.";
  }

  const actionButtons = [];
  if (!solve.puzzle.answer) {
    actionButtons.push({
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": ":pencil: Record Confirmed Answer"
      },
      "action_id": "solve_record_confirmed_answer",
      "value": solve.id,
    });
  } else {
    actionButtons.push({
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": `:pencil: Answer: ${solve.puzzle.answer}`,
      },
      "action_id": "solve_record_confirmed_answer",
      "value": solve.id,
    });
  }
  if (solve.puzzle.solved) {
    actionButtons.push({
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": ":file_cabinet: Archive Channel",
      },
      "action_id": "solve_archive_channel",
      "value": solve.id,
    });
  }

  return [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        text,
      },
      "accessory": manualPokeAccessory,
    },
    {
      "type": "actions",
      "elements": actionButtons,
    },
  ];
}

app.action("solve_manual_poke", async ({ack, payload}) => {
  const buttonAction = payload as ButtonAction;
  const id = buttonAction.value;
  ack();
  await db.query(`
    UPDATE solves
    SET
      manual_poke_timestamp = NOW()
    WHERE id = $1`,
    [id]);
  await taskQueue.scheduleTask("refresh_solve", {id});
});

app.action("solve_record_confirmed_answer", async ({ ack, body, payload }) => {
  ack();
  const id = (payload as ButtonAction).value;
  const solve = await get(id);

  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "solve_record_confirmed_answer_view",
      "private_metadata": JSON.stringify({puzzleId: solve.puzzle.id}),
      title: {
        type: "plain_text",
        text: "Record Confirmed Answer"
      },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Enter the *HQ-confirmed* answer for the puzzle *${solve.puzzle.name}* below.` +
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
              text: "Enter answer here",
            },
            "initial_value": solve.puzzle.answer || "",
          }
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
        }
      ],
      submit: {
        type: "plain_text",
        text: "Submit",
      },
    }
  });
});

app.view("solve_record_confirmed_answer_view", async ({ack, view, body}) => {
  ack();

  const puzzleId = JSON.parse(body.view.private_metadata)["puzzleId"] as number;
  const values = getViewStateValues(view);
  const answer: string = values["puzzle_answer_input"];
  const solved: boolean = values["puzzle_solved_input"] === "true";

  await puzzles.update(puzzleId, answer, solved);

  const solveIdResults = await db.query(
    "SELECT id FROM solves WHERE puzzle_id = $1", [puzzleId]);
  for (const row of solveIdResults.rows) {
    await taskQueue.scheduleTask("refresh_solve", {
      id: row.id,
    });
  }

  if (solved && process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
    const puzzle = await puzzles.get(puzzleId);
    await app.client.chat.postMessage({
      token: process.env.SLACK_USER_TOKEN,
      channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
      text: `<${puzzle.url}|${puzzle.name}> was solved with answer *${puzzle.answer}*.`,
    });
  }
});

async function updateStatusMessage(solve: Solve) {
  const postStatusMessageResult = await app.client.chat.update({
    token: process.env.SLACK_BOT_TOKEN,
    channel: solve.id,
    text: "",
    ts: solve.statusMessageTs,
    blocks: buildStatusMessageBlocks(solve)
  }) as ChatPostMessageResult;
}

async function insert(solve: Solve, client: PoolClient) {
  await client.query(
    `INSERT INTO solves (
      id,
      puzzle_id,
      instance_name,
      channel_name,
      channel_topic,
      sheet_url,
      chat_modified_timestamp,
      sheet_modified_timestamp,
      manual_poke_timestamp,
      status_message_ts
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      solve.id,
      solve.puzzle.id,
      solve.instanceName,
      solve.channelName,
      solve.channelTopic,
      solve.sheetUrl,
      solve.chatModifiedTimestamp.format(),
      solve.sheetModifiedTimestamp.format(),
      solve.manualPokeTimestamp.format(),
      solve.statusMessageTs || ""
    ]);
}

async function getLatestMessageTimestamp(id: string): Promise<moment.Moment | null> {
  const channelHistoryResult = await app.client.channels.history({
    token: process.env.SLACK_USER_TOKEN,
    channel: id,
    count: 100
  }) as ChannelsHistoryResult;
  for (const message of channelHistoryResult.messages) {
    if (message.type === "message" && message.subtype === "channel_leave") {
      continue;
    }
    return moment.unix(Number(message.ts)).utc();
  }
  return null;
}

async function refreshUsers(id: string, client: PoolClient) {
  const dbUsersResultPromise = client.query(
    "SELECT user_id FROM solve_user WHERE solve_id = $1", [id]);

  const channelUsers: Set<string> = new Set();
  let cursor = undefined;
  do {
    const conversationMembersResult = await app.client.conversations.members({
      token: process.env.SLACK_USER_TOKEN,
      channel: id
    }) as ConversationsMembersResult;
    for (const userId of conversationMembersResult.members) {
      channelUsers.add(userId);
    }
    cursor = conversationMembersResult.response_metadata.next_cursor;
  } while (cursor);

  const dbUsersResult = await dbUsersResultPromise;
  const dbUsers: Set<string> = new Set();
  for (const row of dbUsersResult.rows) {
    dbUsers.add(row.user_id);
  }

  const promises = [];
  for (const channelUser of channelUsers) {
    if (!dbUsers.has(channelUser)) {
      promises.push(
        client.query(`
          INSERT INTO solve_user (solve_id, user_id)
          SELECT $1, id FROM users
          WHERE id = $2`,
          [id, channelUser]));
    }
  }
  for (const dbUser of dbUsers) {
    if (!channelUsers.has(dbUser)) {
      promises.push(
        client.query(
          "DELETE FROM solve_user WHERE solve_id = $1 AND user_id = $2",
          [id, dbUser]));
    }
  }
  await Promise.all(promises);
}

export async function create(puzzleId: number, instanceName?: string) {
  await taskQueue.scheduleTask("create_solve", {
    puzzleId,
    instanceName
  });
}

export async function refreshAll() {
  const result = await db.query("SELECT id FROM solves WHERE archived = FALSE");
  for (const row of result.rows) {
    await taskQueue.scheduleTask("refresh_solve", {
      id: row.id
    });
  }
}

export async function refreshStale() {
  const solves = await list();
  for (const solve of solves) {
    if (solve.archived) {
      continue;
    }
    if (getIdleDuration(solve).asMinutes() < Number(process.env.MINIMUM_IDLE_MINUTES)) {
      continue;
    }
    await taskQueue.scheduleTask("refresh_solve", {
      id: solve.id
    });
  }
}

async function findChannelIdForChannelName(channelName: string): Promise<string | null> {
  let cursor = undefined;
  do {
    const listConversationsResult = await app.client.conversations.list({
      token: process.env.SLACK_USER_TOKEN,
      cursor
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

taskQueue.registerHandler("create_solve", async (client, payload) => {
  const puzzle = await puzzles.get(payload.puzzleId, client);

  const sheetUrlPromise = googleDrive.copySheet(process.env.PUZZLE_SHEET_TEMPLATE_URL, puzzle.name);

  const channelName = buildChannelName(puzzle.name, payload.instanceName);
  let id: string = undefined;
  try {
    const createChannelResult = await app.client.channels.create({
      token: process.env.SLACK_USER_TOKEN,
      name: channelName
    }) as ChannelsCreateResult;
    id = createChannelResult.channel.id;
  } catch (e) {
    if (e.code === ErrorCode.PlatformError && e.data.error === "name_taken") {
      // Maybe something went wrong with a previous attempt to create this
      // solve? Try to adopt an existing channel with this name, instead of
      // creating a new one.
      id = await findChannelIdForChannelName(channelName);
      if (!id) {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const sheetUrl = await sheetUrlPromise;

  const now = moment();
  const solve: Solve = {
    id,
    puzzle,
    instanceName: payload.instanceName || "",
    channelName,
    channelTopic: "",
    users: [],
    sheetUrl,
    archived: false,
    chatModifiedTimestamp: now,
    sheetModifiedTimestamp: now,
    manualPokeTimestamp: now
  };

  const postStatusMessageResult = await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: `#${solve.channelName}`,
    text: "",
    blocks: buildStatusMessageBlocks(solve)
  }) as ChatPostMessageResult;
  solve.statusMessageTs = postStatusMessageResult.ts;

  await insert(solve, client);

  await app.client.pins.add({
    token: process.env.SLACK_BOT_TOKEN,
    channel: solve.id,
    timestamp: solve.statusMessageTs
  });

  if (process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
    await app.client.chat.postMessage({
      token: process.env.SLACK_USER_TOKEN,
      channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
      text: `<#${id}> created for <${puzzle.url}|${puzzle.name}>.`
    });
  }
});

taskQueue.registerHandler("refresh_solve", async (client, payload) => {
  const id: string = payload.id;

  const refreshUsersPromise = refreshUsers(id, client);

  const latestMessageTimestampPromise = getLatestMessageTimestamp(id);
  const channelInfoResultPromise = app.client.conversations.info({
    token: process.env.SLACK_BOT_TOKEN,
    channel: id
  }) as Promise<ChannelsInfoResult>;

  const solve = await get(id, client);

  const sheetModifiedTimestamp = await googleDrive.getSheetModifiedTimestamp(solve.sheetUrl);
  const latestMessageTimestamp = await latestMessageTimestampPromise;
  const channelInfoResult = await channelInfoResultPromise;

  let dirty = false;
  if (channelInfoResult.channel.topic) {
    const topicUpdateTimestamp = moment.unix(channelInfoResult.channel.topic.last_set).utc();
    if (solve.chatModifiedTimestamp.isBefore(topicUpdateTimestamp)) {
      dirty = true;
      solve.chatModifiedTimestamp = topicUpdateTimestamp;
    }
    if (solve.channelTopic !== channelInfoResult.channel.topic.value) {
      dirty = true;
      solve.channelTopic = channelInfoResult.channel.topic.value;
    }
  }
  if (latestMessageTimestamp !== null &&
      solve.chatModifiedTimestamp.isBefore(latestMessageTimestamp)) {
    dirty = true;
    solve.chatModifiedTimestamp = latestMessageTimestamp;
  }
  if (solve.sheetModifiedTimestamp.isBefore(sheetModifiedTimestamp)) {
    dirty = true;
    solve.sheetModifiedTimestamp = sheetModifiedTimestamp;
  }

  const updateStatusMessagePromise = updateStatusMessage(solve);

  if (dirty) {
    await client.query(`
      UPDATE solves
      SET
        channel_topic = $2,
        chat_modified_timestamp = $3,
        sheet_modified_timestamp = $4
      WHERE id = $1`,
      [id, solve.channelTopic, solve.chatModifiedTimestamp, solve.sheetModifiedTimestamp]);
  }

  await updateStatusMessagePromise;
  await refreshUsersPromise;
});

const refreshSolveSubtypes = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
]);

app.event("message", async ({ event }) => {
  const messageEvent = event as unknown as MessageEvent;
  if (refreshSolveSubtypes.has(messageEvent.subtype)) {
    await taskQueue.scheduleTask("refresh_solve", {
      id: messageEvent.channel,
    });
  }
});