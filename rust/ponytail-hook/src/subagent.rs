//! ponytail — SubagentStart hook (Rust port of `hooks/ponytail-subagent.js`).
//!
//! SessionStart context never reaches subagents, so without this every
//! Task-spawned agent runs ponytail-unaware (#252). When ponytail is active,
//! inject the condensed ruleset into each subagent.
//!
//! Scoping (#506): set `PONYTAIL_SUBAGENT_MATCHER` to a regex and the ruleset
//! is injected only into subagents whose `agent_type` matches. The regex is
//! unanchored and case-insensitive. An invalid regex fails open (no matcher →
//! inject into everyone). Missing/unparseable `agent_type`, a stdin error, or
//! the timeout all fail open, so scoping never silently drops the persona.

use std::time::Duration;

use ponytail_hook as pt;
use regex::RegexBuilder;
use serde_json::Value;

pub fn run() {
    let host = pt::runtime::host();
    // Absent flag or off → ponytail isn't active; inject nothing.
    let mode = match pt::read_mode(host) {
        Some(m) if m != "off" => m,
        _ => return,
    };

    let inject = || {
        pt::write_hook_output(
            "SubagentStart",
            &mode,
            &pt::get_subagent_instructions(&mode),
        );
    };

    // A bad regex must never crash the hook; treat it as "no matcher" and inject.
    let matcher = std::env::var("PONYTAIL_SUBAGENT_MATCHER")
        .ok()
        .filter(|s| !s.is_empty())
        .and_then(|p| RegexBuilder::new(&p).case_insensitive(true).build().ok());

    let matcher = match matcher {
        Some(m) => m,
        // No matcher → synchronous, stdin-independent path. On Windows the
        // PowerShell `if {}` wrapper can swallow the piped JSON so stdin 'end'
        // never fires (#443); the default path must not wait on stdin.
        None => {
            inject();
            return;
        }
    };

    // Matcher set → read agent_type from stdin and skip only on a definite
    // mismatch. Never block the session (#443): recover on EOF or 1s fallback.
    let input = pt::read_stdin_with_timeout(Duration::from_millis(1000));
    let agent_type = pt::parse_config_value(&input)
        .ok()
        .and_then(|v: Value| {
            v.get("agent_type")
                .and_then(|t| t.as_str())
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default();

    if !agent_type.is_empty() && !matcher.is_match(&agent_type) {
        return; // definite mismatch → skip injection
    }
    inject();
}
