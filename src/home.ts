import { ButtonAction } from "@slack/bolt";
import { Block, Button, KnownBlock, Option } from "@slack/types";

import { app } from "./app";
import * as puzzles from "./puzzles";
import { getViewStateValues } from "./slack_util";
import * as tags from "./tags";
import * as taskQueue from "./task_queue";
import * as users from "./users";

const maxUsersToList = 5;
const maxPuzzlesToList = 30;

function buildPuzzleBlocks(puzzle: puzzles.Puzzle, userId: string) {
  let text = `:eye-in-speech-bubble: <https://app.slack.com/client/${process.env.SLACK_TEAM_ID}/${puzzle.id}|${puzzle.name}>`;
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

  const actionsElements = [
    {
      type: "button",
      text: {
        type: "plain_text",
        text: ":repeat: Refresh",
      },
      "action_id": "home_refresh",
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: ":books: See all puzzles",
      },
      "action_id": "home_see_all_puzzles",
      url: process.env.WEB_SERVER_URL + "puzzles",
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: ":books: See all metas",
      },
      "action_id": "home_see_all_metas",
      url: process.env.WEB_SERVER_URL + "metas",
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: ":bookmark: Update tags",
      },
      "action_id": "home_update_tags",
      url: process.env.WEB_SERVER_URL + "tagger",
    },
  ];

  if (process.env.HELP_URL) {
    actionsElements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: ":question: Help",
      },
      "action_id": "home_help",
      url: process.env.HELP_URL,
    });
  }

  const blocks: Array<any> = [{
    type: "actions",
    elements: actionsElements,
  }];

  if (isAdmin) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: ":sparkles: Register puzzle",
          },
          "action_id": "home_register_puzzle",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: ":pencil2: Rename puzzle",
          },
          "action_id": "home_rename_puzzle",
        },
        tags.buildRenameTagButton(),
        tags.buildDeleteTagsButton(),
      ],
    });
  }

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

app.view("home_register_puzzle_view", async ({ack, body, view}) => {
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
    values["puzzle_topic_input"],
    body.user.id);

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

app.action("home_rename_puzzle", async ({ ack, body }) => {
  const allPuzzles = await puzzles.list();

  const options = [];
  for (const puzzle of allPuzzles) {
    const option: Option = {
      text: {
        type: "plain_text",
        text: puzzle.name,
      },
      value: String(puzzle.id),
    };
    options.push(option);
  }

  const blocks: Array<KnownBlock | Block> = [];
  if (options.length > 0) {
    blocks.push(
      {
        type: "input",
        "block_id": "puzzle_id_input",
        label: {
          type: "plain_text",
          text: "Puzzle",
        },
        element: {
          type: "static_select",
          options,
          "initial_option": options[0],
        },
      },
    );
    blocks.push({
      type: "input",
      "block_id": "puzzle_name_input",
      label: {
        type: "plain_text",
        text: "New puzzle name",
      },
      element: {
        type: "plain_text_input",
        placeholder: {
          type: "plain_text",
          text: "Enter puzzle name",
        },
      },
    });
    blocks.push({
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
          text: "Enter puzzle URL (or omit to leave URL unchanged)",
        },
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No puzzles yet exist.",
      },
    });
  }

  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "home_rename_puzzle_view",
      title: {
        type: "plain_text",
        text: "Rename puzzle",
      },
      blocks,
      submit: {
        type: "plain_text",
        text: "Rename puzzle",
      },
    },
  });
  ack();
});

app.view("home_rename_puzzle_view", async ({ack, body, view}) => {
  const values = getViewStateValues(view);

  const renameError = await puzzles.rename(
    values["puzzle_id_input"],
    values["puzzle_name_input"],
    values["puzzle_url_input"],
    body.user.id);

  if (renameError) {
    ack({
      "response_action": "errors",
      errors: {
        "puzzle_name_input": renameError,
      },
    } as any);
    return;
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

app.action("home_help", async ({ ack }) => {
  ack();
});

app.action("home_join_channel", async ({ ack, payload }) => {
  const value = JSON.parse((payload as ButtonAction).value);
  const puzzleId = value.puzzleId;
  const userId = value.userId;

  await app.client.conversations.invite({
    token: process.env.SLACK_USER_TOKEN,
    channel: puzzleId,
    users: userId,
  });

  ack();
});
