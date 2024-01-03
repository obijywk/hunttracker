import { PoolClient, QueryResult } from "pg";
import { UserChangeEvent } from "@slack/bolt";

import { ActivityType, recordActivity } from "./activity";
import { app } from "./app";
import * as db from "./db";
import { createPeople, getAllPeople, GooglePerson } from "./google_people";
import { ConversationsMembersResult, UsersListResult, UserResult } from "./slack_results";
import * as taskQueue from "./task_queue";

export interface User {
  id: string;
  name: string;
  email: string;
  admin: boolean;
  googlePeopleResourceName: string;
  googleActivityPersonName: string;
  googleEmail: string;
}

const ignoredUserIds = new Set(process.env.SLACK_IGNORED_USER_IDS.split(","));

export function rowToUser(row: any): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    admin: row.admin,
    googlePeopleResourceName: row.google_people_resource_name || "",
    googleActivityPersonName: row.google_activity_person_name || "",
    googleEmail: row.google_email || "",
  };
}

function shouldAcceptMember(member: UserResult): boolean {
  return !member.deleted && !member.is_bot && !ignoredUserIds.has(member.id);
}

function getMemberName(member: UserResult): string {
  if (member.profile.real_name_normalized) {
    return member.profile.real_name_normalized;
  }
  if (member.profile.display_name_normalized) {
    return member.profile.display_name_normalized;
  }
  return member.name;
}

async function getConversationMemberUserIds(channelId: string): Promise<Set<string>> {
  const channelUsers: Set<string> = new Set();
  let cursor = undefined;
  do {
    const conversationMembersResult = await app.client.conversations.members({
      token: process.env.SLACK_USER_TOKEN,
      channel: channelId,
      cursor,
    }) as ConversationsMembersResult;
    for (const userId of conversationMembersResult.members) {
      channelUsers.add(userId);
    }
    cursor = conversationMembersResult.response_metadata.next_cursor;
  } while (cursor);
  return channelUsers;
}

async function getAdminUserIds(): Promise<Set<string> | null> {
  if (!process.env.SLACK_ADMIN_CHANNEL_ID) {
    return null;
  }
  return getConversationMemberUserIds(process.env.SLACK_ADMIN_CHANNEL_ID);
}

async function refreshAllInternal(client: PoolClient) {
  const adminUserIdsPromise = getAdminUserIds();

  const members: Array<UserResult> = [];
  let cursor = undefined;
  do {
    const userListResult = await app.client.users.list({
      token: process.env.SLACK_BOT_TOKEN,
      cursor,
    }) as UsersListResult;
    members.push(...userListResult.members);
    cursor = userListResult.response_metadata.next_cursor;
  } while (cursor);

  const dbUsers = await client.query("SELECT * FROM users") as QueryResult<any>;
  const idToDbUser: { [key: string]: User } = {};
  for (const row of dbUsers.rows) {
    idToDbUser[row.id] = rowToUser(row);
  }

  const adminUserIds = await adminUserIdsPromise;

  for (const member of members) {
    const acceptMember = shouldAcceptMember(member);
    const memberName = getMemberName(member);
    const dbUser = idToDbUser[member.id];
    const isAdminUser = adminUserIds !== null ? adminUserIds.has(member.id) : true;
    if (dbUser === undefined) {
      if (!acceptMember) continue;
      await client.query(
        "INSERT INTO users(id, name, email, admin) VALUES ($1, $2, $3, $4)",
        [member.id, memberName, member.profile.email, isAdminUser]);
    } else {
      if (!acceptMember) {
        await client.query("DELETE FROM users WHERE id = $1", [dbUser.id]);
      } else {
        if (dbUser.name != memberName) {
          await client.query(
            "UPDATE users SET name = $2 WHERE id = $1",
            [dbUser.id, memberName]);
        }
        if (dbUser.admin != isAdminUser) {
          await client.query(
            "UPDATE users SET admin = $2 WHERE id = $1",
            [dbUser.id, isAdminUser]);
        }
        if (dbUser.email != member.profile.email) {
          await client.query(
            "UPDATE users SET email = $2 WHERE id = $1",
            [dbUser.id, member.profile.email]);
        }
      }
    }
  }

  if (process.env.ENABLE_SHEET_EDITOR_INVITES || process.env.ENABLE_RECORD_ACTIVITY) {
    await syncGooglePeople(client);
  }
}

taskQueue.registerHandler("refresh_users", async (client) => {
  await refreshAllInternal(client);
});

