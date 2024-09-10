import { google } from "googleapis";
import * as moment from "moment";

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  scopes: [
    "https://www.googleapis.com/auth/drive",
  ],
});

const drive = google.drive({version: "v3", auth: auth});
const sheets = google.sheets({version: "v4", auth: auth});

const SHEET_URL_PREFIX = "https://docs.google.com/spreadsheets/d/";
const SHEET_URL_FILE_ID_REGEX = RegExp("^" + SHEET_URL_PREFIX + "([^/]+).*$");

const DRAWING_URL_PREFIX = "https://docs.google.com/drawings/d/";
const DRAWING_URL_FILE_ID_REGEX = RegExp("^" + DRAWING_URL_PREFIX + "([^/]+).*$");

let rateLimitExceededTimestamp: moment.Moment | null = null;
const rateLimitExceededCooldown = moment.duration(1, "minute");

function getSheetUrlFileId(url: string): string {
  const match = SHEET_URL_FILE_ID_REGEX.exec(url);
  if (match) {
    return match[1];
  }
  throw `Failed to extract file ID from ${url}`;
}

export function getFileIdSheetUrl(fileId: string): string {
  return SHEET_URL_PREFIX + fileId;
}

function getDrawingUrlFileId(url: string): string {
  const match = DRAWING_URL_FILE_ID_REGEX.exec(url);
  if (match) {
    return match[1];
  }
  throw `Failed to extract file ID from ${url}`;
}

export async function copySheet(url: string, name: string): Promise<string> {
  const fileId = getSheetUrlFileId(url);
  try {
    const response = await drive.files.copy({fileId, requestBody: {name}});
    return SHEET_URL_PREFIX + response.data.id;
  } catch (e) {
    console.error("copySheet failed", e);
    throw e;
  }
}

export async function copyDrawing(url: string, name: string): Promise<string> {
  const fileId = getDrawingUrlFileId(url);
  try {
    const response = await drive.files.copy({fileId, requestBody: {name}});
    return DRAWING_URL_PREFIX + response.data.id;
  } catch (e) {
    console.error("copyDrawing failed", e);
    throw e;
  }
}

export async function renameSheet(url: string, name: string) {
  const fileId = getSheetUrlFileId(url);
  await drive.files.update({fileId, requestBody: {name}});
}

export async function renameDrawing(url: string, name: string) {
  const fileId = getDrawingUrlFileId(url);
  await drive.files.update({fileId, requestBody: {name}});
}

export async function deleteSheet(url: string) {
  const fileId = getSheetUrlFileId(url);
  await drive.files.delete({fileId});
}

export async function deleteDrawing(url: string) {
  const fileId = getDrawingUrlFileId(url);
  await drive.files.delete({fileId});
}

export interface DriveFileMetadata {
  name: string;
  modifiedTimestamp: moment.Moment;
}

export async function getFileMetadata(fileId: string): Promise<DriveFileMetadata | null> {
  if (rateLimitExceededTimestamp !== null &&
      moment.utc().diff(rateLimitExceededTimestamp) < rateLimitExceededCooldown.asMilliseconds()) {
    console.info("Skipping Drive file metadata request for", fileId);
    return null;
  } else {
    rateLimitExceededTimestamp = null;
  }

  try {
    const response = await drive.files.get({fileId, fields: "name,modifiedTime"});
    return {
      name: response.data.name,
      modifiedTimestamp: moment.utc(response.data.modifiedTime),
    };
  } catch (e) {
    console.error("getFileMetadata failed", e);
    if (e.response && e.response.errors) {
      for (const error of e.response.errors) {
        if (error.reason === "userRateLimitExceeded") {
          rateLimitExceededTimestamp = moment.utc();
        }
      }
    }
    return null;
  }
}

export async function getSheetMetadata(url: string): Promise<DriveFileMetadata | null> {
  const fileId = getSheetUrlFileId(url);
  return getFileMetadata(fileId);
}

export async function getDrawingMetadata(url: string): Promise<DriveFileMetadata | null> {
  const fileId = getDrawingUrlFileId(url);
  return getFileMetadata(fileId);
}

export async function getSheetFolderFileId(url: string): Promise<string | null> {
  const fileId = getSheetUrlFileId(url);
  try {
    const response = await drive.files.get({fileId, fields: "parents"});
    if (response.data.parents.length > 0) {
      return response.data.parents[0];
    }
    return null;
  } catch (e) {
    console.error("getSheetFolderFileId failed", e);
    if (e.response && e.response.errors) {
      for (const error of e.response.errors) {
        if (error.reason === "userRateLimitExceeded") {
          rateLimitExceededTimestamp = moment.utc();
        }
      }
    }
    return null;
  }
}

export async function appendPuzzleRowToTrackingSheet(name: string) {
  if (!process.env.PUZZLE_TRACKING_SHEET_ID) {
    return;
  }
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: process.env.PUZZLE_TRACKING_SHEET_ID,
    fields: "sheets.properties",
  });
  const sheetTitle = spreadsheet.data.sheets[0].properties.title;
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.PUZZLE_TRACKING_SHEET_ID,
    range: sheetTitle + "!A1:A1",
    valueInputOption: "RAW",
    requestBody: {
      majorDimension: "ROWS",
      values: [[name]],
    },
  });
}