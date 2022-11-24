import { app } from "./app";
import { getRecentPuzzleSheetEditors } from "./google_drive_activity";
import { getPeopleByResourceNames } from "./google_people";
import * as puzzles from "./puzzles";
import * as taskQueue from "./task_queue";
import { findUsersByEmail, findUsersByGoogleActivityPersonName, updateGoogleActivityPersonNames, User } from "./users";

export async function scheduleSendSheetEditorInvites(): Promise<void> {
  if (process.env.ENABLE_SHEET_EDITOR_INVITES) {
    await taskQueue.scheduleTask("send_sheet_editor_invites", {});
  }
}

taskQueue.registerHandler("send_sheet_editor_invites", async (client, _) => {
  const puzzleSheetToEditors: { [key: string]: Set<string> } = await getRecentPuzzleSheetEditors();
  if (Object.keys(puzzleSheetToEditors).length === 0) {
    return;
  }

  const googleActivityPersonNames: Set<string> = new Set();
  for (const editors of Object.values(puzzleSheetToEditors)) {
    for (const editor of editors) {
      googleActivityPersonNames.add(editor);
    }
  }
  const knownUsers = await findUsersByGoogleActivityPersonName(
      Array.from(googleActivityPersonNames.values()), client);
  const googleActivityPersonNameToUser: { [key: string]: User } = {};
  const emailToUser: { [key: string]: User} = {};
  for (const user of knownUsers) {
    if (user.googleActivityPersonName) {
      googleActivityPersonNameToUser[user.googleActivityPersonName] = user;
    }
    if (user.email) {
      emailToUser[user.email] = user;
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
    withSheetUrlIn: Object.keys(puzzleSheetToEditors),
  });
  for (const puzzle of editedPuzzles) {
    if (puzzle.complete) {
      continue;
    }
    const googleActivityPersonNames = puzzleSheetToEditors[puzzle.sheetUrl];
    const userIdsToInvite: Set<string> = new Set();
    for (const googleActivityPersonName of googleActivityPersonNames) {
      const user = googleActivityPersonNameToUser[googleActivityPersonName];
      if (user) {
        userIdsToInvite.add(user.id);
      }
    }
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
});