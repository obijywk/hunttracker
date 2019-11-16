import { app } from "./app";
import * as puzzles from "./puzzles";
import { getViewStateValues } from "./slack_util";
import * as solves from "./solves";

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
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: ":new: Register Puzzle"
              },
              "action_id": "home_register_puzzle",
            },
          ],
        },
      ]
    }
  });
}

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