import * as moment from "moment";
import { promisify } from "util";

import * as db from "./db";
import * as puzzles from "./puzzles";
import { scheduleCheckSheetEditors } from "./sheet_editors";

export async function refresh() {
  await scheduleCheckSheetEditors();
  await puzzles.refreshStale();
  await promisify(db.sessionStore.pruneSessions.bind(db.sessionStore))();
}

if (process.env.REFRESH_POLLING_MINUTES) {
  setInterval(
    refresh,
    moment.duration(Number(process.env.REFRESH_POLLING_MINUTES), "minutes").asMilliseconds());
}