import moment = require("moment");
import { Client, PoolClient } from "pg";

import { SNSClient } from "@aws-sdk/client-sns-node/SNSClient";
import { PublishCommand } from "@aws-sdk/client-sns-node/commands/PublishCommand";

import { app } from "./app";
import * as db from "./db";
import { ChatPostMessageResult } from "./slack_results";

const handlers: { [key: string]: (client: PoolClient, payload: any) => Promise<void>} = {};
export function registerHandler(
  taskType: string,
  handler: (client: PoolClient, payload: any) => Promise<void>,
) {
  handlers[taskType] = handler;
}

export async function notifyQueue() {
  if (process.env.AWS_NOTIFY_TASK_QUEUE_SNS_TOPIC_ARN) {
    const snsClient = new SNSClient({ region: process.env.AWS_REGION });
    const publishCommand = new PublishCommand({
      Message: "NOTIFY",
      TopicArn: process.env.AWS_NOTIFY_TASK_QUEUE_SNS_TOPIC_ARN,
    });
    await snsClient.send(publishCommand);
  }
}

export async function scheduleTask(taskType: string, payload: any, client?: PoolClient, notify: boolean = true) {
  const existsResult = await db.query(`
    SELECT EXISTS (
      SELECT 1
      FROM task_queue
      WHERE
        task_type = $1 AND
        payload = $2
    )
  `, [taskType, payload], client);
  if (existsResult.rowCount > 0 && existsResult.rows[0].exists) {
    return;
  }
  await db.query(
    "INSERT INTO task_queue (task_type, payload) VALUES ($1, $2)",
    [taskType, payload],
    client);
  if (notify) {
    await notifyQueue();
  }
}

let processTaskQueueRunning = false;

const maxProcessTaskQueueExecutionTime = moment.duration(5, "seconds");

export async function processTaskQueue() {
  if (processTaskQueueRunning) {
    return;
  }
  processTaskQueueRunning = true;
  const startTime = moment();
  const client = await db.connect();
  try {
    while (moment().diff(startTime) < maxProcessTaskQueueExecutionTime.asMilliseconds()) {
      await client.query("BEGIN");
      const result = await client.query(
        `
        DELETE FROM task_queue
        WHERE id = (
          SELECT id FROM task_queue
          WHERE error IS NULL
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, task_type, payload
        `);
      if (result.rowCount === 0) {
        processTaskQueueRunning = false;
        await client.query("ROLLBACK");
        return;
      }
      const task = result.rows[0];
      const handler = handlers[task.task_type];
      if (handler === undefined) {
        throw `Unhandled task_type ${task.task_type}`;
      }
      try {
        await handler(client, task.payload);
      } catch (e) {
        console.log("Task queue handler failed", e);
        await client.query(
          "INSERT INTO task_queue (task_type, payload, error) VALUES ($1, $2, $3)",
          [task.task_type, task.payload, JSON.stringify(e)]);
        if (process.env.SLACK_ERROR_CHANNEL_NAME) {
          const postMessageResult = await app.client.chat.postMessage({
            token: process.env.SLACK_USER_TOKEN,
            channel: `#${process.env.SLACK_ERROR_CHANNEL_NAME}`,
            text: `ERROR! <${process.env.WEB_SERVER_URL + "taskqueue"}|Task queue> handler failed for ${task.task_type} ${JSON.stringify(task.payload)}.`,
          }) as ChatPostMessageResult;
          await app.client.chat.postMessage({
            token: process.env.SLACK_USER_TOKEN,
            channel: `#${process.env.SLACK_ERROR_CHANNEL_NAME}`,
            "thread_ts": postMessageResult.ts,
            text: JSON.stringify(e),
          });
        }
      }
      await client.query("COMMIT");
    }
  } catch (e) {
    console.error("Failed to process task queue", e);
    processTaskQueueRunning = false;
    await client.query("ROLLBACK");
    throw e;
  } finally {
    processTaskQueueRunning = false;
    client.release();
  }
  await notifyQueue();
  await db.query("NOTIFY task_queue_add");
}

let listenClient: Client & PoolClient | null = null;

export async function startListening() {
  if (listenClient) {
    await listenClient.end();
    listenClient = null;
  }
  listenClient = await db.connect();
  listenClient.query("LISTEN task_queue_add");
  listenClient.on("notification", async (data) => {
    processTaskQueue();
  });
  listenClient.on("error", async (e) => {
    console.log("Notification listener DB client error", e);
    await listenClient.end();
    listenClient = null;
    await startListening();
  });
  processTaskQueue();
}

export interface Task {
  id: number;
  "task_type": string;
  payload: any;
  error: any;
}

export async function list(): Promise<Array<Task>> {
  const result = await db.query("SELECT id, task_type, payload, error FROM task_queue");
  return result.rows;
}

export async function clearTaskError(id: string) {
  await db.query("UPDATE task_queue SET error = NULL WHERE id = $1", [id]);
}

export async function deleteTask(id: string) {
  await db.query("DELETE FROM task_queue WHERE id = $1", [id]);
}