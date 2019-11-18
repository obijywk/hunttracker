import { QueryResult } from "pg";
import { UserChangeEvent } from "@slack/bolt";

import { app } from "./app";
import * as db from "./db";
import { UsersListResult, UserResult } from "./slack_results";

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

app.event("user_change", async ({ event }) => {
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
});