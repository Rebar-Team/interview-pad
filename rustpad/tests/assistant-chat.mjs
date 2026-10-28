import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEvent } from "../src/assistant/client.ts";

const message = (id, extra = {}) => ({
  id,
  createdAt: 0,
  author: "",
  role: "assistant",
  kind: "answer",
  content: `m${id}`,
  patch: null,
  notice: null,
  appliedBy: null,
  ...extra,
});

test("snapshots replace the chat and clears empty it", () => {
  const chat = applyEvent([message(1)], {
    type: "snapshot",
    messages: [message(2)],
    busy: null,
  });
  assert.deepEqual(
    chat.map((m) => m.id),
    [2],
  );
  assert.deepEqual(applyEvent(chat, { type: "cleared" }), []);
});

test("new messages append and updates replace in place", () => {
  let chat = [message(1), message(2)];
  chat = applyEvent(chat, { type: "message", message: message(3) });
  chat = applyEvent(chat, {
    type: "message",
    message: message(1, { appliedBy: "Ada" }),
  });
  assert.deepEqual(
    chat.map((m) => [m.id, m.appliedBy]),
    [
      [1, "Ada"],
      [2, null],
      [3, null],
    ],
  );
});

test("a message seen in a snapshot and again live is not duplicated", () => {
  const chat = applyEvent([message(1)], {
    type: "message",
    message: message(1),
  });
  assert.equal(chat.length, 1);
});
