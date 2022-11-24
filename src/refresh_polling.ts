import moment = require("moment");
import { promisify } from "util";

import * as db from "./db";
import * as puzzles from "./puzzles";
import { scheduleSendSheetEditorInvites } from "./sheet_editor_invites";

export async function refresh() {
  await scheduleSendSheetEditorInvites();
  await puzzles.refreshStale();
  await promisify(db.sessionStore.pruneSessions.bind(db.sessionStore))();
}

if (process.env.REFRESH_POLLING_MINUTES) {
  setInterval(
    refresh,
    moment.duration(Number(process.env.REFRESH_POLLING_MINUTES), "minutes").asMilliseconds());
}