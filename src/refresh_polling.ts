import moment = require("moment");
import { promisify } from "util";

import * as db from "./db";
import * as puzzles from "./puzzles";

export async function refresh() {
  await puzzles.refreshStale();
  await promisify(db.sessionStore.pruneSessions)();
}

if (process.env.REFRESH_POLLING_MINUTES) {
  setInterval(
    refresh,
    moment.duration(Number(process.env.REFRESH_POLLING_MINUTES), "minutes").asMilliseconds());
}