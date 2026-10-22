import assert from "node:assert/strict";
import { test } from "node:test";

import { appendTurn } from "../src/assistant/history.ts";

test("keeps the latest ten exchanges in order with stable IDs", () => {
  let turns = [];
  for (let id = 0; id < 15; id++)
    turns = appendTurn(turns, { id, question: `q${id}` });
  assert.deepEqual(
    turns.map((t) => t.id),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
});

test("appending does not mutate previous exchanges or move proposal state", () => {
  const existing = [{ id: 1, applied: true }];
  const result = appendTurn(existing, { id: 2, applied: false });
  assert.equal(existing.length, 1);
  assert.equal(result[0], existing[0]);
  assert.equal(result[0].applied, true);
});
