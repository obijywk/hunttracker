import moment = require("moment");

import * as solves from "./solves";

export async function refresh() {
  await solves.refreshStale();
}

if (process.env.REFRESH_POLLING_MINUTES) {
  setInterval(
    refresh,
    moment.duration(Number(process.env.REFRESH_POLLING_MINUTES), "minutes").asMilliseconds());
}