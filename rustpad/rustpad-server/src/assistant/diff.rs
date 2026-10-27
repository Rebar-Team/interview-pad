//! Proposals built from the model's full updated code.
//!
//! The model returns the whole buffer as it should read after the edit. The
//! server diffs it against the code the model saw and renders the difference
//! as a context-anchored patch (see [`patch`](super::patch)). Every patch is
//! checked to reproduce the updated code before it is offered, widening its
//! context until no chunk is ambiguous, so an offered edit always applies to
//! the code it was made for.

use similar::{capture_diff_slices, group_diff_ops, Algorithm, DiffOp};

use super::patch;

/// Context lines around each change, widened when a chunk is ambiguous. The
/// last step covers the whole file, which is always unambiguous.
const CONTEXT_STEPS: [usize; 3] = [3, 8, 20];

/// An edit ready to offer.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Proposal {
    /// Context-anchored patch against the original code.
    pub patch: String,
    /// The code after applying `patch`.
    pub code: String,
    /// Added plus removed lines.
    pub changed: usize,
}

fn lines(code: &str) -> Vec<&str> {
    if code.is_empty() {
        Vec::new()
    } else {
        code.split('\n').collect()
    }
}

/// The patch turning `code` into `updated`, or `None` when they don't differ.
///
/// Lines that differ only in trailing whitespace keep the original text, and
/// the original's final newline (or lack of one) is kept, so the patch shows
/// only real changes.
pub(super) fn propose(code: &str, updated: &str) -> Result<Option<Proposal>, String> {
    let old = lines(code);
    let mut new = lines(updated);
    match (code.ends_with('\n'), updated.ends_with('\n')) {
        (true, false) if !new.is_empty() => new.push(""),
        (false, true) => {
            new.pop();
        }
        _ => {}
    }
    let old_keys: Vec<&str> = old.iter().map(|l| l.trim_end()).collect();
    let new_keys: Vec<&str> = new.iter().map(|l| l.trim_end()).collect();
    let mut merged: Vec<&str> = Vec::with_capacity(new.len());
    for op in capture_diff_slices(Algorithm::Myers, &old_keys, &new_keys) {
        match op {
            DiffOp::Equal { old_index, len, .. } => {
                merged.extend_from_slice(&old[old_index..old_index + len])
            }
            DiffOp::Delete { .. } => {}
            DiffOp::Insert {
                new_index, new_len, ..
            }
            | DiffOp::Replace {
                new_index, new_len, ..
            } => merged.extend_from_slice(&new[new_index..new_index + new_len]),
        }
    }
    let target = merged.join("\n");
    if target == code {
        return Ok(None);
    }
    let ops = capture_diff_slices(Algorithm::Myers, &old, &merged);
    let whole = old.len().max(merged.len()) + 1;
    for context in CONTEXT_STEPS.into_iter().chain([whole]) {
        let text = render(&old, &merged, &ops, context);
        let applied = patch::locate(code, &text).map(|r| patch::apply(code, &r));
        if applied.as_deref() == Ok(target.as_str()) {
            let changed = patch::changed_lines(&text);
            return Ok(Some(Proposal {
                patch: text,
                code: target,
                changed,
            }));
        }
    }
    Err("the edit could not be turned into a patch that applies cleanly".into())
}

