/**
 * Context-anchored patches in the style of Codex's `apply_patch`. Mirrors
 * rustpad-server/src/assistant/patch.rs; both run tests/patch-fixtures.json.
 *
 * ```
 * @@ def bfs(graph, start):
 *      while q:
 * -        node = q.pop()
 * +        node = q.popleft()
 *          order.append(node)
 * ```
 */

export type Op = " " | "-" | "+";
export type PatchLine = { op: Op; text: string };
export type Chunk = { context: string | null; lines: PatchLine[] };

/** One located change: replace `remove` lines from `start` (0-based) with `insert`. */
type Replacement = { start: number; remove: number; insert: string[] };

export function parsePatch(patch: string): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = { context: null, lines: [] };
  const flush = () => {
    if (current.context !== null || current.lines.length) chunks.push(current);
  };
  patch.split("\n").forEach((line, n) => {
    // Tolerate the envelope Codex-trained models like to add.
    if (line.startsWith("*** ")) return;
    if (line === "@@" || line.startsWith("@@ ")) {
      flush();
      const context = line.slice(2).trim();
      current = { context: context || null, lines: [] };
      return;
    }
    if (line === "") {
      current.lines.push({ op: " ", text: "" });
      return;
    }
    const op = line[0];
    if (op !== " " && op !== "-" && op !== "+")
      throw new Error(
        `Patch line ${n + 1} must start with ' ', '-', '+' or '@@'.`,
      );
    current.lines.push({ op, text: line.slice(1) });
  });
  flush();
  // A trailing newline in the patch is not an extra context line.
  const last = chunks[chunks.length - 1];
  const tail = last?.lines[last.lines.length - 1];
  if (tail && tail.op === " " && tail.text === "" && patch.endsWith("\n"))
    last.lines.pop();
  if (!chunks.some((c) => c.lines.some((l) => l.op !== " ")))
    throw new Error("The proposal makes no change.");
  return chunks;
}

const LEVELS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
];

/** Matches of `pattern` at or after `start`, at the strictest level that matches. */
function seek(lines: string[], pattern: string[], start: number): number[] {
  if (!pattern.length || pattern.length > lines.length) return [];
  for (const norm of LEVELS) {
    const found: number[] = [];
    for (let i = start; i + pattern.length <= lines.length; i++)
      if (pattern.every((p, k) => norm(p) === norm(lines[i + k])))
        found.push(i);
    if (found.length) return found;
  }
  return [];
}

function locate(code: string, chunks: Chunk[]): Replacement[] {
  const lines = code === "" ? [] : code.split("\n");
  const out: Replacement[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    // Where the chunk's lines are searched from. Models often repeat the @@
    // line as the first context line, so the search includes it.
    let from = cursor;
    if (chunk.context !== null) {
      const [at] = seek(lines, [chunk.context], cursor);
      if (at === undefined)
        throw new Error(`Couldn't find "${chunk.context}" in the code.`);
      from = at;
      cursor = at + 1;
    }
    const old = chunk.lines.filter((l) => l.op !== "+").map((l) => l.text);
    if (!old.length) {
      // At the end, before a final newline so no blank line is added.
      const end =
        lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      const at = chunk.context !== null || !lines.length ? cursor : end;
      out.push({
        start: at,
        remove: 0,
        insert: chunk.lines.map((l) => l.text),
      });
      continue;
    }
    const found = seek(lines, old, from);
    if (!found.length)
      throw new Error(
        "The code this proposal changes has been edited. Ask again.",
      );
    if (found.length > 1 && chunk.context === null)
      throw new Error("The proposal matches more than one place. Ask again.");
    const start = found[0];
    // Context lines keep the code's own text, whitespace included.
    const insert: string[] = [];
    let k = 0;
    for (const line of chunk.lines) {
      if (line.op === " ") insert.push(lines[start + k++]);
      else if (line.op === "-") k++;
      else insert.push(line.text);
    }
    out.push({ start, remove: old.length, insert });
    cursor = start + old.length;
  }
  // Appends at the end can come before later chunks, so order by position
  // (stably, keeping chunk order at equal positions) and refuse overlaps.
  out.sort((x, y) => x.start - y.start);
  for (let k = 1; k < out.length; k++)
    if (out[k].start < out[k - 1].start + out[k - 1].remove)
      throw new Error("Two changes in the proposal overlap. Ask again.");
  return out;
}

/** The code after applying `patch`, or an error explaining why it can't apply. */
export function applyPatch(code: string, patch: string): string {
  const lines = code === "" ? [] : code.split("\n");
  for (const r of locate(code, parsePatch(patch)).reverse())
    lines.splice(r.start, r.remove, ...r.insert);
  return lines.join("\n");
}

/** Smallest single edit turning `before` into `after`, as offsets into `before`. */
export function minimalEdit(before: string, after: string) {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  return {
    start,
    end: before.length - tail,
    text: after.slice(start, after.length - tail),
  };
}

/** Existing non-blank lines a proposal deletes or rewrites. */
export function removedLines(chunks: Chunk[]): number {
  return chunks
    .flatMap((c) => c.lines)
    .filter((l) => l.op === "-" && l.text.trim()).length;
}
