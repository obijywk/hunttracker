import Anthropic from "@anthropic-ai/sdk";
import { TextBlockParam, ImageBlockParam } from "@anthropic-ai/sdk/resources";

import { PuzzleContentItem } from "./hunt_site_scraper";
import { getPuzzleContent, setTopic } from "./puzzles";
import * as taskQueue from "./task_queue";

const anthropic = new Anthropic();

export async function scheduleSummarizePuzzleContent(id: string): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY && process.env.ENABLE_AI_TOPICS) {
    await taskQueue.scheduleTask("summarize_puzzle_content", {id});
  }
}

taskQueue.registerHandler("summarize_puzzle_content", async (client, payload) => {
  const puzzleId = payload.id;
  const content = await getPuzzleContent(puzzleId);
  if (!content || content.length === 0) {
    return;
  }
  let summary = await summarizePuzzleContent(content);
  if (!summary) {
    return;
  }
  if (summary.length > 245) {
    summary = summary.substring(0, 245);
  }
  await setTopic(puzzleId, "[AI] " + summary);
});

export async function summarizePuzzleContent(
    content: Array<PuzzleContentItem>): Promise<string> {
  const messageContent: (TextBlockParam | ImageBlockParam)[] = [
    ...(content as (TextBlockParam | ImageBlockParam)[]),
    {
      "type": "text",
      "text": `
        Summarize the puzzle content above.
        Provide an objective description of the content.
        Do not say anything about how to solve the puzzle, or what the likely solving
        steps might be.
        This summary should be very short, no longer than 100 characters.
        Output within <summary></summary> tags.`,
    },
  ];

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL_NAME ? process.env.ANTHROPIC_MODEL_NAME : "claude-3-5-sonnet-20241022",
    max_tokens: 50,
    stop_sequences: ["</summary>"],
    messages: [
      {
        "role": "user",
        "content": messageContent,
      },
      {
        "role": "assistant",
        "content": "<summary>",
      },
    ],
  });

  let responseText = "";
  for (const block of response.content) {
    if (block.type === "text") {
      responseText += " " + block.text;
    }
  }
  responseText = responseText.replaceAll("</?summary>", "");
  return responseText.trim();
}