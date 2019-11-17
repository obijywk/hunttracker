import { app } from "./app";
import * as taskQueue from "./task_queue";

require("./refresh_polling");
require("./web");

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  await taskQueue.init();
  console.log(`Listening on port ${port}.`);
})();
