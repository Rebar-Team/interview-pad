import type { Edit } from "./client";

/** Reject stale proposals even when their snippet still exists elsewhere. */
export function replacement(current: string, snapshot: string, edit: Edit) {
  if (current !== snapshot)
    throw new Error("Code changed. Ask for a fresh proposal.");
  const start = current.indexOf(edit.before);
  const unique = edit.before
    ? start >= 0 && current.indexOf(edit.before, start + 1) === -1
    : current === "";
  if (
    !unique ||
    edit.before === edit.after ||
    new TextEncoder().encode(edit.before + edit.after).length > 16_000 ||
    lineCount(edit.before) + lineCount(edit.after) > 200
  ) {
    throw new Error(
      "Proposal exceeds 200 combined lines / 16 KB or is not unique.",
    );
  }
  return { start, end: start + edit.before.length, text: edit.after };
}

function lineCount(text: string) {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}
