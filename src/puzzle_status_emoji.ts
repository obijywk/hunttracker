import * as puzzles from "./puzzles";

export function getPuzzleStatusEmoji(puzzle: puzzles.Puzzle): string {
  if (puzzle.complete) {
    return ":white_check_mark:";
  }
  const priority = puzzles.getPriority(puzzle);
  if (priority >= 5) {
    return ":exclamation:";
  }
  if (priority < 0) {
    return ":skull:";
  }
  if (puzzles.isNew(puzzle)) {
    return ":new:";
  }
  if (puzzle.users.length == 0) {
    return ":desert:";
  }
  const idleDuration = puzzles.getIdleDuration(puzzle);
  if (idleDuration.asMinutes() < 15) {
    return ":memo:";
  }
  if (idleDuration.asMinutes() < 60) {
    return ":thinking_face:";
  }
  if (idleDuration.asMinutes() < 180) {
    return ":turtle:";
  }
  return ":zzz:";
}
