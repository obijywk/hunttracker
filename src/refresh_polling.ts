import moment = require("moment");

import * as puzzles from "./puzzles";

export async function refresh() {
  await puzzles.refreshStale();
}

if (process.env.REFRESH_POLLING_MINUTES) {
  setInterval(
    refresh,
    moment.duration(Number(process.env.REFRESH_POLLING_MINUTES), "minutes").asMilliseconds());
}