/**
 * Displaying proposed edits. The server builds each patch from the model's
 * updated code, checks it, and applies it to the shared document itself
 * (rustpad-server/src/assistant/patch.rs), so the panel only shows it:
 *
 * ```
 * @@
 *      while q:
 * -        node = q.pop()
 * +        node = q.popleft()
 *          order.append(node)
 * ```
 */

export type Op = " " | "-" | "+";
export type PatchLine = { op: Op; text: string };
export type Chunk = { lines: PatchLine[] };

/** The chunks of a patch, for display. */
export function parsePatch(patch: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const line of patch.split("\n")) {
    if (line === "@@" || line.startsWith("@@ ")) {
      chunks.push({ lines: [] });
      continue;
    }
    if (!chunks.length) chunks.push({ lines: [] });
    const op = line[0];
    if (op !== " " && op !== "-" && op !== "+")
      throw new Error(`Unexpected patch line: ${JSON.stringify(line)}`);
    chunks[chunks.length - 1].lines.push({ op, text: line.slice(1) });
  }
  return chunks.filter((c) => c.lines.length);
}

/** Unchanged context kept visible on each side of a change. */
const SHOWN_CONTEXT = 3;

export type ShownLine = PatchLine | { op: "skip"; count: number };

/** Lines to display, folding long runs of unchanged context. */
export function collapseContext(lines: PatchLine[]): ShownLine[] {
  const out: ShownLine[] = [];
  let k = 0;
  while (k < lines.length) {
    if (lines[k].op !== " ") {
      out.push(lines[k++]);
      continue;
    }
    let end = k;
    while (end < lines.length && lines[end].op === " ") end++;
    const keepBefore = k === 0 ? 0 : SHOWN_CONTEXT;
    const keepAfter = end === lines.length ? 0 : SHOWN_CONTEXT;
    if (end - k > keepBefore + keepAfter + 1) {
      out.push(...lines.slice(k, k + keepBefore));
      out.push({ op: "skip", count: end - k - keepBefore - keepAfter });
      out.push(...lines.slice(end - keepAfter, end));
    } else {
      out.push(...lines.slice(k, end));
    }
    k = end;
  }
  return out;
}
