import moment = require("moment");
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
  // Only present when associated with a puzzle.
  applied?: moment.Moment;
}

export async function list(): Promise<Array<Tag>> {
  const result = await db.query("SELECT id, name FROM tags ORDER BY name ASC");
  return result.rows;
}

export function buildTagsBlock(puzzleId: string, tags: Array<Tag>) {
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
      "url": encodeURI(process.env.WEB_SERVER_URL + "puzzles?tags=" + tag.name),
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

export function buildUpdateTagsButton(puzzleId: string) {
  return {
    "type": "button",
    "text": {
      "type": "plain_text",
      "text": ":bookmark: Update tags",
    },
    "action_id": "tags_update",
    "value": puzzleId,
  };
}

export function buildRenameTagButton() {
  return {
    "type": "button",
    "text": {
      "type": "plain_text",
      "text": ":bookmark: Rename tag",
    },
    "action_id": "tags_rename",
  };
}

export function buildDeleteTagsButton() {
  return {
    "type": "button",
    "text": {
      "type": "plain_text",
      "text": ":bookmark: Delete tags",
    },
    "action_id": "tags_delete",
  };
}

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
        text: "Update tags",
      },
      blocks: await buildUpdateTagsBlocks(puzzleId),
      submit: {
        type: "plain_text",
        text: "Update tags",
      },
    },
  });

  ack();
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
      client.query("INSERT INTO puzzle_tag (puzzle_id, tag_id, applied) VALUES ($1, $2, NOW())", [puzzleId, newTag]);
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

export async function addAndRemoveTags(
  puzzleIds: Array<string>,
  addedTagIds: Array<number>,
  addedTagNames: Array<string>,
  removedTagIds: Array<number>,
) {
  const createdTagIds = [];
  for (const addedTagName of addedTagNames) {
    const newTagResult = await db.query(`
      INSERT INTO tags (name) VALUES ($1)
      ON CONFLICT (name) DO UPDATE SET name = $1
      RETURNING id
    `, [addedTagName]);
    if (newTagResult.rowCount > 0) {
      createdTagIds.push(newTagResult.rows[0].id);
    }
  }
  const allAddedTagIds = addedTagIds.concat(createdTagIds);

  for (const puzzleId of puzzleIds) {
    for (const tagId of allAddedTagIds) {
      db.query(`
        INSERT INTO puzzle_tag (puzzle_id, tag_id, applied) VALUES ($1, $2, NOW())
        ON CONFLICT DO NOTHING
      `, [puzzleId, tagId]);
    }
    for (const tagId of removedTagIds) {
      db.query("DELETE FROM puzzle_tag WHERE puzzle_id = $1 AND tag_id = $2", [puzzleId, tagId]);
    }
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: puzzleId,
    });
  }
}

export interface UpdateTagsViewStateValues {
  selectedTagIds?: Array<number>;
  newTagNames?: Array<string>;
  errors?: { [key: string]: string };
}

export function getUpdateTagsViewStateValues(viewStateValues: any): UpdateTagsViewStateValues {
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
  const selectedTags = getUpdateTagsViewStateValues(viewStateValues);

  if (selectedTags.errors) {
    ack({
      "response_action": "errors",
      errors: selectedTags.errors,
    } as any);
    return;
  }

  updateTagsWithTransaction(puzzleId, selectedTags.selectedTagIds, selectedTags.newTagNames);

  await taskQueue.scheduleTask("refresh_puzzle", {
    id: puzzleId,
  });

  ack();
});

