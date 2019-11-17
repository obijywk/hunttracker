import { PoolClient, QueryResult } from "pg";

import { app } from "./app";
import * as db from "./db";
import { UsersListResult, UsersListResultMember } from "./slack_results";

export interface User {
  id: string;
  name: string;
}

const ignoredUserIds = new Set(process.env.SLACK_IGNORED_USER_IDS.split(","));

function shouldAcceptMember(member: UsersListResultMember): boolean {
  return !member.deleted && !member.is_bot && !ignoredUserIds.has(member.id);
}

function getMemberName(member: UsersListResultMember): string {
  if (member.profile.display_name_normalized) {
    return member.profile.display_name_normalized;
  }
  if (member.profile.real_name_normalized) {
    return member.profile.real_name_normalized;
  }
  return member.name;
}

export async function refreshAll() {
  const members: Array<UsersListResultMember> = [];
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