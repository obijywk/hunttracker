import moment = require("moment");

import * as db from "./db";

export enum ActivityType {
  JoinChannel = "join_channel",
  MessageChannel = "message_channel",
  JoinHuddle = "join_huddle",
  EditSheet = "edit_sheet",
  RecordAnswer = "record_answer"
}
const activityTypeLookup: Map<string, ActivityType> = new Map(
  Object.values(ActivityType).map((v) => [`${v}`, v] as const));

export async function recordActivity(
  puzzleId: string,
  userId: string,
  activityType: ActivityType,
  timestamp?: moment.Moment,
): Promise<void> {
  if (!process.env.ENABLE_RECORD_ACTIVITY) {
    return;
  }

  const timestampToRecord = timestamp !== undefined ? timestamp.format() : moment().utc();

  // We don't want to insert a new row every time a user sends a message in a puzzle
  // channel or edits a spreadsheet; that would be too many rows. Instead, we'll detect if a
  // user is performing these activities without interruption (they don't have any newer
  // activity of the same type on other channels), and in this case we'll update the
  // timestamp of the existing row rather than creating a new row.

  const result = await db.query(`
    SELECT DISTINCT ON (user_id, activity_type)
      puzzle_id, user_id, timestamp, activity_type
    FROM activity
    WHERE
      user_id = $1
      AND activity_type = $2
    ORDER BY user_id, activity_type, timestamp DESC NULLS LAST
    LIMIT 1`,
    [userId, activityType]);

  if (result.rowCount > 0) {
    if (result.rows[0].puzzle_id === puzzleId) {
      await db.query(`
        UPDATE activity SET timestamp = $1
        WHERE
          puzzle_id = $2
          AND user_id = $3
          AND activity_type = $4
          AND timestamp = $5`,
      [timestampToRecord, puzzleId, userId, activityType, result.rows[0].timestamp]);
      return;
    }
  }

  // There might be a primary key conflict as we try to record polled spreadsheet edit
  // activity multiple times.
  await db.query(`
    INSERT INTO activity(puzzle_id, user_id, timestamp, activity_type)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING`,
    [
      puzzleId,
      userId,
      timestampToRecord,
      activityType,
    ]);
}

interface Activity {
  userId: string;
  puzzleId: string;
  activityType: ActivityType;
  timestamp: moment.Moment;
}

export async function listLatestActivity(): Promise<Activity[]> {
  const result = await db.query(`
    SELECT
      user_id,
      puzzle_id,
      activity_type,
      timestamp
    FROM (
      SELECT
        user_id,
        puzzle_id,
        activity_type,
        timestamp,
        rank() OVER (PARTITION BY user_id ORDER BY timestamp DESC NULLS LAST) AS r
      FROM activity
    ) AS subselect
    WHERE r = 1`);
  return result.rows.map(r => ({
    userId: r.user_id,
    puzzleId: r.puzzle_id,
    activityType: activityTypeLookup.get(r.activity_type),
    timestamp: moment.utc(r.timestamp),
  }));
}

export async function getUserActivity(userId: string): Promise<Activity[]> {
  const result = await db.query(`
    SELECT
      puzzle_id,
      activity_type,
      timestamp
    FROM activity
    WHERE user_id = $1
    ORDER BY timestamp DESC NULLS LAST`,
    [userId]);
  return result.rows.map(r => ({
    userId,
    puzzleId: r.puzzle_id,
    activityType: activityTypeLookup.get(r.activity_type),
    timestamp: moment.utc(r.timestamp),
  }));
}

export async function getPuzzleActivity(puzzleId: string): Promise<Activity[]> {
  const result = await db.query(`
    SELECT
      user_id,
      activity_type,
      timestamp
    FROM activity
    WHERE puzzle_id = $1
    ORDER BY timestamp DESC NULLS LAST`,
    [puzzleId]);
  return result.rows.map(r => ({
    userId: r.user_id,
    puzzleId,
    activityType: activityTypeLookup.get(r.activity_type),
    timestamp: moment.utc(r.timestamp),
  }));
}