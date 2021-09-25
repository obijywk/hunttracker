import { app } from "./app";
import * as db from "./db";
import * as taskQueue from "./task_queue";
import * as users from "./users";

require("./events");
require("./refresh_polling");
require("./web");

(async () => {
  const port = parseInt(process.env.PORT) || 3000;
  if (await db.applySchemaIfDatabaseNotInitialized()) {
    await users.refreshAll();
  }
  await app.start(port);
  await taskQueue.startListening();
  console.log(`Listening on port ${port}.`);
})();
