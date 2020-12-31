import { google } from "googleapis";
import moment = require("moment");

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  scopes: [
    "https://www.googleapis.com/auth/drive",
  ],
});

const drive = google.drive({version: "v3", auth: auth});

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

export async function getFileModifiedTimestamp(fileId: string): Promise<moment.Moment | null> {
  if (rateLimitExceededTimestamp !== null &&
      moment().diff(rateLimitExceededTimestamp) < rateLimitExceededCooldown.asMilliseconds()) {
    console.info("Skipping Drive timestamp request for", fileId);
    return null;
  } else {
    rateLimitExceededTimestamp = null;
  }

  try {
    const response = await drive.files.get({fileId, fields: "modifiedTime"});
    return moment(response.data.modifiedTime);
  } catch (e) {
    console.error("getSheetModifiedTimestamp failed", e);
    if (e.response && e.response.errors) {
      for (const error of e.response.errors) {
        if (error.reason === "userRateLimitExceeded") {
          rateLimitExceededTimestamp = moment();
        }
      }
    }
    return null;
  }
}

export async function getSheetModifiedTimestamp(url: string): Promise<moment.Moment | null> {
  const fileId = getSheetUrlFileId(url);
  return getFileModifiedTimestamp(fileId);
}

export async function getDrawingModifiedTimestamp(url: string): Promise<moment.Moment | null> {
  const fileId = getDrawingUrlFileId(url);
  return getFileModifiedTimestamp(fileId);
}