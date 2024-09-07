import { app } from "./app";
import { PuzzleMetadataErrorField } from "./puzzles";
import * as puzzles from "./puzzles";
import { getViewStateValues } from "./slack_util";
import * as tags from "./tags";

export function buildAllowDuplicatePuzzleURLBlock() {
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

export async function openRegisterPuzzleDialog(
    triggerId: string, name?: string, url?: string) {
  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": triggerId,
    view: {
      type: "modal",
      "callback_id": "register_puzzle_view",
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
            "initial_value": name || "",
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
            "initial_value": url || "",
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
}

app.view("register_puzzle_view", async ({ack, body, view}) => {
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
