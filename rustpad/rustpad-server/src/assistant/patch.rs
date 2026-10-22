//! Context-anchored code patches, in the style of the Codex `apply_patch` tool.
//!
//! A patch is a list of chunks. Each chunk may start with an `@@ <line>` header
//! naming a nearby unique line (usually a function or class signature) to search
//! after, followed by lines prefixed with ` ` (context, kept), `-` (removed) or
//! `+` (added):
//!
//! ```text
//! @@ def bfs(graph, start):
//!      while q:
//! -        node = q.pop()
//! +        node = q.popleft()
//!          order.append(node)
//! ```
//!
//! Unchanged code is carried as context, so a proposal can only delete code
//! with explicit `-` lines. Chunks are located like Codex's `seek_sequence`:
//! in order, searching forward, with progressively looser whitespace matching.

/// One located change: replace `delete` lines starting at `start` (0-based)
/// with `insert`.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Replacement {
    pub start: usize,
    pub delete: usize,
    pub insert: Vec<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Chunk {
    context: Option<String>,
    /// `(' ' | '-' | '+', text)` in patch order.
    ops: Vec<(char, String)>,
}

impl Chunk {
    fn old(&self) -> Vec<String> {
        self.lines(|op| op != '+')
    }

    fn new_lines(&self) -> Vec<String> {
        self.lines(|op| op != '-')
    }

    fn lines(&self, keep: impl Fn(char) -> bool) -> Vec<String> {
        self.ops
            .iter()
            .filter(|(op, _)| keep(*op))
            .map(|(_, text)| text.clone())
            .collect()
    }

    /// The replacement for a match at `start`: context lines keep the code's
    /// own text (whitespace included), not the model's copy of it.
    fn insert_at(&self, lines: &[String], start: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut old_index = 0;
        for (op, text) in &self.ops {
            match op {
                ' ' => {
                    out.push(lines[start + old_index].clone());
                    old_index += 1;
                }
                '-' => old_index += 1,
                _ => out.push(text.clone()),
            }
        }
        out
    }
}

/// Lines changed by a patch, for size limits.
pub(super) fn changed_lines(patch: &str) -> usize {
    patch
        .lines()
        .filter(|l| l.starts_with('+') || l.starts_with('-'))
        .count()
}

