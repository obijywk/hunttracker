import serverlessHttp from "serverless-http";

import { receiver } from "./app";
import * as db from "./db";
import * as refreshPolling from "./refresh_polling";
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

export const refresh = async (
  event: AWSLambda.APIGatewayEvent,
  context: AWSLambda.APIGatewayEventRequestContext
) => {
  await refreshPolling.refresh();
};