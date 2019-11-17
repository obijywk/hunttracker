import moment = require("moment");

import * as solves from "./solves";
import * as users from "./users";

if (process.env.REFRESH_POLLING_MINUTES) {
  setInterval(async () => {
    await solves.refreshStale();
    await users.refreshAll();
  }, moment.duration(Number(process.env.REFRESH_POLLING_MINUTES), "minutes").asMilliseconds());
}