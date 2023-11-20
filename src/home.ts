import { ButtonAction, ViewErrorsResponseAction } from "@slack/bolt";
import { Block, Button, KnownBlock, Option } from "@slack/types";

import { app } from "./app";
import * as puzzles from "./puzzles";
import { PuzzleMetadataErrorField, findChannelIdForChannelName } from "./puzzles";
import { getPuzzleStatusEmoji } from "./puzzle_status_emoji";
import { MAX_NUM_OPTIONS, getViewStateValues } from "./slack_util";
import * as tags from "./tags";
import * as taskQueue from "./task_queue";
import * as users from "./users";

const maxUsersToList = 5;
const maxPuzzlesToList = 95;

function buildPuzzleBlocks(puzzle: puzzles.Puzzle, userId: string) {
  let text = getPuzzleStatusEmoji(puzzle).slackEmoji;
  text += ` <slack://channel?team=${process.env.SLACK_TEAM_ID}&id=${puzzle.id}|${puzzle.name}>`;
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

  const tagLinks = tags.buildTagLinks(puzzle.tags);
  if (tagLinks.length > 0) {
    text += `\n${tagLinks}`;
  }

  text += "\n\u{00A0}";

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

  return blocks;
}

async function buildHomeBlocks(userId: string) {
  const isAdminPromise = users.isAdmin(userId);

  const allPuzzles = await puzzles.list({ excludeComplete: true });
  allPuzzles.sort((a, b) => {
    const joinedA = a.users.map(u => u.id).indexOf(userId) !== -1;
    const joinedB = b.users.map(u => u.id).indexOf(userId) !== -1;
    if (joinedA && !joinedB) {
      return 1;
    } else if (!joinedA && joinedB) {
      return -1;
    }

    const aPriority = puzzles.getPriority(a);
    const bPriority = puzzles.getPriority(b);
    if (aPriority > bPriority) {
      return -1;
    } else if (bPriority > aPriority) {
      return 1;
    }

    const aNew = puzzles.isNew(a);
    const bNew = puzzles.isNew(b);
    if (aNew && !bNew) {
      return -1;
    } else if (!aNew && bNew) {
      return 1;
    }

    const aHasUsers = a.users.length > 0;
    const bHasUsers = b.users.length > 0;
    if (aHasUsers && !bHasUsers) {
      return -1;
    } else if (bHasUsers && !aHasUsers) {
      return 1;
    }

    return puzzles.getIdleDuration(a).subtract(puzzles.getIdleDuration(b)).asMilliseconds();
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
        text: ":jigsaw: Puzzles",
      },
      "action_id": "home_nav_puzzles",
      url: process.env.WEB_SERVER_URL + "puzzles",
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: ":the_horns: Metas",
      },
      "action_id": "home_nav_metas",
      url: process.env.WEB_SERVER_URL + "metas",
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: ":door: Locations",
      },
      "action_id": "home_nav_locations",
      url: process.env.WEB_SERVER_URL + "locations",
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: ":bookmark: Update tags",
      },
      "action_id": "home_nav_tagger",
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
            text: ":pencil2: Edit puzzle",
          },
          "action_id": "home_edit_puzzle",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: ":axe: Delete puzzle",
          },
          "action_id": "home_delete_puzzle",
        },
        tags.buildRenameTagButton(),
        tags.buildDeleteTagsButton(),
      ],
    });
  }

  blocks.push({
    type: "divider",
  });

  for (const puzzle of allPuzzles.slice(0, maxPuzzlesToList)) {
    blocks.push(...buildPuzzleBlocks(puzzle, userId));
  }

  if (allPuzzles.length > maxPuzzlesToList) {
    blocks.push({
      type: "divider",
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `There are too many open puzzles to show here! Visit <${process.env.WEB_SERVER_URL}puzzles?solved=unsolved> to see more.`,
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

function buildAllowDuplicatePuzzleURLBlock() {
  return {
    type: "input",
    "block_id": "puzzle_url_allow_duplicate_input",
    optional: true,
    label: {
      type: "plain_text",
      text: "Puzzle URL options",
    },
    element: {
      type: "checkboxes",
      options: [
        {
          text: {
            type: "plain_text",
            text: "Allow this to be a puzzle URL that's already been used",
          },
          value: "puzzle_url_allow_duplicate",
        },
      ],
    },
  };
}

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
        buildAllowDuplicatePuzzleURLBlock(),
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
    values["puzzle_url_allow_duplicate_input"].length > 0,
    selectedTags.selectedTagIds,
    selectedTags.newTagNames,
    values["puzzle_topic_input"],
    body.user.id);

  if (createError) {
    const errors: any = {};
    switch (createError.field) {
      case PuzzleMetadataErrorField.Name:
        errors["puzzle_name_input"] = createError.message;
        break;
      case PuzzleMetadataErrorField.Url:
        errors["puzzle_url_input"] = createError.message;
        break;
    }
    ack({
      "response_action": "errors",
      errors,
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

function buildPuzzleSelectionFormBlocks(allPuzzles: puzzles.Puzzle[]) {
  let puzzlesOmitted = false;
  if (allPuzzles.length >= MAX_NUM_OPTIONS) {
    puzzlesOmitted = true;
    allPuzzles = allPuzzles.slice(0, MAX_NUM_OPTIONS - 1);
  }

  const options = [];
  if (puzzlesOmitted) {
    const option: Option = {
      text: {
        type: "plain_text",
        text: "Other (enter puzzle channel name below)",
      },
      value: String("!other"),
    };
    options.push(option);
  }
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
    if (puzzlesOmitted) {
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Puzzle options have been omitted because more than ${MAX_NUM_OPTIONS} puzzles exist.`,
          },
        },
      );
    }
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
    if (puzzlesOmitted) {
      blocks.push({
        type: "input",
        "block_id": "other_puzzle_channel_name_input",
        optional: true,
        label: {
          type: "plain_text",
          text: "Puzzle channel name",
        },
        element: {
          type: "plain_text_input",
          placeholder: {
            type: "plain_text",
            text: "Enter puzzle channel name (only if 'Other' is selected above)",
          },
        },
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No puzzles yet exist.",
      },
    });
  }
  return blocks;
}

app.action("home_edit_puzzle", async ({ ack, body }) => {
  const allPuzzles = await puzzles.list();
  const blocks = buildPuzzleSelectionFormBlocks(allPuzzles);
  if (allPuzzles.length > 0) {
    blocks.push({
      type: "input",
      "block_id": "puzzle_name_input",
      optional: true,
      label: {
        type: "plain_text",
        text: "Puzzle name",
      },
      element: {
        type: "plain_text_input",
        placeholder: {
          type: "plain_text",
          text: "Enter puzzle name (or omit to leave name unchanged)",
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
    blocks.push(buildAllowDuplicatePuzzleURLBlock());
  }

  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "home_edit_puzzle_view",
      title: {
        type: "plain_text",
        text: "Edit puzzle",
      },
      blocks,
      submit: {
        type: "plain_text",
        text: "Edit puzzle",
      },
    },
  });
  ack();
});

async function getPuzzleIdFromPuzzleSelectionForm(values: any): Promise<string | ViewErrorsResponseAction> {
  let puzzleId = values["puzzle_id_input"];
  if (puzzleId === "!other") {
    const channelNameInput = values["other_puzzle_channel_name_input"];
    if (channelNameInput != "") {
      puzzleId = await findChannelIdForChannelName(channelNameInput);
      if (puzzleId === null) {
        return {
          "response_action": "errors",
          "errors": {
            "other_puzzle_channel_name_input": "No channel found with this name.",
          },
        };
      }
    } else {
      return {
        "response_action": "errors",
        "errors": {
          "other_puzzle_channel_name_input": "You must provide a channel name.",
        },
      };
    }
  }
  return puzzleId;
}

app.view("home_edit_puzzle_view", async ({ack, body, view}) => {
  const values = getViewStateValues(view);
  const puzzleIdResult = await getPuzzleIdFromPuzzleSelectionForm(values);
  if (typeof puzzleIdResult !== "string") {
    ack(puzzleIdResult);
    return;
  }
  const puzzleId = puzzleIdResult;

  const editError = await puzzles.edit(
    puzzleId,
    values["puzzle_name_input"],
    values["puzzle_url_input"],
    values["puzzle_url_allow_duplicate_input"].length > 0,
    body.user.id);

  if (editError) {
    const errors: any = {};
    switch (editError.field) {
      case PuzzleMetadataErrorField.Name:
        errors["puzzle_name_input"] = editError.message;
        break;
      case PuzzleMetadataErrorField.Url:
        errors["puzzle_url_input"] = editError.message;
        break;
    }
    ack({
      "response_action": "errors",
      errors,
    } as any);
    return;
  }

  ack();
});

app.action("home_delete_puzzle", async ({ ack, body }) => {
  const allPuzzles = await puzzles.list();
  const blocks = buildPuzzleSelectionFormBlocks(allPuzzles);
  if (allPuzzles.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Clicking \"Delete puzzle\" below will permanently delete the selected puzzle. *This cannot be undone!* Double-check you've selected the intended puzzle before proceeding.",
      },
    });
  }

  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "home_delete_puzzle_view",
      title: {
        type: "plain_text",
        text: "Delete puzzle",
      },
      blocks,
      submit: {
        type: "plain_text",
        text: "Delete puzzle",
      },
    },
  });
  ack();
});

app.view("home_delete_puzzle_view", async ({ack, body, view}) => {
  const values = getViewStateValues(view);
  const puzzleIdResult = await getPuzzleIdFromPuzzleSelectionForm(values);
  if (typeof puzzleIdResult !== "string") {
    ack(puzzleIdResult);
    return;
  }
  const puzzleId = puzzleIdResult;
  await puzzles.deletePuzzle(puzzleId, body.user.id);
  ack();
});

app.action("home_nav_puzzles", async ({ ack }) => {
  ack();
});

app.action("home_nav_metas", async ({ ack }) => {
  ack();
});

app.action("home_nav_locations", async ({ ack }) => {
  ack();
});

app.action("home_nav_tagger", async ({ ack }) => {
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
