import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  applyPatch,
  minimalEdit,
  parsePatch,
  removedLines,
} from "../src/assistant/proposal.ts";

// Shared with the server's matcher (rustpad-server/src/assistant/patch.rs).
const fixtures = JSON.parse(
  readFileSync(new URL("./patch-fixtures.json", import.meta.url), "utf8"),
);

for (const { name, code, patch, result } of fixtures) {
  test(`fixture: ${name}`, () => {
    if (result === null) assert.throws(() => applyPatch(code, patch));
    else assert.equal(applyPatch(code, patch), result);
  });
}

test("a trailing newline in the patch adds no blank line", () => {
  assert.equal(applyPatch("x = 1", "-x = 1\n+x = 2\n"), "x = 2");
});

test("additions count no removed lines; rewrites and deletions do", () => {
  assert.equal(
    removedLines(parsePatch("@@ def a():\n     pass\n+    x = 1")),
    0,
  );
  assert.equal(removedLines(parsePatch("-a\n-b\n-\n+c")), 2);
});

test("minimal edit touches only what changed", () => {
  assert.deepEqual(minimalEdit("a\nb\nc", "a\nB\nc"), {
    start: 2,
    end: 3,
    text: "B",
  });
  assert.deepEqual(minimalEdit("a", "a\nb"), { start: 1, end: 1, text: "\nb" });
});
