import assert from "node:assert/strict";
import { test } from "node:test";

import { collapseContext, parsePatch } from "../src/assistant/proposal.ts";

test("patches split into chunks of kept, removed and added lines", () => {
  const chunks = parsePatch("@@\n a\n-b\n+c\n@@\n x\n+y");
  assert.deepEqual(
    chunks.map((c) => c.lines.map((l) => l.op + l.text)),
    [
      [" a", "-b", "+c"],
      [" x", "+y"],
    ],
  );
  assert.throws(() => parsePatch("@@\nnot a patch line"));
});

test("long unchanged runs fold, keeping context next to changes", () => {
  const context = (n) => Array.from({ length: n }, (_, i) => ` c${i}`);
  const patch = [...context(10), "-old", "+new", ...context(10)].join("\n");
  const shown = collapseContext(parsePatch(patch)[0].lines);
  assert.deepEqual(
    shown.map((l) => (l.op === "skip" ? `skip ${l.count}` : l.op + l.text)),
    [
      "skip 7",
      " c7",
      " c8",
      " c9",
      "-old",
      "+new",
      " c0",
      " c1",
      " c2",
      "skip 7",
    ],
  );
  assert.equal(collapseContext(parsePatch(" a\n-b\n c")[0].lines).length, 3);
});
