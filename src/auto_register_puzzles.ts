import { app } from "./app";
import * as diacritics from "diacritics";
import * as db from "./db";
import * as huntSiteScraper from "./hunt_site_scraper";
import * as nodeEmoji from "node-emoji";
import * as puzzles from "./puzzles";
import { openRegisterPuzzleDialog } from "./register_puzzle";
import { getSlackActionValue } from "./slack_util";
import * as taskQueue from "./task_queue";

function getRegistrationConfirmationChannel(): string | null {
  if (process.env.SLACK_ADMIN_CHANNEL_ID) {
    return process.env.SLACK_ADMIN_CHANNEL_ID;
  }
  if (process.env.SLACK_SOLVE_ANNOUNCEMENT_CHANNEL_NAME) {
    return `#${process.env.SLACK_SOLVE_ANNOUNCEMENT_CHANNEL_NAME}`;
  }
  if (process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME) {
    return `#${process.env.SLACK_ACTIVITY_LOG_CHANNEL_NAME}`;
  }
  return null;
}

function normalizeStringForBlockId(s: string): string {
  s = nodeEmoji.unemojify(s);
  return diacritics.remove(s)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

async function sendRegistrationConfirmation(puzzleLink: huntSiteScraper.PuzzleLink) {
  await app.client.chat.postMessage({
    token: process.env.SLACK_USER_TOKEN,
    channel: getRegistrationConfirmationChannel(),
    text: `A new puzzle <${puzzleLink.url}|${puzzleLink.name}> is available.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `A new puzzle <${puzzleLink.url}|${puzzleLink.name}> is available.`,
        },
      },
      {
        type: "actions",
        block_id: `register_puzzle_confirmation_${normalizeStringForBlockId(puzzleLink.name)}`,
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Register",
            },
            style: "primary",
            value: JSON.stringify(puzzleLink),
            action_id: "auto_register_puzzle_confirm",
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Dismiss",
            },
            action_id: "auto_register_puzzle_cancel",
          },
        ],
      },
    ],
  });
}

app.action("auto_register_puzzle_confirm", async ({ ack, body, respond }) => {
  const puzzleLink = JSON.parse(getSlackActionValue(body, "auto_register_puzzle_confirm")) as huntSiteScraper.PuzzleLink;
  await openRegisterPuzzleDialog(
    (body as any).trigger_id,
    puzzleLink.name,
    puzzleLink.url);
  respond({ delete_original: true });
  ack();
});

app.action("auto_register_puzzle_cancel", async ({ ack, body, respond }) => {
  respond({ delete_original: true });
  ack();
});

export async function scheduleAutoRegisterPuzzles(): Promise<void> {
  if (process.env.ENABLE_AUTO_REGISTER_PUZZLES) {
    await taskQueue.scheduleTask("auto_register_puzzles", {});
  }
}

taskQueue.registerHandler("auto_register_puzzles", async (client, _) => {
  if (getRegistrationConfirmationChannel() === null) {
    return;
  }

  const puzzleLinksPromise = huntSiteScraper.scrapePuzzleList({ client });
  const autoRegisterNotifiedPuzzlesPromise = db.query(
    "SELECT url FROM auto_register_notified_puzzles", [], client);
  const registeredPuzzleUrls = new Set((await puzzles.list({ client })).map(p => p.url));
  const autoRegisterNotifiedUrls = new Set<string>(
    (await autoRegisterNotifiedPuzzlesPromise).rows.map(r => r.url));
  const puzzleLinks = await puzzleLinksPromise;

  for (const puzzleLink of puzzleLinks) {
    if (!registeredPuzzleUrls.has(puzzleLink.url) &&
      !autoRegisterNotifiedUrls.has(puzzleLink.url)) {
      await db.query(
        "INSERT INTO auto_register_notified_puzzles (url) VALUES ($1)",
        [puzzleLink.url],
        client);
      await sendRegistrationConfirmation(puzzleLink);
    }
  }
});