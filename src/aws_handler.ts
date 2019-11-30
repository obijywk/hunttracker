import serverlessHttp from "serverless-http";

import { receiver } from "./app";
import * as db from "./db";
import * as taskQueue from "./task_queue";
import * as users from "./users";

require("./web");

(async () => {
  if (await db.applySchemaIfDatabaseNotInitialized()) {
    await users.refreshAll();
  }
  await taskQueue.init();
  console.log("AWS handler initialized.");
})();

export const handler = serverlessHttp(receiver.app);