import { PoolClient } from "pg";
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

export async function buildUpdateTagsBlocks(puzzleId: string) {
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
      text: "Enter tags that have not yet been introduced, separated by spaces.",
    },
    element: {
      type: "plain_text_input",
      placeholder: {
        type: "plain_text",
        text: "Enter tags",
      },
    },
  });
  return blocks;
}

app.action("tags_update", async ({ ack, body, payload }) => {
  ack();
  const puzzleId = (payload as ButtonAction).value;

  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "tags_update_view",
      "private_metadata": JSON.stringify({ puzzleId }),
      title: {
        type: "plain_text",
        text: "Update Tags",
      },
      blocks: await buildUpdateTagsBlocks(puzzleId),
      submit: {
        type: "plain_text",
        text: "Submit",
      },
    },
  });
});

export async function updateTags(puzzleId: string, selectedTagIds: Array<number>, newTagNames: Array<string>, client: PoolClient) {
  const newTagIds = new Set(selectedTagIds);
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
}

export async function updateTagsWithTransaction(puzzleId: string, selectedTagIds: Array<number>, newTagNames: Array<string>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await updateTags(puzzleId, selectedTagIds, newTagNames, client);
    await client.query("COMMIT");
  } catch (e) {
    console.error(`Failed to sync tags for puzzle ${puzzleId}`, e);
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface TagViewStateValues {
  selectedTagIds?: Array<number>;
  newTagNames?: Array<string>;
  errors?: { [key: string]: string };
}

export function getTagsFromViewStateValues(viewStateValues: any): TagViewStateValues {
  let selectedTagIds = [];
  if (viewStateValues["previously_used_tags_input"]) {
    selectedTagIds = viewStateValues["previously_used_tags_input"].map(Number);
  }
  let newTagNames: Array<string> = [];
  if (viewStateValues["new_tags_input"]) {
    newTagNames = viewStateValues["new_tags_input"]
      .split(" ")
      .filter((s: string) => s.length > 0)
      .map((s: string) => s.trim());
  }
  for (const tagName of newTagNames) {
    if (tagName.match(/[^a-z0-9-/]/g)) {
      return {
        errors: {
          "new_tags_input": "Tags may only contain lowercase letters, numbers, dashes, and forward slashes.",
        },
      };
    }
  }
  return {
    selectedTagIds,
    newTagNames,
  };
}

app.view("tags_update_view", async ({ack, view, body}) => {
  const puzzleId = JSON.parse(body.view.private_metadata)["puzzleId"] as string;
  const viewStateValues = getViewStateValues(view);
  const selectedTags = getTagsFromViewStateValues(viewStateValues);

  if (selectedTags.errors) {
    ack({
      "response_action": "errors",
      errors: selectedTags.errors,
    } as any);
    return;
  }
  ack();

  updateTagsWithTransaction(puzzleId, selectedTags.selectedTagIds, selectedTags.newTagNames);

  await taskQueue.scheduleTask("refresh_puzzle", {
    id: puzzleId,
  });
});
