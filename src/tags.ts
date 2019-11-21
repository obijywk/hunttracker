import { ButtonAction } from "@slack/bolt";
import { Block, KnownBlock, Option } from "@slack/types";

import { app } from "./app";
import * as db from "./db";
import { getViewStateValues } from "./slack_util";
import * as taskQueue from "./task_queue";

export interface Tag {
  id: number;
  name: string;
}

export function buildTagsBlock(puzzleId: string, tags: Array<Tag>, editable: boolean) {
  const tagButtons = [];
  for (const tag of tags) {
    tagButtons.push({
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": `:label: ${tag.name}`,
      },
      "action_id": `tags_click_${tag.id}`,
      "value": JSON.stringify({ puzzleId, tagId: tag.id }),
      "url": encodeURI(process.env.WEB_SERVER_URL + "tag?tag=" + tag.name),
    });
  }
  if (editable) {
    tagButtons.push({
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": ":pencil2: Update Tags",
      },
      "action_id": "tags_update",
      "value": puzzleId,
    });
  }
  if (tagButtons.length === 0) {
    return null;
  }
  return {
    "type": "actions",
    "elements": tagButtons,
  };
}

app.action(/tags_click_.*/, async({ ack, payload, say }) => {
  ack();
});

app.action("tags_update", async ({ ack, body, payload }) => {
  ack();
  const puzzleId = (payload as ButtonAction).value;

  const tags = await db.query(`
    SELECT
      id,
      name,
      selected_tag_id.tag_id IS NOT NULL selected
    FROM tags
    LEFT JOIN (
      SELECT tag_id
      FROM puzzle_tag
      WHERE puzzle_id = $1
    ) selected_tag_id ON selected_tag_id.tag_id = id
    ORDER BY name ASC
  `, [puzzleId]);

  const options = [];
  const initialOptions = [];
  for (const tag of tags.rows) {
    const option: Option = {
      text: {
        type: "plain_text",
        text: tag.name,
      },
      value: String(tag.id),
    };
    options.push(option);
    if (tag.selected) {
      initialOptions.push(option);
    }
  }

  const blocks: Array<KnownBlock | Block> = [];
  if (options) {
    blocks.push(
      {
        type: "input",
        "block_id": "tags_input",
        optional: true,
        label: {
          type: "plain_text",
          text: "Tags",
        },
        element: {
          type: "multi_static_select",
          "initial_options": initialOptions.length > 0 ? initialOptions : undefined,
          options,
          placeholder: {
            type: "plain_text",
            text: "Select tags",
          },
        },
      },
    );
  }

  try {
  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "tags_update_view",
      "private_metadata": JSON.stringify({ puzzleId }),
      title: {
        type: "plain_text",
        text: "Update Tags"
      },
      blocks,
      submit: {
        type: "plain_text",
        text: "Submit",
      },
    }
  });
  } catch (e) {
    console.log(e.data.response_metadata.messages);
  }
});

app.view("tags_update_view", async ({ack, view, body}) => {
  ack();

  const puzzleId = JSON.parse(body.view.private_metadata)["puzzleId"] as string;
  const newTags = new Set(getViewStateValues(view)["tags_input"].map(Number));

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const oldTagsResult = await client.query("SELECT tag_id FROM puzzle_tag WHERE puzzle_id = $1", [puzzleId]);
    const oldTags = new Set(oldTagsResult.rows.map(row => row.tag_id));

    for (const oldTag of oldTags) {
      if (!newTags.has(oldTag)) {
        client.query("DELETE FROM puzzle_tag WHERE puzzle_id = $1 AND tag_id = $2", [puzzleId, oldTag]);
      }
    }
    for (const newTag of newTags) {
      if (!oldTags.has(newTag)) {
        client.query("INSERT INTO puzzle_tag (puzzle_id, tag_id) VALUES ($1, $2)", [puzzleId, newTag]);
      }
    }

    await client.query("COMMIT");
  } catch (e) {
    console.error(`Failed to sync tags for puzzle ${puzzleId}`, e);
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await taskQueue.scheduleTask("refresh_puzzle", {
    id: puzzleId,
  });
});
