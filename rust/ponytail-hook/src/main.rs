//! ponytail-hook binary — one entry point that dispatches the SessionStart /
//! UserPromptSubmit / SubagentStart hook behavior to a command module based on
//! `argv[1]`, matching `hooks/ponytail-activate.js`, `ponytail-mode-tracker.js`,
//! and `ponytail-subagent.js`.

mod activate;
mod mode_tracker;
mod subagent;

use std::process::exit;

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    match cmd.as_str() {
        "activate" => activate::run(),
        "mode-tracker" => mode_tracker::run(),
        "subagent" => subagent::run(),
        // Unknown / missing command — fail open silently, never block the host.
        _ => exit(0),
    }
}
