import { PoolClient, QueryResult } from "pg";
import { UserChangeEvent } from "@slack/bolt";

import { app } from "./app";
import * as db from "./db";
import { ConversationsMembersResult, UsersListResult, UserResult } from "./slack_results";

export interface User {
  id: string;
  name: string;
}

const ignoredUserIds = new Set(process.env.SLACK_IGNORED_USER_IDS.split(","));

function shouldAcceptMember(member: UserResult): boolean {
  return !member.deleted && !member.is_bot && !ignoredUserIds.has(member.id);
}

function getMemberName(member: UserResult): string {
  if (member.profile.display_name_normalized) {
    return member.profile.display_name_normalized;
  }
  if (member.profile.real_name_normalized) {
    return member.profile.real_name_normalized;
  }
  return member.name;
}

export async function refreshAll() {
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

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const dbUsers = await client.query("SELECT id, name FROM users") as QueryResult<User>;
    const idToDbUser: { [key: string]: User } = {};
    for (const dbUser of dbUsers.rows) {
      idToDbUser[dbUser.id] = dbUser;
    }

    for (const member of members) {
      const acceptMember = shouldAcceptMember(member);
      const memberName = getMemberName(member);
      const dbUser = idToDbUser[member.id];
      if (dbUser === undefined) {
        if (!acceptMember) continue;
        await client.query(
          "INSERT INTO users(id, name) VALUES ($1, $2)",
          [member.id, memberName]);
      } else {
        if (!acceptMember) {
          await client.query("DELETE FROM users WHERE id = $1", [dbUser.id]);
        } else {
          if (dbUser.name != memberName) {
            await client.query(
              "UPDATE users SET name = $2 WHERE id = $1",
              [dbUser.id, memberName]);
          }
        }
      }
    }

    await client.query("COMMIT");
  } catch (e) {
    console.error("Failed to sync users", e);
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function refreshPuzzleUsers(
  puzzleId: string,
  client: PoolClient,
): Promise<Array<string>> {
  const affectedUserIds: Array<string> = [];

  const dbUsersResultPromise = client.query(
    "SELECT user_id FROM puzzle_user WHERE puzzle_id = $1", [puzzleId]);

  const channelUsers: Set<string> = new Set();
  let cursor = undefined;
  do {
    const conversationMembersResult = await app.client.conversations.members({
      token: process.env.SLACK_USER_TOKEN,
      channel: puzzleId,
    }) as ConversationsMembersResult;
    for (const userId of conversationMembersResult.members) {
      channelUsers.add(userId);
    }
    cursor = conversationMembersResult.response_metadata.next_cursor;
  } while (cursor);

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
        WHERE id = $2`,
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

app.event("user_change", async ({ event, body }) => {
  try {
    const userChangeEvent = event as UserChangeEvent;
    const member = userChangeEvent.user as UserResult;
    if (!shouldAcceptMember(member)) {
      return;
    }
    const memberName = getMemberName(member);
    const dbUserResult = await db.query("SELECT id, name FROM users WHERE id = $1", [member.id]);
    if (dbUserResult.rowCount === 0) {
      await db.query(
        "INSERT INTO users(id, name) VALUES ($1, $2)",
        [member.id, memberName]);
    } else {
      const dbUser = dbUserResult.rows[0] as User;
      if (dbUser.name != memberName) {
        await db.query(
          "UPDATE users SET name = $2 WHERE id = $1",
          [dbUser.id, memberName]);
      }
    }
  } finally {
    if (body.eventAck) {
      body.eventAck();
    }
  }
});