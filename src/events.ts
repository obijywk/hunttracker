import {
  MemberJoinedChannelEvent,
  MemberLeftChannelEvent,
  MessageEvent,
} from "@slack/bolt";

import { app } from "./app";
import * as puzzles from "./puzzles";
import * as taskQueue from "./task_queue";
import * as users from "./users";

const refreshPuzzleSubtypes = new Set([
  "channel_topic",
]);

app.event("message", async ({ event, body }) => {
  const messageEvent = event as unknown as MessageEvent;
  if (refreshPuzzleSubtypes.has(messageEvent.subtype) &&
      await puzzles.isPuzzleChannel(messageEvent.channel)) {
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: messageEvent.channel,
    });
  } else {
    const userExistsPromise = users.exists(messageEvent.user);
    const isIdlePuzzleChannelPromise = puzzles.isIdlePuzzleChannel(messageEvent.channel);
    const userExists = await userExistsPromise;
    const isIdlePuzzleChannel = await isIdlePuzzleChannelPromise;
    if (userExists && isIdlePuzzleChannel) {
      await taskQueue.scheduleTask("refresh_puzzle", {
        id: messageEvent.channel,
      });
    }
  }
  if (body.eventAck) {
    body.eventAck();
  }
});

app.event("member_joined_channel", async ({ event, body}) => {
  const memberJoinedChannelEvent = event as unknown as MemberJoinedChannelEvent;
  if (await puzzles.isPuzzleChannel(memberJoinedChannelEvent.channel)) {
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: memberJoinedChannelEvent.channel,
    });
  }
  if (memberJoinedChannelEvent.channel === process.env.SLACK_ADMIN_CHANNEL_ID) {
    await taskQueue.scheduleTask("refresh_users", {});
  }
  if (body.eventAck) {
    body.eventAck();
  }
});

app.event("member_left_channel", async ({ event, body}) => {
  const memberLeftChannelEvent = event as unknown as MemberLeftChannelEvent;
  if (await puzzles.isPuzzleChannel(memberLeftChannelEvent.channel)) {
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: memberLeftChannelEvent.channel,
    });
  }
  if (memberLeftChannelEvent.channel === process.env.SLACK_ADMIN_CHANNEL_ID) {
    await taskQueue.scheduleTask("refresh_users", {});
  }
  if (body.eventAck) {
    body.eventAck();
  }
});