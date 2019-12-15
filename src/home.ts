import { ButtonAction } from "@slack/bolt";
import { Block, Button, KnownBlock } from "@slack/types";

import { app } from "./app";
import * as puzzles from "./puzzles";
import { getViewStateValues } from "./slack_util";
import * as tags from "./tags";
import * as taskQueue from "./task_queue";
import * as users from "./users";

const maxUsersToList = 5;
const maxPuzzlesToList = 30;

function buildPuzzleBlocks(puzzle: puzzles.Puzzle, userId: string) {
  let text = `:eye-in-speech-bubble: <${process.env.SLACK_URL_PREFIX}${puzzle.id}|${puzzle.name}>`;
  const idleStatus = puzzles.buildIdleStatus(puzzle);
  if (idleStatus) {
    text += "   " + idleStatus;
  }
  if (puzzle.channelTopic) {
    text += `\n${puzzles.buildTopicString(puzzle)}`;
  }
  if (puzzle.users && puzzle.users.length > 0) {
    let users = puzzle.users.slice(0, maxUsersToList).map(u => u.name).join(", ");
    if (puzzle.users.length > maxUsersToList) {
      users += " \u{2026}";
    }
    text += `\n:man-woman-girl-boy: (${puzzle.users.length}) ${users}`;
  }

  let accessory: Button = undefined;
  if (puzzle.users.map(u => u.id).indexOf(userId) === -1) {
    accessory = {
      type: "button",
      text: {
        type: "plain_text",
        text: "Join channel",
      },
      "action_id": "home_join_channel",
      value: JSON.stringify({ puzzleId: puzzle.id, userId }),
    };
  }

  const blocks: Array<Block | KnownBlock> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
      accessory,
    },
  ];

  const tagsBlock = tags.buildTagsBlock(puzzle.id, puzzle.tags);
  if (tagsBlock) {
    blocks.push(tagsBlock);
  }

  return blocks;
}

async function buildHomeBlocks(userId: string) {
  const isAdminPromise = users.isAdmin(userId);

  const allPuzzles = await puzzles.list({ excludeComplete: true });
  allPuzzles.sort((a, b) => {
    const joinedA = a.users.map(u => u.id).indexOf(userId) !== -1;
    const joinedB = b.users.map(u => u.id).indexOf(userId) !== -1;
    if (joinedA && !joinedB) {
      return -1;
    } else if (!joinedA && joinedB) {
      return 1;
    }
    return puzzles.getIdleDuration(b).subtract(puzzles.getIdleDuration(a)).asMilliseconds();
  });

  const isAdmin = await isAdminPromise;

  const actionsElements = [];
  actionsElements.push({
    type: "button",
    text: {
      type: "plain_text",
      text: ":repeat: Refresh",
    },
    "action_id": "home_refresh",
  });
  if (isAdmin) {
    actionsElements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: ":sparkles: Register puzzle",
      },
      "action_id": "home_register_puzzle",
    });
  }
  actionsElements.push({
    type: "button",
    text: {
      type: "plain_text",
      text: ":books: See all puzzles",
    },
    "action_id": "home_see_all_puzzles",
    url: process.env.WEB_SERVER_URL + "puzzles",
  });
  actionsElements.push({
    type: "button",
    text: {
      type: "plain_text",
      text: ":books: See all metas",
    },
    "action_id": "home_see_all_metas",
    url: process.env.WEB_SERVER_URL + "metas",
  });
  actionsElements.push({
    type: "button",
    text: {
      type: "plain_text",
      text: ":bookmark: Update tags",
    },
    "action_id": "home_update_tags",
    url: process.env.WEB_SERVER_URL + "tagger",
  });
  if (isAdmin) {
    actionsElements.push(tags.buildRenameTagButton());
    actionsElements.push(tags.buildDeleteTagsButton());
  }

  const blocks: Array<any> = [{
    type: "actions",
    elements: actionsElements,
  }];

  for (const puzzle of allPuzzles.slice(0, maxPuzzlesToList)) {
    blocks.push({
      type: "divider",
    });
    blocks.push(...buildPuzzleBlocks(puzzle, userId));
  }

  blocks.push({
    type: "divider",
  });

  if (allPuzzles.length > maxPuzzlesToList) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `There are too many open puzzles to show here! Visit <${process.env.WEB_SERVER_URL}puzzles> to see more.`,
      },
    });
  }

  return blocks;
}

