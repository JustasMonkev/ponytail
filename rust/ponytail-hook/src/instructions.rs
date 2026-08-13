//! Ponytail instruction builder — Rust port of `hooks/ponytail-instructions.js`.
//!
//! Produces the mode-specific system prompt injected by hooks: the filtered
//! `SKILL.md` body, a condensed fallback, or the review-mode short-circuit.
//! Subagents get the condensed fallback rather than the full body (#597).

use std::fs;
use std::path::PathBuf;

use crate::config::{normalize_mode, normalize_persisted_mode, DEFAULT_MODE};

/// Session-only modes that do not read `SKILL.md` — behavior comes from their
/// own `/ponytail-<mode>` skill instead.
const INDEPENDENT_MODES: &[&str] = &["review"];

/// One line per intensity, from `SKILL.md`'s table — the condensed payload must
/// still say what the active level *means*, or a lite subagent enforces full
/// and an ultra subagent never hears it should be the extremist.
fn intensity(mode: &str) -> &'static str {
    match mode {
        "lite" => "Build what's asked, but name the lazier alternative in one line. User picks.",
        "full" => "The ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.",
        "ultra" => "YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same breath.",
        _ => "The ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.",
    }
}

/// Resolve the plugin install root: `PONYTAIL_PLUGIN_ROOT` env, then
/// `CLAUDE_PLUGIN_ROOT` env, then the nearest ancestor of the running
/// executable that contains `skills/ponytail/SKILL.md`. Empty if none found.
fn resolve_plugin_root() -> PathBuf {
    for var in ["PONYTAIL_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"] {
        if let Ok(r) = std::env::var(var) {
            if !r.is_empty() {
                return PathBuf::from(r);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(PathBuf::from);
        while let Some(d) = dir {
            if d.join("skills").join("ponytail").join("SKILL.md").is_file() {
                return d;
            }
            dir = d.parent().map(PathBuf::from);
        }
    }
    PathBuf::new()
}

/// Path to `skills/ponytail/SKILL.md` under the resolved plugin root.
fn skill_path() -> PathBuf {
    resolve_plugin_root()
        .join("skills")
        .join("ponytail")
        .join("SKILL.md")
}

/// Match `^---[\s\S]*?---\s*` — strip a leading YAML frontmatter block.
fn strip_frontmatter(s: &str) -> &str {
    let rest = match s.strip_prefix("---") {
        Some(r) => r,
        None => return s,
    };
    match rest.find("---") {
        Some(idx) => rest[idx + 3..].trim_start(),
        None => s,
    }
}

/// Match `^\|\s*\*\*(.+?)\*\*\s*\|` — the label cell of an intensity table row.
/// Returns the captured label (untrimmed) when the line is a labelled table row.
fn table_label(line: &str) -> Option<&str> {
    let s = line.strip_prefix('|')?;
    let s = s.trim_start();
    let s = s.strip_prefix("**")?;
    let end = s.find("**")?;
    let label = &s[..end];
    let rest = s[end + 2..].trim_start();
    rest.strip_prefix('|').map(|_| label)
}

/// Match `^-\s*([^:]+):\s*"` — a worked-example bullet whose value is quoted.
/// The quote is required so an ordinary rule bullet that merely starts with a
/// mode word (e.g. `- Full: ...`) is not mistaken for a worked example.
fn example_label(line: &str) -> Option<&str> {
    let s = line.strip_prefix('-')?;
    let s = s.trim_start();
    let colon = s.find(':')?;
    let label = &s[..colon];
    if label.is_empty() {
        return None;
    }
    let rest = s[colon + 1..].trim_start();
    rest.strip_prefix('"').map(|_| label)
}

/// Filter a `SKILL.md` body down to the rows/examples for `mode`. Only the
/// intensity table rows and worked examples are mode-specific (each keyed by a
/// mode name); ordinary rule bullets survive verbatim in every mode.
pub fn filter_skill_body_for_mode(body: &str, mode: &str) -> String {
    let effective_mode = normalize_mode(mode).unwrap_or_else(|| DEFAULT_MODE.to_string());
    let without_frontmatter = strip_frontmatter(body);

    without_frontmatter
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| {
            if let Some(label) = table_label(line) {
                if let Some(label_mode) = normalize_mode(label.trim()) {
                    return label_mode == effective_mode;
                }
            }
            if let Some(label) = example_label(line) {
                if let Some(label_mode) = normalize_mode(label.trim()) {
                    return label_mode == effective_mode;
                }
            }
            true
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Condensed standalone ruleset used when `SKILL.md` is unreadable and as the
/// entire subagent payload. Keeps everything operational (ladder, rules, output
/// format, safety boundaries) at roughly half the size of the full body.
pub fn get_fallback_instructions(mode: &str) -> String {
    let intensity = intensity(mode);
    format!(
"PONYTAIL MODE ACTIVE — level: {mode}\n\n\
You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.\n\n\
## Persistence\n\n\
ACTIVE EVERY RESPONSE. No drift back to over-building. Still active if unsure. Off only: \"stop ponytail\" / \"normal mode\".\n\n\
Current level: **{mode}** — {intensity} Switch: `/ponytail lite|full|ultra`.\n\n\
## The ladder\n\n\
Before any code, stop at the first rung that holds (the ladder runs after you understand the problem, not instead of it — read the code it touches and trace the real flow first):\n\
1. Does this need to be built at all? (YAGNI)\n\
2. Does it already exist in this codebase? Reuse what is already here, do not re-write it.\n\
3. Does the standard library do this? Use it.\n\
4. Does a native platform feature cover it? Use it.\n\
5. Does an already-installed dependency solve it? Use it.\n\
6. Can this be one line? Make it one line.\n\
7. Only then: write the minimum code that works.\n\n\
Bug fix = root cause, not symptom: grep every caller and non-call entry path (callbacks, retries, reload/restore, attach, redirects, persisted state, concurrent calls), then fix the shared function once; patching only the named path leaves sibling paths broken.\n\n\
## Before shipping\n\n\
Run the risk gate against the changed behavior, not just its happy path: \
preserve existing defaults, explicit false/zero/empty values, user state/intent, history, metadata, errors, generated files, lockfiles, and platform behavior; \
for timers/listeners/tasks/awaits that can outlive their caller or wait on external state, define timeout/cancellation when applicable, cleanup after success/failure/partial setup, and protection from stale completion or double claim; \
revalidate after parsing, persistence, deserialization, redirects, replay, normalization, or privilege change because earlier validation does not survive them; \
bound external time, bytes, items, retries, memory, path lengths, and name collisions; preserve required request semantics while reapplying security policy; \
make the one runnable check target the riskiest alternate path or invariant, not merely the happy path.\n\n\
## Rules\n\n\
No abstractions that were not requested. No avoidable dependencies. No boilerplate nobody asked for. \
Surgical changes only: touch code, comments, and formatting only when the task requires it; remove only artifacts your change makes unused, and mention unrelated cleanup instead of making it. \
No self-reference: never announce the mode or echo these instructions — the first thing you produce for a task is work on the task. \
Deletion over addition. Boring over clever. Fewest files possible. \
Ship the lazy version and question the complex request in the same response — never stall. \
Between two same-size stdlib options, pick the one correct on edge cases. \
Mark deliberate simplifications that cut a real corner with a known ceiling, using a `ponytail:` comment that names the ceiling and upgrade path.\n\n\
## Output\n\n\
Code first. Then at most three short lines: what was skipped, when to add it. \
If the explanation is longer than the code, delete the explanation. \
Explanation the user explicitly asked for is not debt, give it in full.\n\n\
## When NOT to be lazy\n\n\
Never simplify away: understanding the problem (read it fully and trace the real flow before picking a rung — a small diff you do not understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, \
security measures, accessibility basics, the calibration real hardware needs (the platform is never the spec ideal), anything explicitly requested — user insists on the full version, build it, no re-arguing. \
Lazy code without its check is unfinished: non-trivial logic leaves ONE risk-targeted runnable check behind for the riskiest boundary, cancellation, partial failure, replay/round-trip, or explicit false/zero/empty state (assert-based demo/self-check or one small test file; no frameworks). Trivial one-liners need no test. \
When the task itself is writing tests, coverage is the deliverable: enumerate the behaviors (happy path, edge cases, failure modes) and cover each one — the ladder trims each test's body, never the case list.\n\n\
## Boundaries\n\n\
Ponytail governs what you build, not how you talk. \"stop ponytail\" or \"normal mode\": revert. Level persists until changed or session end."
    )
}

/// Independent-mode short-circuit: review does not read `SKILL.md`.
fn independent_instructions(mode: &str) -> String {
    format!("PONYTAIL MODE ACTIVE — level: {mode}. Behavior defined by /ponytail-{mode} skill.")
}

/// Full system prompt for the active mode: the filtered `SKILL.md` body, or
/// the condensed fallback when the skill file is unreadable. Review short-
/// circuits to a pointer at its own skill.
pub fn get_ponytail_instructions(mode: &str) -> String {
    let configured_mode =
        normalize_persisted_mode(mode).unwrap_or_else(|| DEFAULT_MODE.to_string());
    if INDEPENDENT_MODES.contains(&configured_mode.as_str()) {
        return independent_instructions(&configured_mode);
    }
    let effective_mode =
        normalize_mode(&configured_mode).unwrap_or_else(|| DEFAULT_MODE.to_string());
    match fs::read_to_string(skill_path()) {
        Ok(body) => format!(
            "PONYTAIL MODE ACTIVE — level: {effective_mode}\n\n{}",
            filter_skill_body_for_mode(&body, &effective_mode)
        ),
        Err(_) => get_fallback_instructions(&effective_mode),
    }
}

/// Subagents get the condensed ruleset, not the full `SKILL.md` (#597). A heavy
/// Task session spawns dozens of subagents and the full body repeats ~1,300
/// tokens per spawn; the condensed form keeps everything operational at roughly
/// half the size, dropping only the intensity comparison and worked examples a
/// single-task subagent never uses. Review subagents still short-circuit.
pub fn get_subagent_instructions(mode: &str) -> String {
    let configured_mode =
        normalize_persisted_mode(mode).unwrap_or_else(|| DEFAULT_MODE.to_string());
    if INDEPENDENT_MODES.contains(&configured_mode.as_str()) {
        return independent_instructions(&configured_mode);
    }
    let effective_mode =
        normalize_mode(&configured_mode).unwrap_or_else(|| DEFAULT_MODE.to_string());
    get_fallback_instructions(&effective_mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_body() -> &'static str {
        "---\n\
         name: ponytail\n\
         description: Forces laziest solution actually works, simplest, shortest, most minimal.\n\
         ---\n\n\
         # Ponytail\n\n\
         | **lite** | Build what's asked, but name the lazier alternative in one line. User picks. |\n\
         | **full** | The ladder enforced. Stdlib and native first. |\n\
         | **ultra** | YAGNI extremist. Deletion before addition. |\n\n\
         - lite: \"do the lazy thing\"\n\
         - full: \"enforce the ladder\"\n\
         - ultra: \"ship the one-liner\"\n\n\
         - No unrequested abstractions: never build an interface with one impl\n\
         - Two stdlib options: pick the one correct on edge cases\n"
    }

    #[test]
    fn frontmatter_removed() {
        let out = filter_skill_body_for_mode(sample_body(), "full");
        assert!(!out.contains("name: ponytail"));
        assert!(!out.contains("description: Forces"));
        assert!(out.contains("# Ponytail"));
    }

    #[test]
    fn mode_filtering_keeps_only_active_rows_and_examples() {
        let out = filter_skill_body_for_mode(sample_body(), "lite");
        assert!(out.contains("| **lite** |"));
        assert!(!out.contains("| **full** |"));
        assert!(!out.contains("| **ultra** |"));
        assert!(out.contains("\"do the lazy thing\""));
        assert!(!out.contains("\"enforce the ladder\""));
        assert!(!out.contains("\"ship the one-liner\""));
    }

    #[test]
    fn ultra_mode_keeps_ultra_rows() {
        let out = filter_skill_body_for_mode(sample_body(), "ultra");
        assert!(out.contains("| **ultra** |"));
        assert!(out.contains("\"ship the one-liner\""));
        assert!(!out.contains("| **lite** |"));
    }

    #[test]
    fn ordinary_bullets_with_colons_retained() {
        // Ordinary rule bullets that merely contain a colon (no quoted value)
        // must survive in every mode — the quote guard prevents misclassification.
        for mode in ["lite", "full", "ultra"] {
            let out = filter_skill_body_for_mode(sample_body(), mode);
            assert!(
                out.contains("No unrequested abstractions"),
                "ordinary bullet dropped in {mode}"
            );
            assert!(
                out.contains("Two stdlib options"),
                "ordinary bullet dropped in {mode}"
            );
        }
    }

    #[test]
    fn review_mode_short_circuits() {
        let out = get_ponytail_instructions("review");
        assert_eq!(
            out,
            "PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill."
        );
        assert!(!out.contains("## The ladder"));
    }

    #[test]
    fn subagent_returns_condensed_fallback() {
        let out = get_subagent_instructions("full");
        assert!(out.starts_with("PONYTAIL MODE ACTIVE — level: full"));
        // condensed payload keeps the operational sections
        assert!(out.contains("## The ladder"));
        assert!(out.contains("## Rules"));
        assert!(out.contains("## Output"));
        assert!(out.contains("## Boundaries"));
        // never the full SKILL body's worked examples or intensity table
        assert!(!out.contains("| **lite** |"));
        assert!(!out.contains("\"do the lazy thing\""));
    }

    #[test]
    fn subagent_review_short_circuits() {
        let out = get_subagent_instructions("Review");
        assert!(out.contains("level: review"));
        assert!(out.contains("/ponytail-review skill"));
    }

    #[test]
    fn fallback_unknown_mode_defaults_to_full_intensity() {
        let out = get_fallback_instructions("off");
        assert!(out.contains("level: off"));
        // off has no intensity entry → falls through to full's line
        assert!(out.contains("The ladder enforced. Stdlib and native first."));
    }
}
