import { Block, KnownBlock } from "@slack/types";

import { app } from "./app";
import * as puzzles from "./puzzles";
import { getViewStateValues } from "./slack_util";
import * as tags from "./tags";

const maxUsersToList = 5;
const maxPuzzlesToList = 30;

function buildPuzzleBlocks(puzzle: puzzles.Puzzle, userId: string) {
  let text = `:eye-in-speech-bubble: <${process.env.SLACK_URL_PREFIX}${puzzle.id}|${puzzle.name}>`;
  const idleStatus = puzzles.buildIdleStatus(puzzle);
  if (idleStatus) {
    text += "   " + idleStatus;
  }
  if (puzzle.channelTopic) {
    text += `\n:mag_right: ${puzzle.channelTopic}`;
  }
  if (puzzle.users && puzzle.users.length > 0) {
    let users = puzzle.users.slice(0, maxUsersToList).map(u => u.name).join(", ");
    if (puzzle.users.length > maxUsersToList) {
      users += " \u{2026}";
    }
    text += `\n:man-woman-girl-boy: (${puzzle.users.length}) ${users}`;
  }

  const blocks: Array<Block | KnownBlock> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    },
  ];

  const tagsBlock = tags.buildTagsBlock(puzzle.id, puzzle.tags, false);
  if (tagsBlock) {
    blocks.push(tagsBlock);
  }

  return blocks;
}

async function buildHomeBlocks(userId: string) {
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
  const blocks: Array<any> = [{
    type: "actions",
    elements: [
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
          text: ":sparkles: Register Puzzle",
        },
        "action_id": "home_register_puzzle",
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: ":link: See All Puzzles",
        },
        "action_id": "home_see_all_puzzles",
        url: process.env.WEB_SERVER_URL + "puzzles",
      },
    ],
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

app.event("app_home_opened", async ({ event }) => {
  await publish(event.user);
});

app.action("home_refresh", async ({ ack, body }) => {
  ack();
  await publish(body.user.id);
});

app.action("home_register_puzzle", async ({ ack, body }) => {
  ack();
  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "home_register_puzzle_view",
      title: {
        type: "plain_text",
        text: "Register Puzzle",
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
      ],
      submit: {
        type: "plain_text",
        text: "Register Puzzle",
      },
    },
  });
});

app.view("home_register_puzzle_view", async ({ack, view}) => {
  ack();
  const values = getViewStateValues(view);
  const selectedTags = tags.getTagsFromViewStateValues(values);
  await puzzles.create(
    values["puzzle_name_input"],
    values["puzzle_url_input"],
    selectedTags.selectedTagIds,
    selectedTags.newTagNames);
});

app.action("home_see_all_puzzles", async ({ ack }) => {
  ack();
});
