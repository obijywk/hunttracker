import moment = require("moment");

import * as solves from "./solves";
import * as users from "./users";

export async function refresh() {
  await solves.refreshStale();
  await users.refreshAll();
}

if (process.env.REFRESH_POLLING_MINUTES) {
  setInterval(
    refresh,
    moment.duration(Number(process.env.REFRESH_POLLING_MINUTES), "minutes").asMilliseconds());
}