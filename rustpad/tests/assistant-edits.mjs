import assert from "node:assert/strict";
import { test } from "node:test";

import { replacement } from "../src/assistant/proposal.ts";

test("small exact replacement", () => {
  assert.deepEqual(replacement("x = 1", "x = 1", { before: "1", after: "2" }), {
    start: 4,
    end: 5,
    text: "2",
  });
});

test("insertion into an empty pad, but not a changed or nonempty pad", () => {
  const edit = { before: "", after: "class Board:\n    pass" };
  assert.deepEqual(replacement("", "", edit), {
    start: 0,
    end: 0,
    text: edit.after,
  });
  assert.throws(() => replacement("user typed", "", edit));
  assert.throws(() => replacement("existing", "existing", edit));
});

test("stale, ambiguous, empty, unchanged and oversized edits rejected", () => {
  for (const [current, snapshot, before, after] of [
    ["new", "old", "old", "fix"],
    ["xx", "xx", "x", "y"],
    ["", "", "", ""],
    ["x", "x", "x", "x"],
    ["x", "x", "x", "y".repeat(16_000)],
    ["x", "x", "x", "y\n".repeat(200)],
  ])
    assert.throws(() => replacement(current, snapshot, { before, after }));
});

test("larger targeted edits are allowed", () => {
  const edit = { before: "old", after: "code\n".repeat(80) };
  assert.equal(replacement("old", "old", edit).text, edit.after);
  assert.equal(
    replacement("", "", { before: "", after: "x\n".repeat(200) }).end,
    0,
  );
});
