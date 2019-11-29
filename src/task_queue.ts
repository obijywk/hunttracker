import { PoolClient } from "pg";

import * as db from "./db";

const handlers: { [key: string]: (client: PoolClient, payload: any) => Promise<void>} = {};
export function registerHandler(
  taskType: string,
  handler: (client: PoolClient, payload: any) => Promise<void>,
) {
  handlers[taskType] = handler;
}

export async function scheduleTask(taskType: string, payload: any, client?: PoolClient) {
  await db.query(
    "INSERT INTO task_queue (task_type, payload) VALUES ($1, $2)",
    [taskType, payload],
    client);
}

let processTaskQueueRunning = false;

export async function processTaskQueue() {
  processTaskQueueRunning = true;
  const client = await db.connect();
  try {
    while (true) {
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
}

export async function init() {
  const listenClient = await db.connect();
  const query = listenClient.query("LISTEN task_queue_add");
  listenClient.on("notification", async (data) => {
    if (!processTaskQueueRunning) {
      processTaskQueue();
    }
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