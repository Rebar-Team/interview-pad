# Rebar Interview Assistant

All assistant logic runs in the existing Rust server. The React panel uses
same-origin `/api/assistant/chat` and `/api/assistant/reset`; no sidecar or
additional port is required. The server calls OpenAI directly with
`gpt-6.1-sol` by default (set `LUNA_MODEL` to change it), low reasoning, no tools,
and `store=false`. Each request includes the user's cursor line and selection.

Enable with `LUNA_ENABLED=1` and server-only `OPENAI_API_KEY` from the root
`.env`; without a key the panel is hidden. It accepts requests only from
`PUBLIC_ORIGIN`, only for rooms that exist and are still writable (6 hours after
creation). Messages are unlimited within that window; at most 8 upstream calls
run at once across the server. A newer request from the same browser in the same
room cancels the older one, as does Clear chat, so a reload never leaves the
panel stuck behind an abandoned call.

Edit `luna.md` to configure instructions. Set `LUNA_PROMPT_PATH` to its absolute
path (or read-only mount it into Docker, as `compose.local.yaml` does). That file
is read on each request, so changes apply on the next Send without
recompilation. Production compose doesn't mount it, so there a prompt change
ships with the next deploy. Without the variable, the
build embeds this same Markdown file as its default. Size limit: 16 KB.
Changing prompts cannot remove code-enforced edit or memory limits.

Assistant memory is in-process and isolated by a random HttpOnly browser-session
cookie plus pad ID. It holds six exchanges / 24 KB, with 30-minute idle eviction
and a 64-session LRU cap. Clear memory deletes the current session/pad history;
restarting clears all memory. Refresh clears the displayed chat but recent
server memory can remain until cleared or expired. Old code snapshots are not
retained in assistant memory. This is separate from OpenAI's prefix caching;
stable instructions and history allow cache reuse but no hit is guaranteed.
Generated answers and edit proposals are never response-cached.

The prompt translates user-specified logic into code without deriving missing
solution logic, cases, algorithms, optimizations, or refactorings. Missing logic
gets one neutral question, not suggestions or hints. It follows the current task
without grading the candidate or blocking boilerplate on unrelated questions.
These are model instructions, not deterministic properties that the Rust patch
validator can prove.

Proposals are context-anchored patches in the style of Codex's `apply_patch`:
`@@ <enclosing line>` headers and lines prefixed with ` ` (kept), `-` (removed)
or `+` (added), at most 200 changed lines / 16 KB. Unchanged code is carried as
context, so a proposal can only delete code with explicit `-` lines. Chunks are
located in order, searching forward, matching exactly, then ignoring trailing
whitespace, then ignoring surrounding whitespace. Lines that match in more than
one place need an `@@` header. The server checks each patch against the code the
model saw; if it doesn't apply, the reason goes back to the model for one retry.
The panel locates the patch again against the live buffer at apply time, shows it
as a diff, and asks for a second click when it changes or removes existing lines.
Apply uses Monaco's undoable edit path, preserving normal collaborative
synchronization. The server (`src/assistant/patch.rs`) and the panel
(`src/assistant/proposal.ts`) share test cases in `tests/patch-fixtures.json`.

60-second upstream timeout per call (the retry happens only if the first call
finished within 30 seconds; the browser waits up to 120);  2 KB question and 24 KB buffer limits. Nothing runs
code or modifies repository files.

Offline checks:

- `cargo test -p rustpad-server assistant`
- `node --test tests/assistant-edits.mjs` (from `rustpad`, Node with TS stripping)
- `npm run check && npm run build` (from `rustpad`)
