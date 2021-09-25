import {
  ChannelArchiveEvent,
  ChannelUnarchiveEvent,
  GenericMessageEvent,
  MemberJoinedChannelEvent,
  MemberLeftChannelEvent,
  MessageChangedEvent,
} from "@slack/bolt";

import { app } from "./app";
import * as puzzles from "./puzzles";
import * as taskQueue from "./task_queue";
import * as users from "./users";

const refreshPuzzleSubtypes = new Set([
  "channel_topic",
]);

app.event("message", async ({ event, body }) => {
  let isBotMessage = event.subtype === "bot_message";
  if (event.subtype === "message_changed") {
    isBotMessage = (event as MessageChangedEvent).message.subtype === "bot_message";
  }
  if (refreshPuzzleSubtypes.has(event.subtype) &&
      await puzzles.isPuzzleChannel(event.channel)) {
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: event.channel,
    });
  } else if (!isBotMessage) {
    const userExistsPromise = users.exists((event as GenericMessageEvent).user);
    const isIdlePuzzleChannelPromise = puzzles.isIdlePuzzleChannel(event.channel);
    const userExists = await userExistsPromise;
    const isIdlePuzzleChannel = await isIdlePuzzleChannelPromise;
    if (userExists && isIdlePuzzleChannel) {
      await taskQueue.scheduleTask("refresh_puzzle", {
        id: event.channel,
      });
    }
  }
  if (body.eventAck) {
    body.eventAck();
  }
});

app.event("member_joined_channel", async ({ event, body }) => {
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

app.event("member_left_channel", async ({ event, body }) => {
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

app.event("channel_archive", async({ event, body }) => {
  const channelArchiveEvent = event as unknown as ChannelArchiveEvent;
  if (await puzzles.isPuzzleChannel(channelArchiveEvent.channel)) {
    await puzzles.clearEventUsers(channelArchiveEvent.channel);
  }
  if (body.eventAck) {
    body.eventAck();
  }
});

app.event("channel_unarchive", async({ event, body }) => {
  const channelUnarchiveEvent = event as unknown as ChannelUnarchiveEvent;
  if (await puzzles.isPuzzleChannel(channelUnarchiveEvent.channel)) {
    await puzzles.refreshEventUsers(channelUnarchiveEvent.channel);
  }
  if (body.eventAck) {
    body.eventAck();
  }
});