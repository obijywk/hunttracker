import * as nodeEmoji from "node-emoji";

import * as puzzles from "./puzzles";

export interface PuzzleStatusEmoji {
  slackEmoji: string;
  unicodeEmoji: string;
  description: string;
}

function makePuzzleStatusEmoji(slackEmoji: string, description: string): PuzzleStatusEmoji {
  return {
    slackEmoji,
    unicodeEmoji: nodeEmoji.get(slackEmoji.substring(1, slackEmoji.length - 1)),
    description,
  };
}

export function getPuzzleStatusEmoji(puzzle: puzzles.Puzzle): PuzzleStatusEmoji {
  if (puzzle.complete) {
    return makePuzzleStatusEmoji(
      ":white_check_mark:",
      "Solved");
  }
  const priority = puzzles.getPriority(puzzle);
  if (priority >= 5) {
    return makePuzzleStatusEmoji(
      ":exclamation:",
      "High priority");
  }
  if (priority < 0) {
    return makePuzzleStatusEmoji(
      ":skull:",
      "Low priority");
  }
  if (puzzle.registrationTimestamp === undefined) {
    return makePuzzleStatusEmoji(
      ":question:",
      "Unknown puzzle");
  }
  if (puzzles.isNew(puzzle)) {
    return makePuzzleStatusEmoji(
      ":new:",
      `Registered less than ${puzzles.newPuzzleMinutes} minutes ago`);
  }
  if (puzzle.users.length == 0) {
    return makePuzzleStatusEmoji(
      ":desert:",
      "No solvers");
  }
  const idleDuration = puzzles.getIdleDuration(puzzle);
  if (idleDuration.asMinutes() < 15) {
    return makePuzzleStatusEmoji(
      ":memo:",
      "Active within last 15 minutes");
  }
  if (idleDuration.asMinutes() < 60) {
    return makePuzzleStatusEmoji(
      ":thinking_face:",
      "Inactive for 15 to 60 minutes");
  }
  if (idleDuration.asMinutes() < 180) {
    return makePuzzleStatusEmoji(
      ":turtle:",
      "Inactive for 1 to 3 hours");
  }
  return makePuzzleStatusEmoji(
    ":zzz:",
    "Inactive for more than 3 hours");
}
