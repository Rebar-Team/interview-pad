# Rebar Interview Assistant

All assistant logic runs in the existing Rust server. The React panel uses
same-origin `/api/assistant/chat` and `/api/assistant/reset`; no sidecar or
additional port is required. The server calls OpenAI directly with `gpt-6-luna`,
low reasoning, no tools, no retries, and `store=false`.

Enable with `LUNA_ENABLED=1` and server-only `OPENAI_API_KEY` from the root
`.env`; without a key the panel is hidden. It accepts requests only from
`PUBLIC_ORIGIN`, only for rooms that exist and are still writable (6 hours after
creation). Each room gets 60 messages per hour, and at most 8 upstream calls run
at once across the server. A newer request from the same browser in the same
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
These are model instructions, not deterministic properties that the Rust edit
validator can prove. Prompt-only updates have not been live-model regression-tested.

One request at a time; 60-second upstream timeout; 2 KB question and 24 KB buffer
limits. Edits must be unique exact replacements of at most 200 combined lines /
16 KB. An empty `before` permits insertion only into an empty buffer; nonempty
buffers require a unique anchor. Apply rechecks the full original buffer and uses Monaco's undoable edit
path, preserving normal collaborative synchronization. Nothing runs code or
modifies repository files.

Offline checks:

- `cargo test -p rustpad-server assistant`
- `node --test tests/assistant-edits.mjs` (from `rustpad`, Node with TS stripping)
- `npm run check && npm run build` (from `rustpad`)
