import { ActivityType, recordActivity } from "./activity";
import { app } from "./app";
import { getRecentPuzzleSheetEditors } from "./google_drive_activity";
import { getPeopleByResourceNames } from "./google_people";
import * as puzzles from "./puzzles";
import * as taskQueue from "./task_queue";
import { findUsersByEmail, findUsersByGoogleActivityPersonName, updateGoogleActivityPersonNames, User } from "./users";

export async function scheduleCheckSheetEditors(): Promise<void> {
  if (process.env.ENABLE_SHEET_EDITOR_INVITES || process.env.ENABLE_RECORD_ACTIVITY) {
    await taskQueue.scheduleTask("check_sheet_editors", {});
  }
}

taskQueue.registerHandler("check_sheet_editors", async (client, _) => {
  const sheetEditsMap = await getRecentPuzzleSheetEditors();
  if (sheetEditsMap.size === 0) {
    return;
  }

  const googleActivityPersonNames: Set<string> = new Set();
  for (const editsMap of sheetEditsMap.values()) {
    for (const editor of editsMap.keys()) {
      googleActivityPersonNames.add(editor);
    }
  }
  const knownUsers = await findUsersByGoogleActivityPersonName(
    Array.from(googleActivityPersonNames.values()), client);
  const googleActivityPersonNameToUser: { [key: string]: User } = {};
  const emailToUser: { [key: string]: User } = {};
  for (const user of knownUsers) {
    if (user.googleActivityPersonName) {
      googleActivityPersonNameToUser[user.googleActivityPersonName] = user;
    }
    if (user.email) {
      emailToUser[user.email] = user;
    }
    if (user.googleEmail) {
      emailToUser[user.googleEmail] = user;
    }
  }

  const googleActivityPersonNamesToGet: Array<string> = [];
  for (const googleActivityPersonName of googleActivityPersonNames) {
    if (!googleActivityPersonNameToUser[googleActivityPersonName]) {
      googleActivityPersonNamesToGet.push(googleActivityPersonName);
    }
  }
  const unknownGooglePeople = await getPeopleByResourceNames(googleActivityPersonNamesToGet);
  const unknownUsers = await findUsersByEmail(unknownGooglePeople.map(p => p.email), client);
  for (const user of unknownUsers) {
    if (user.email) {
      emailToUser[user.email] = user;
    }
    if (user.googleEmail) {
      emailToUser[user.googleEmail] = user;
    }
  }

  const userIdToGoogleActivityPersonName: { [key: string]: string } = {};
  for (const googlePerson of unknownGooglePeople) {
    const user = emailToUser[googlePerson.email];
    if (user && googlePerson.resourceName) {
      userIdToGoogleActivityPersonName[user.id] = googlePerson.resourceName;
      googleActivityPersonNameToUser[googlePerson.resourceName] = user;
    }
  }
  await updateGoogleActivityPersonNames(userIdToGoogleActivityPersonName, client);

  const editedPuzzles = await puzzles.list({
    client,
    withSheetUrlIn: Array.from(sheetEditsMap.keys()),
  });
  for (const puzzle of editedPuzzles) {
    const googleActivityPersonNamesToTimestamps = sheetEditsMap.get(puzzle.sheetUrl).entries();
    const userIdsToTimestamps: Map<string, moment.Moment> = new Map();
    for (const [googleActivityPersonName, timestamp] of googleActivityPersonNamesToTimestamps) {
      const user = googleActivityPersonNameToUser[googleActivityPersonName];
      if (user) {
        userIdsToTimestamps.set(user.id, timestamp);
      }
    }

    const promises = [];
    if (process.env.ENABLE_RECORD_ACTIVITY) {
      for (const [userId, timestamp] of userIdsToTimestamps.entries()) {
        promises.push(recordActivity(puzzle.id, userId, ActivityType.EditSheet, timestamp));
      }
    }

    if (process.env.ENABLE_SHEET_EDITOR_INVITES && !puzzle.complete) {
      const userIdsToInvite = new Set(userIdsToTimestamps.keys());
      for (const user of puzzle.users) {
        userIdsToInvite.delete(user.id);
      }
      if (userIdsToInvite.size > 0) {
        const participantUserIds = await puzzles.getParticipantUserIds(puzzle.id);
        for (const participantUserId of participantUserIds) {
          userIdsToInvite.delete(participantUserId);
        }
      }
      if (userIdsToInvite.size > 0) {
        await app.client.conversations.invite({
          token: process.env.SLACK_USER_TOKEN,
          channel: puzzle.id,
          users: Array.from(userIdsToInvite).join(","),
        });
      }
    }

    for (const promise of promises) {
      await promise;
    }
  }
});