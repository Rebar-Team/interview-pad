# Rebar Interview Assistant

All assistant logic runs in the existing Rust server. Each room has one shared
chat over a same-origin WebSocket at `/api/assistant/<room>`, like the editor
and terminal: everyone in the pad sees questions, replies and proposed edits
live, and anyone can ask or apply. The server calls OpenAI directly with
`gpt-6.1-sol` by default (set `ASSISTANT_MODEL` to change it), low reasoning, no
tools, and `store=false`. Each question includes the asker's cursor line and
selection.

Enable with `ASSISTANT_ENABLED=1` and server-only `OPENAI_API_KEY` from the root
`.env`; without a key the panel is hidden. The socket accepts connections only
from `PUBLIC_ORIGIN`; questions, clears and applies are accepted only while the
room is writable (6 hours after creation). One question is answered at a time
per room; at most 8 upstream calls run at once across the server.

Edit `assistant.md` to configure instructions. Set `ASSISTANT_PROMPT_PATH` to its
absolute path (or read-only mount it into Docker, as `compose.local.yaml` does).
That file is read on each question, so changes apply on the next Send without
recompilation. Production compose doesn't mount it, so there a prompt change
ships with the next deploy. Without the variable, the build embeds this same
Markdown file as its default. Size limit: 16 KB.

## Behavior

The interview measures the candidate's ability to design, write and review code
without typing it. The assistant implements whatever approach the candidate
states, in plain words, even one it thinks is wrong, filling in mechanical
detail and choosing the most likely correct reading of anything ambiguous. It
asks only when a request names an outcome with no approach, and then asks one
specific question without hinting at the answer. At most one clarifying question
per request: when the previous reply was a question, the server tells the model
not to ask again, and if it still asks, sends it back once to implement.

## Memory and logging

The chat is stored in SQLite (`assistant_message`) with the room, so it survives
reloads, restarts and deploys, and a reopened panel shows it again. The model
sees the last 20 messages (ten questions and their replies, 128 KB at most),
with each proposed edit and whether it was applied. Failed questions are left
out. Clear chat hides the conversation from the panel and from the model for
everyone in the room.

Every question is logged in full in `assistant_log`: the asker, question,
cursor, the code it was asked about, the memory sent, each model call with its
raw output, timing, token usage and why it wasn't used, and the final reply or
error. Clearing the chat doesn't remove the log. Signed-in interviewers can read
it at `/r/<room>/assistant-log` (linked from the dashboard); the JSON is at
`/api/assistant/<room>/log`. The server log gets one line per question with its
outcome, attempts and latency, plus the error text when one fails.

## Edits

The model returns the complete updated buffer, never a patch. The server diffs
it against the code the model saw (lines that differ only in trailing whitespace
keep their original text) and renders a context-anchored patch in the style of
Codex's `apply_patch`: `@@` chunks of lines prefixed with ` ` (kept), `-`
(removed) or `+` (added). Before offering it, the server checks that the patch
reproduces the model's code exactly, widening the context until no chunk is
ambiguous, so an offered edit always applies to the code it was made for. Edits
over 200 changed lines go back to the model once to narrow; if still too large,
the reply is shown with a note instead of the edit.

The panel shows the diff with long unchanged runs folded. Apply asks the server,
which, holding the chat lock, locates the patch against the room's live document
and applies it as one revision that every editor receives like a collaborator's
typing. So an edit lands exactly once however many people click, and edits made
elsewhere since the question don't matter. If the lines it changes were edited
in the meantime, nothing changes and the asker is told to ask again. An applied
edit shows who applied it and an Undo button, which reverts it the same way.
Anyone's Ctrl+Z can also revert it, so the server decides whether an edit is
applied from the live code, not from who clicked: Apply refuses an edit that is
already in the code, and Undo on one already reverted just records that. Patch
locating lives in `src/assistant/patch.rs`, tested with
`tests/patch-fixtures.json`.

When something fails (an OpenAI error or timeout, a cut-off or malformed reply,
a refusal), the chat shows the actual reason to everyone in the room.

120-second upstream timeout per call (a second call happens only if the first
finished within 60 seconds); 2 KB question and 24 KB buffer limits. Nothing runs
code or modifies repository files.

Offline checks:

- `cargo test -p rustpad-server`
- `node --test tests/assistant-edits.mjs tests/assistant-chat.mjs` (from
  `rustpad`, Node with TS stripping)
- `npm run check && npm run build` (from `rustpad`)