fn is_unified_header(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("@@ -") else {
        return false;
    };
    let Some((old, rest)) = rest.split_once(" +") else {
        return false;
    };
    let Some((new, suffix)) = rest.split_once(" @@") else {
        return false;
    };
    let range = |text: &str| {
        let parts: Vec<_> = text.split(',').collect();
        parts.len() <= 2
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    range(old) && range(new) && (suffix.is_empty() || suffix.starts_with(' '))
}

fn parse(patch: &str) -> Result<Vec<Chunk>, String> {
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut current = Chunk::default();
    for (n, line) in patch.lines().enumerate() {
        // Tolerate the envelope Codex-trained models like to add.
        if line.starts_with("*** ") {
            continue;
        }
        if line == "@@" || line.starts_with("@@ ") {
            if current != Chunk::default() {
                chunks.push(std::mem::take(&mut current));
            }
            let context = line.strip_prefix("@@").unwrap_or_default().trim();
            // Unified-diff ranges describe coordinates, not a literal code
            // anchor. Ignore those coordinates and still require matching code.
            current.context =
                (!context.is_empty() && !is_unified_header(line)).then(|| context.to_owned());
            continue;
        }
        match line.chars().next() {
            Some(op @ (' ' | '-' | '+')) => current.ops.push((op, line[1..].to_owned())),
            // A bare empty line is an empty context line.
            None => current.ops.push((' ', String::new())),
            Some(_) => {
                return Err(format!(
                    "patch line {} must start with ' ', '-', '+' or '@@': {line:?}",
                    n + 1
                ))
            }
        }
    }
    if current != Chunk::default() {
        chunks.push(current);
    }
    if chunks.is_empty()
        || chunks
            .iter()
            .all(|c| c.ops.iter().all(|(op, _)| *op == ' '))
    {
        return Err("patch makes no change".into());
    }
    Ok(chunks)
}

/// Find `pattern` in `lines` at or after `start`, matching exactly, then
/// ignoring trailing whitespace, then ignoring surrounding whitespace.
/// Returns every match start at the strictest level that matched at all.
fn seek(lines: &[String], pattern: &[String], start: usize) -> Vec<usize> {
    if pattern.is_empty() || pattern.len() > lines.len() {
        return Vec::new();
    }
    let levels: [fn(&str) -> &str; 3] = [|s| s, str::trim_end, str::trim];
    for norm in levels {
        let found: Vec<usize> = (start..=lines.len() - pattern.len())
            .filter(|&i| {
                pattern
                    .iter()
                    .zip(&lines[i..])
                    .all(|(p, l)| norm(p) == norm(l))
            })
            .collect();
        if !found.is_empty() {
            return found;
        }
    }
    Vec::new()
}

fn preview(lines: &[String]) -> String {
    lines
        .iter()
        .take(3)
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join(" / ")
}

/// Locate every chunk of `patch` in `code`. Fails with a message the model can
/// act on when a chunk's lines aren't found, or are ambiguous.
pub(super) fn locate(code: &str, patch: &str) -> Result<Vec<Replacement>, String> {
    let chunks = parse(patch)?;
    let lines: Vec<String> = if code.is_empty() {
        Vec::new()
    } else {
        code.split('\n').map(str::to_owned).collect()
    };
    let mut cursor = 0;
    let mut out = Vec::new();
    for chunk in chunks {
        // Where the chunk's lines are searched from. Models often repeat the
        // @@ line as the first context line, so the search includes it.
        let mut from = cursor;
        if let Some(context) = &chunk.context {
            let found = seek(&lines, std::slice::from_ref(context), cursor);
            match found.first() {
                Some(&i) => {
                    from = i;
                    cursor = i + 1;
                }
                None => return Err(format!("@@ line not found: {context:?}")),
            }
        }
        let old = chunk.old();
        if old.is_empty() {
            // Pure addition: after the @@ line, into an empty buffer, or at the
            // end (before a final newline, so no blank line is added).
            let at = if chunk.context.is_some() || lines.is_empty() {
                cursor
            } else if lines.last().is_some_and(String::is_empty) {
                lines.len() - 1
            } else {
                lines.len()
            };
            out.push(Replacement {
                start: at,
                delete: 0,
                insert: chunk.new_lines(),
            });
            continue;
        }
        let found = seek(&lines, &old, from);
        match found.as_slice() {
            [] => {
                return Err(format!(
                    "lines not found in the current code: {}",
                    preview(&old)
                ))
            }
            [_, _, ..] if chunk.context.is_none() => {
                return Err(format!(
                    "lines appear more than once; add an @@ line naming the enclosing \
                     function: {}",
                    preview(&old)
                ))
            }
            [i, ..] => {
                cursor = i + old.len();
                out.push(Replacement {
                    start: *i,
                    delete: old.len(),
                    insert: chunk.insert_at(&lines, *i),
                });
            }
        }
    }
    // Appends at the end can come before later chunks, so order by position
    // (stably, keeping chunk order at equal positions) and refuse overlaps.
    out.sort_by_key(|r| r.start);
    for pair in out.windows(2) {
        if pair[1].start < pair[0].start + pair[0].delete {
            return Err("two changes in the patch overlap".into());
        }
    }
    Ok(out)
}

/// Apply located replacements to `code`.
#[cfg(test)]
fn apply(code: &str, replacements: &[Replacement]) -> String {
    let mut lines: Vec<String> = if code.is_empty() {
        Vec::new()
    } else {
        code.split('\n').map(str::to_owned).collect()
    };
    for r in replacements.iter().rev() {
        lines.splice(r.start..r.start + r.delete, r.insert.iter().cloned());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// Shared with the frontend's matcher (rustpad/tests/assistant-edits.mjs).
    #[derive(Deserialize)]
    struct Case {
        name: String,
        code: String,
        patch: String,
        result: Option<String>,
    }

    #[test]
    fn shared_fixtures() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../tests/patch-fixtures.json")).unwrap();
        for case in cases {
            let got = locate(&case.code, &case.patch).map(|r| apply(&case.code, &r));
            assert_eq!(got.ok(), case.result, "{}", case.name);
        }
    }

    #[test]
    fn errors_name_the_problem() {
        let err = locate("a\nb", "-zzz\n+y").unwrap_err();
        assert!(err.contains("not found"), "{err}");
        let err = locate("x\nx", "-x\n+y").unwrap_err();
        assert!(err.contains("more than once"), "{err}");
        let err = locate("x", "x\n+y").unwrap_err();
        assert!(err.contains("must start with"), "{err}");
    }

    #[test]
    fn counts_changed_lines() {
        assert_eq!(changed_lines("@@ f\n a\n-b\n+c\n+d"), 3);
    }
}