/// One `@@` chunk per group of nearby changes.
fn render(old: &[&str], new: &[&str], ops: &[DiffOp], context: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    for group in group_diff_ops(ops.to_vec(), context) {
        out.push("@@".into());
        for op in group {
            let (old_range, new_range) = (op.old_range(), op.new_range());
            match op {
                DiffOp::Equal { .. } => out.extend(old[old_range].iter().map(|l| format!(" {l}"))),
                DiffOp::Delete { .. } => out.extend(old[old_range].iter().map(|l| format!("-{l}"))),
                DiffOp::Insert { .. } => out.extend(new[new_range].iter().map(|l| format!("+{l}"))),
                DiffOp::Replace { .. } => {
                    out.extend(old[old_range].iter().map(|l| format!("-{l}")));
                    out.extend(new[new_range].iter().map(|l| format!("+{l}")));
                }
            }
        }
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::StdRng, Rng, SeedableRng};

    fn check(code: &str, updated: &str) -> Proposal {
        let proposal = propose(code, updated).unwrap().expect("a change");
        let located = patch::locate(code, &proposal.patch).unwrap();
        assert_eq!(patch::apply(code, &located), proposal.code);
        assert_eq!(trimmed(&proposal.code), trimmed(updated));
        proposal
    }

    fn trimmed(code: &str) -> Vec<&str> {
        code.trim_end_matches('\n')
            .split('\n')
            .map(str::trim_end)
            .collect()
    }

    const VOCAB: [&str; 8] = [
        "",
        "    break",
        "    count += 1",
        "return True",
        "  ",
        "}",
        "x\r",
        "@@",
    ];

    fn random_code(rng: &mut StdRng, n: usize) -> Vec<String> {
        (0..n)
            .map(|_| {
                let line = VOCAB[rng.gen_range(0..VOCAB.len())];
                if rng.gen_bool(0.1) {
                    format!("{line} ")
                } else {
                    line.to_owned()
                }
            })
            .collect()
    }

    #[test]
    fn unchanged_code_is_no_proposal() {
        assert_eq!(propose("a\nb\n", "a\nb\n"), Ok(None));
        assert_eq!(
            propose("a  \nb\n", "a\nb"),
            Ok(None),
            "whitespace and newline only"
        );
        assert_eq!(propose("", ""), Ok(None));
    }

    #[test]
    fn keeps_untouched_lines_verbatim() {
        let proposal = check("x = 1   \ny = 2\n", "x = 1\ny = 3");
        assert_eq!(proposal.code, "x = 1   \ny = 3\n");
        assert_eq!(proposal.changed, 2);
    }

    #[test]
    fn empty_buffers_both_ways() {
        assert_eq!(check("", "print(1)\n").code, "print(1)");
        assert_eq!(check("a\nb", "").code, "");
    }

    #[test]
    fn repeated_lines_get_enough_context() {
        let block = "    if x:\n        break\n    count += 1\n";
        let code = format!("def f():\n{block}{block}{block}    return count\n");
        let updated =
            code.replacen("count += 1", "count += 2", 3)
                .replacen("count += 2", "count += 1", 2);
        let proposal = check(&code, &updated);
        assert_eq!(proposal.changed, 2);
    }

    /// The edit that failed in a live interview: pulling two near-identical
    /// branches into a helper.
    #[test]
    fn connect_four_refactor_applies() {
        let code = include_str!("../../../tests/fixtures/connect_four.py");
        let updated = include_str!("../../../tests/fixtures/connect_four_refactored.py");
        check(code, updated);
    }

    /// Whatever the model sends, the offered patch reproduces it.
    #[test]
    fn random_edits_always_apply() {
        let mut rng = StdRng::seed_from_u64(7);
        for _ in 0..3000 {
            let n = rng.gen_range(0..30);
            let old = random_code(&mut rng, n);
            let mut new = old.clone();
            for _ in 0..rng.gen_range(1..5) {
                let at = rng.gen_range(0..=new.len());
                match rng.gen_range(0..3) {
                    0 => new.insert(at, random_code(&mut rng, 1).remove(0)),
                    1 if at < new.len() => {
                        new.remove(at);
                    }
                    _ if at < new.len() => new[at] = format!("changed {at}"),
                    _ => {}
                }
            }
            let (code, updated) = (old.join("\n"), new.join("\n"));
            if let Some(proposal) = propose(&code, &updated).unwrap() {
                let located = patch::locate(&code, &proposal.patch).unwrap();
                assert_eq!(
                    patch::apply(&code, &located),
                    proposal.code,
                    "{code:?} -> {updated:?}"
                );
            }
        }
    }
}