export async function refreshAll() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await refreshAllInternal(client);
    await client.query("COMMIT");
  } catch (e) {
    console.error("Failed to sync users", e);
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

taskQueue.registerHandler("sync_google_people", async (client) => {
  await syncGooglePeople(client);
});

async function syncGooglePeople(client: PoolClient) {
  const existingPeople = await getAllPeople();
  const emailToPeople: { [key: string]: GooglePerson } = {};
  for (const person of existingPeople) {
    emailToPeople[person.email] = person;
  }

  const users = (await client.query("SELECT * FROM users")).rows.map(rowToUser);
  const emailToUser: { [key: string]: User } = {};
  for (const user of users) {
    if (user.email) {
      emailToUser[user.email] = user;
    }
    if (user.googleEmail) {
      emailToUser[user.googleEmail] = user;
    }
  }

  const peopleToCreate: Array<GooglePerson> = [];
  const userIdToGooglePeopleResourceName: { [key: string]: string } = {};
  for (const user of users) {
    for (const email of [user.email, user.googleEmail]) {
      if (!email) {
        continue;
      }
      const person = emailToPeople[email];
      if (!person) {
        peopleToCreate.push({
          email: email,
          name: user.name,
        });
      } else {
        if (person.resourceName !== user.googlePeopleResourceName) {
          userIdToGooglePeopleResourceName[user.id] = person.resourceName;
        }
      }
    }
  }

  await createPeople(peopleToCreate);

  for (const person of peopleToCreate) {
    const user = emailToUser[person.email];
    userIdToGooglePeopleResourceName[user.id] = person.resourceName;
  }
  const values = [];
  for (const userId in userIdToGooglePeopleResourceName) {
    const googlePeopleResourceName = userIdToGooglePeopleResourceName[userId];
    values.push(`('${userId}', '${googlePeopleResourceName}')`);
  }
  if (values.length > 0) {
    await client.query(`
      UPDATE users AS t SET
        google_people_resource_name = v.google_people_resource_name
      FROM (VALUES ${values.join(",")}) AS v(id, google_people_resource_name)
      WHERE v.id = t.id
    `);
  }
}

export async function refreshPuzzleUsers(
  puzzleId: string,
  client: PoolClient,
): Promise<Array<string>> {
  const affectedUserIds: Array<string> = [];

  const dbUsersResultPromise = client.query(
    "SELECT user_id FROM puzzle_user WHERE puzzle_id = $1", [puzzleId]);

  const channelUsers = await getConversationMemberUserIds(puzzleId);

  const dbUsersResult = await dbUsersResultPromise;
  const dbUsers: Set<string> = new Set();
  for (const row of dbUsersResult.rows) {
    dbUsers.add(row.user_id);
  }

  for (const channelUser of channelUsers) {
    if (!dbUsers.has(channelUser)) {
      const result = await client.query(`
        INSERT INTO puzzle_user (puzzle_id, user_id)
        SELECT $1, id FROM users
        WHERE id = $2
        ON CONFLICT DO NOTHING`,
        [puzzleId, channelUser]);
      if (result.rowCount > 0) {
        affectedUserIds.push(channelUser);
      }
    }
  }
  for (const dbUser of dbUsers) {
    if (!channelUsers.has(dbUser)) {
      const result = await client.query(
        "DELETE FROM puzzle_user WHERE puzzle_id = $1 AND user_id = $2",
        [puzzleId, dbUser]);
      if (result.rowCount > 0) {
        affectedUserIds.push(dbUser);
      }
    }
  }

  return affectedUserIds;
}

export async function syncPuzzleHuddleUsers(
  puzzleId: string,
  huddleParticipantUserIds: string[],
  client: PoolClient): Promise<void> {

  const dbUserIdsResult = await client.query(
    "SELECT user_id FROM puzzle_huddle_user WHERE puzzle_id = $1", [puzzleId]);
  const dbUserIds: Set<string> = new Set();
  for (const row of dbUserIdsResult.rows) {
    dbUserIds.add(row.user_id);
  }

  const huddleUserIds: Set<string> = new Set();
  for (const userId of huddleParticipantUserIds) {
    huddleUserIds.add(userId);
  }

  const promises = [];
  for (const huddleUserId of huddleUserIds) {
    if (!dbUserIds.has(huddleUserId)) {
      promises.push(client.query(`
        INSERT INTO puzzle_huddle_user (puzzle_id, user_id)
        SELECT $1, id FROM users
        WHERE id = $2
        ON CONFLICT DO NOTHING`,
        [puzzleId, huddleUserId]).then(async result => {
          if (result.rowCount > 0) {
            await recordActivity(puzzleId, huddleUserId, ActivityType.JoinHuddle);
          }
        }));
    }
  }
  for (const dbUserId of dbUserIds) {
    if (!huddleUserIds.has(dbUserId)) {
      promises.push(client.query(
        "DELETE FROM puzzle_huddle_user WHERE puzzle_id = $1 AND user_id = $2",
        [puzzleId, dbUserId]));
    }
  }
  for (const promise of promises) {
    await promise;
  }
}

export async function isAdmin(userId: string): Promise<boolean> {
  const result = await db.query("SELECT admin FROM users WHERE id = $1", [userId]);
  if (result.rowCount !== 1) {
    return false;
  }
  return result.rows[0].admin;
}

export async function exists(userId: string): Promise<boolean> {
  const result = await db.query(
    "SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)",
    [userId]);
  return result.rowCount > 0 && result.rows[0].exists;
}

export async function get(userId: string): Promise<User | null> {
  const result = await db.query(
    "SELECT * FROM users WHERE id = $1",
    [userId]);
  if (result.rowCount !== 1) {
    return null;
  }
  return rowToUser(result.rows[0]);
}

export async function list(): Promise<Array<User>> {
  return (await db.query("SELECT * FROM users")).rows.map(rowToUser);
}

export async function findUsersByGoogleActivityPersonName(
  googleActivityPersonNames: Array<string>,
  client: PoolClient,
): Promise<Array<User>> {
  if (googleActivityPersonNames.length === 0) {
    return [];
  }
  const values = [];
  for (const googleActivityPersonName of googleActivityPersonNames) {
    values.push(`'${googleActivityPersonName}'`);
  }
  const results = await client.query(`
    SELECT * FROM users WHERE google_activity_person_name IN (${values.join(",")})
  `);
  return results.rows.map(rowToUser);
}

export async function findUsersByEmail(emails: Array<string>, client: PoolClient): Promise<Array<User>> {
  if (emails.length === 0) {
    return [];
  }
  const values = [];
  for (const email of emails) {
    values.push(`'${email}'`);
  }
  const results = await client.query(`
    SELECT * FROM users
    WHERE
      email IN (${values.join(",")})
      OR google_email IN (${values.join(",")})
  `);
  return results.rows.map(rowToUser);
}

export async function updateGoogleActivityPersonNames(
  userIdToGoogleActivityPersonName: { [key: string]: string },
  client: PoolClient,
): Promise<void> {
  if (Object.keys(userIdToGoogleActivityPersonName).length === 0) {
    return;
  }
  const values = [];
  for (const userId in userIdToGoogleActivityPersonName) {
    const googleActivityPersonName = userIdToGoogleActivityPersonName[userId];
    values.push(`('${userId}', '${googleActivityPersonName}')`);
  }
  if (values.length > 0) {
    await client.query(`
      UPDATE users AS t SET
        google_activity_person_name = v.google_activity_person_name
      FROM (VALUES ${values.join(",")}) AS v(id, google_activity_person_name)
      WHERE v.id = t.id
    `);
  }
}

app.event("user_change", async ({ event, body }) => {
  try {
    const userChangeEvent = event as UserChangeEvent;
    const member = userChangeEvent.user as UserResult;
    if (!shouldAcceptMember(member)) {
      return;
    }
    const memberName = getMemberName(member);
    const dbUserResult = await db.query("SELECT * FROM users WHERE id = $1", [member.id]);
    const adminUserIds = await getAdminUserIds();
    const isAdminUser = adminUserIds !== null ? adminUserIds.has(member.id) : true;
    let shouldSyncGooglePeople = false;
    if (dbUserResult.rowCount === 0) {
      await db.query(
        "INSERT INTO users(id, name, email, admin) VALUES ($1, $2, $3, $4)",
        [member.id, memberName, member.profile.email, isAdminUser]);
      shouldSyncGooglePeople = true;
    } else {
      const dbUser = rowToUser(dbUserResult.rows[0]);
      if (dbUser.name != memberName) {
        await db.query(
          "UPDATE users SET name = $2 WHERE id = $1",
          [dbUser.id, memberName]);
        shouldSyncGooglePeople = true;
      }
      if (dbUser.admin != isAdminUser) {
        await db.query(
          "UPDATE users SET admin = $2 WHERE id = $1",
          [dbUser.id, isAdminUser]);
      }
      if (dbUser.email != member.profile.email) {
        await db.query(
          "UPDATE users SET email = $2 WHERE id = $1",
          [dbUser.id, member.profile.email]);
        shouldSyncGooglePeople = true;
      }
    }
    if (shouldSyncGooglePeople && (process.env.ENABLE_SHEET_EDITOR_INVITES || process.env.ENABLE_RECORD_ACTIVITY)) {
      await taskQueue.scheduleTask("sync_google_people", {});
    }
  } finally {
    if (body.eventAck) {
      body.eventAck();
    }
  }
});