async function buildRenameTagBlocks() {
  const tags = await db.query(`
    SELECT
      id,
      name
    FROM tags
    ORDER BY name ASC
  `);

  const options = [];
  for (const tag of tags.rows) {
    const option: Option = {
      text: {
        type: "plain_text",
        text: tag.name,
      },
      value: String(tag.id),
    };
    options.push(option);
  }

  const blocks: Array<KnownBlock | Block> = [];
  if (options.length > 0) {
    blocks.push(
      {
        type: "input",
        "block_id": "tag_input",
        label: {
          type: "plain_text",
          text: "Tag",
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
      "block_id": "new_tag_name_input",
      label: {
        type: "plain_text",
        text: "New tag name",
      },
      element: {
        type: "plain_text_input",
        placeholder: {
          type: "plain_text",
          text: "Enter new tag name",
        },
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No tags yet exist.",
      },
    });
  }
  return blocks;
}

app.action("tags_rename", async ({ ack, body }) => {
  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "tags_rename_view",
      title: {
        type: "plain_text",
        text: "Rename tag",
      },
      blocks: await buildRenameTagBlocks(),
      submit: {
        type: "plain_text",
        text: "Rename tag",
      },
    },
  });
  ack();
});

app.view("tags_rename_view", async ({ack, body, view}) => {
  const values = getViewStateValues(view);

  if (values["tag_input"] === undefined) {
    ack();
    return;
  }
  const selectedTagId = Number(values["tag_input"]);

  if (values["new_tag_name_input"] === undefined) {
    ack();
    return;
  }
  const newTagName = values["new_tag_name_input"].trim();
  if (newTagName.match(/[^a-z0-9-/]/g)) {
    ack({
      "response_action": "errors",
      errors: {
        "new_tag_name_input": "Tags may only contain lowercase letters, numbers, dashes, and forward slashes.",
      },
    } as any);
    return;
  }

  await db.query(`
    UPDATE tags
    SET name = $2
    WHERE id = $1
  `, [selectedTagId, newTagName]);

  const puzzleIdsResult = await db.query(`
    SELECT puzzle_id FROM puzzle_tag WHERE tag_id = $1
  `, [selectedTagId]);

  for (const row of puzzleIdsResult.rows) {
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: row["puzzle_id"],
    });
  }

  await taskQueue.scheduleTask("publish_home", {
    userId: body.user.id,
  });

  ack();
});

async function buildDeleteTagsBlocks() {
  const tags = await db.query(`
    SELECT
      id,
      name
    FROM tags
    ORDER BY name ASC
  `);

  const options = [];
  for (const tag of tags.rows) {
    const option: Option = {
      text: {
        type: "plain_text",
        text: tag.name,
      },
      value: String(tag.id),
    };
    options.push(option);
  }

  const blocks: Array<KnownBlock | Block> = [];
  if (options.length > 0) {
    blocks.push(
      {
        type: "input",
        "block_id": "tags_input",
        label: {
          type: "plain_text",
          text: "Tags",
        },
        element: {
          type: "multi_static_select",
          options,
          placeholder: {
            type: "plain_text",
            text: "Select tags",
          },
        },
      },
    );
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No tags yet exist.",
      },
    });
  }
  return blocks;
}

app.action("tags_delete", async ({ ack, body }) => {
  await app.client.views.open({
    token: process.env.SLACK_BOT_TOKEN,
    "trigger_id": (body as any).trigger_id,
    view: {
      type: "modal",
      "callback_id": "tags_delete_view",
      title: {
        type: "plain_text",
        text: "Delete tags",
      },
      blocks: await buildDeleteTagsBlocks(),
      submit: {
        type: "plain_text",
        text: "Delete tags",
      },
    },
  });
  ack();
});

app.view("tags_delete_view", async ({ack, body, view}) => {
  const values = getViewStateValues(view);

  if (values["tags_input"] === undefined) {
    ack();
    return;
  }
  const selectedTagIds = values["tags_input"].map(Number);

  const puzzleIdsResult = await db.query(`
    SELECT puzzle_id FROM puzzle_tag WHERE tag_id = ANY($1)
  `, [selectedTagIds]);

  await db.query("DELETE FROM puzzle_tag WHERE tag_id = ANY($1)", [selectedTagIds]);
  await db.query("DELETE FROM tags WHERE id = ANY($1)", [selectedTagIds]);

  for (const row of puzzleIdsResult.rows) {
    await taskQueue.scheduleTask("refresh_puzzle", {
      id: row["puzzle_id"],
    });
  }

  await taskQueue.scheduleTask("publish_home", {
    userId: body.user.id,
  });

  ack();
});
