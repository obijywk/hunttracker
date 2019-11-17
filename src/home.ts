import { app } from "./app";
import * as puzzles from "./puzzles";
import { getViewStateValues } from "./slack_util";
import * as solves from "./solves";

const maxUsersToList = 5;
const maxSolvesToList = 30;

function buildSolveBlocks(solve: solves.Solve, userId: string) {
  let text = `:left_speech_bubble: <${process.env.SLACK_URL_PREFIX}${solve.id}|${solve.puzzle.name}>`;
  const idleStatus = solves.buildIdleStatus(solve);
  if (idleStatus) {
    text += "   " + idleStatus;
  }
  if (solve.channelTopic) {
    text += `\n:mag_right: ${solve.channelTopic}`;
  }
  if (solve.users && solve.users.length > 0) {
    let users = solve.users.slice(0, maxUsersToList).map(u => u.name).join(", ");
    if (solve.users.length > maxUsersToList) {
      users += " \u{2026}";
    }
    text += `\n:man-woman-girl-boy: (${solve.users.length}) ${users}`;
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    },
  ];
}

async function buildHomeBlocks(userId: string) {
  const allSolves = await solves.list();
  allSolves.sort((a, b) => {
    const joinedA = a.users.map(u => u.id).indexOf(userId) !== -1;
    const joinedB = b.users.map(u => u.id).indexOf(userId) !== -1;
    if (joinedA && !joinedB) {
      return -1;
    } else if (!joinedA && joinedB) {
      return 1;
    }
    return solves.getIdleDuration(b).subtract(solves.getIdleDuration(a)).asMilliseconds();
  });
  const blocks: Array<any> = [{
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: ":sparkles: Register Puzzle"
        },
        "action_id": "home_register_puzzle",
      },
    ],
  }];
  for (const solve of allSolves.slice(0, maxSolvesToList)) {
    blocks.push({
      type: "divider"
    });
    blocks.push(...buildSolveBlocks(solve, userId));
  }
  blocks.push({
    type: "divider"
  });
  if (allSolves.length > maxSolvesToList) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "There are too many puzzles to show here! Visit TODO add link to see more."
      },
    });
  }
  return blocks;
}

export async function publish(userId: string) {
  try {
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
      }
    });
  } catch (e) {
    console.log(e.data.response_metadata.messages);
    throw e;
  }
}

app.event("app_home_opened", async ({ event }) => {
  await publish(event.user);
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
        text: "Register Puzzle"
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
          }
        },
        {
          type: "input",
          "block_id": "puzzle_url_input",
          label: {
            type: "plain_text",
            text: "Puzzle URL",
          },
          element: {
            type: "plain_text_input",
          }
        },
      ],
      submit: {
        type: "plain_text",
        text: "Register Puzzle",
      },
    }
  });
});

app.view("home_register_puzzle_view", async ({ack, view}) => {
  ack();
  const values = getViewStateValues(view);
  const puzzleId = await puzzles.create(values["puzzle_name_input"], values["puzzle_url_input"]);
  await solves.create(puzzleId);
});