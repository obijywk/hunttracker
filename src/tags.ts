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
  if (options.length > 0) {
    blocks.push(
      {
        type: "input",
        "block_id": "previously_used_tags_input",
        optional: true,
        label: {
          type: "plain_text",
          text: "Previously used tags",
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
  blocks.push({
    type: "input",
    "block_id": "new_tags_input",
    optional: true,
    label: {
      type: "plain_text",
      text: "New tags",
    },
    hint: {
      type: "plain_text",
      text: "Enter tags that have not yet been introduced, separated by commas. Tags may not contain spaces.",
    },
    element: {
      type: "plain_text_input",
      placeholder: {
        type: "plain_text",
        text: "Enter tags",
      },
    },
  });

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

  const values = getViewStateValues(view);
  let newTagIds = new Set();
  if (values["previously_used_tags_input"]) {
    newTagIds = new Set(values["previously_used_tags_input"].map(Number));
  }
  let newTagNames: Array<string> = [];
  if (values["new_tags_input"]) {
    newTagNames = values["new_tags_input"].split(",").map((s: string) => s.trim());
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    for (const newTagName of newTagNames) {
      const newTagResult = await client.query(`
        INSERT INTO tags (name) VALUES ($1)
        ON CONFLICT (name) DO UPDATE SET name = $1
        RETURNING id
      `, [newTagName]);
      if (newTagResult.rowCount > 0) {
        newTagIds.add(newTagResult.rows[0].id);
      }
    }

    const oldTagsResult = await client.query("SELECT tag_id FROM puzzle_tag WHERE puzzle_id = $1", [puzzleId]);
    const oldTagIds = new Set(oldTagsResult.rows.map(row => row.tag_id));

    for (const oldTag of oldTagIds) {
      if (!newTagIds.has(oldTag)) {
        client.query("DELETE FROM puzzle_tag WHERE puzzle_id = $1 AND tag_id = $2", [puzzleId, oldTag]);
      }
    }
    for (const newTag of newTagIds) {
      if (!oldTagIds.has(newTag)) {
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