export async function publish(userId: string) {
  await app.client.views.publish({
    token: process.env.SLACK_BOT_TOKEN,
    "user_id": userId,
    view: {
      type: "home" as any,
      title: {
        type: "plain_text",
        text: "Home",
      },
      blocks: await buildHomeBlocks(userId),
    },
  });
}

taskQueue.registerHandler("publish_home", async (client, payload) => {
  await publish(payload.userId);
});

app.event("app_home_opened", async ({ event, body }) => {
  await publish(event.user);
  if (body.eventAck) {
    body.eventAck();
  }
});

app.action("home_refresh", async ({ ack, body }) => {
  await publish(body.user.id);
  ack();
});

app.action("home_register_puzzle", async ({ ack, body }) => {
  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "home_register_puzzle_view",
      title: {
        type: "plain_text",
        text: "Register puzzle",
      },
      blocks: [
        {
          type: "input",
          "block_id": "puzzle_name_input",
          label: {
            type: "plain_text",
            text: "Puzzle name",
          },
          element: {
            type: "plain_text_input",
            placeholder: {
              type: "plain_text",
              text: "Enter puzzle name",
            },
          },
        },
        {
          type: "input",
          "block_id": "puzzle_url_input",
          optional: true,
          label: {
            type: "plain_text",
            text: "Puzzle URL",
          },
          element: {
            type: "plain_text_input",
            placeholder: {
              type: "plain_text",
              text: "Enter puzzle URL",
            },
          },
        },
        ...await tags.buildUpdateTagsBlocks("" /* no puzzle ID assigned yet */),
        {
          type: "input",
          "block_id": "puzzle_topic_input",
          optional: true,
          label: {
            type: "plain_text",
            text: "Topic",
          },
          hint: {
            type: "plain_text",
            text: "Consider including an initial summary of the puzzle content, if known.",
          },
          element: {
            type: "plain_text_input",
            placeholder: {
              type: "plain_text",
              text: "Enter initial topic",
            },
            multiline: true,
          },
        },
      ],
      submit: {
        type: "plain_text",
        text: "Register puzzle",
      },
    },
  });
  ack();
});

app.view("home_register_puzzle_view", async ({ack, view}) => {
  const values = getViewStateValues(view);
  const selectedTags = tags.getUpdateTagsViewStateValues(values);

  if (selectedTags.errors) {
    ack({
      "response_action": "errors",
      errors: selectedTags.errors,
    } as any);
    return;
  }

  const createError = await puzzles.create(
    values["puzzle_name_input"],
    values["puzzle_url_input"],
    selectedTags.selectedTagIds,
    selectedTags.newTagNames,
    values["puzzle_topic_input"]);

  if (createError) {
    ack({
      "response_action": "errors",
      errors: {
        "puzzle_name_input": createError,
      },
    } as any);
    return;
  }

  if (process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
    await app.client.chat.postMessage({
      token: process.env.SLACK_USER_TOKEN,
      channel: `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`,
      text: `Registering ${values["puzzle_name_input"]}, please wait...`,
    });
  }

  ack();
});

app.action("home_see_all_puzzles", async ({ ack }) => {
  ack();
});

app.action("home_see_all_metas", async ({ ack }) => {
  ack();
});

app.action("home_update_tags", async ({ ack }) => {
  ack();
});

app.action("home_join_channel", async ({ ack, payload }) => {
  const value = JSON.parse((payload as ButtonAction).value);
  const puzzleId = value.puzzleId;
  const userId = value.userId;

  await app.client.channels.invite({
    token: process.env.SLACK_USER_TOKEN,
    channel: puzzleId,
    user: userId,
  });

  ack();
});