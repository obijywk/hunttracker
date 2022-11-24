import { google } from "googleapis";
import moment = require("moment");

import { getFileIdSheetUrl, getSheetFolderFileId } from "./google_drive";

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  scopes: [
    "https://www.googleapis.com/auth/drive.activity.readonly",
  ],
});

const driveActivity = google.driveactivity({version: "v2", auth: auth});

const ITEM_NAME_FILE_ID_REGEX = RegExp("^items/([^/]+).*$");
function getItemNameSheetUrl(itemName: string): string {
  const match = ITEM_NAME_FILE_ID_REGEX.exec(itemName);
  if (match) {
    return getFileIdSheetUrl(match[1]);
  }
  throw `Failed to extract file ID from ${itemName}`;
}

let puzzleFolderFileId: string | null = null;

export async function getRecentPuzzleSheetEditors(): Promise<{ [key: string]: Set<string> }> {
  if (puzzleFolderFileId === null) {
    puzzleFolderFileId = await getSheetFolderFileId(process.env.PUZZLE_SHEET_TEMPLATE_URL);
    if (puzzleFolderFileId === null) {
      return {};
    }
  }
  const minTimestamp = moment().utc().subtract(moment.duration(10, "minute")).valueOf();
  const response = await driveActivity.activity.query({
    requestBody: {
      ancestorName: "items/" + puzzleFolderFileId,
      filter: "detail.action_detail_case: EDIT AND time >= " + minTimestamp,
    },
  });
  if (!response.data.activities) {
    return {};
  }

  const editorSets: { [key: string]: Set<string> } = {};
  for (const activity of response.data.activities) {
    if (activity.targets.length === 0 || !activity.targets[0].driveItem) {
      continue;
    }
    if (activity.actors.length === 0 || !activity.actors[0].user || !activity.actors[0].user.knownUser) {
      continue;
    }
    const sheetUrl = getItemNameSheetUrl(activity.targets[0].driveItem.name);
    const personResource = activity.actors[0].user.knownUser.personName;
    if (!editorSets[sheetUrl]) {
      editorSets[sheetUrl] = new Set();
    }
    editorSets[sheetUrl].add(personResource);
  }
  return editorSets;
}