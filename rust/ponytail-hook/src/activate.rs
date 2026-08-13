//! ponytail — SessionStart activation hook (Rust port of
//! `hooks/ponytail-activate.js`).
//!
//! Runs on every session start:
//!   1. Writes the flag file at `$CLAUDE_CONFIG_DIR/.ponytail-active` (the
//!      statusline reads it).
//!   2. Emits the ponytail ruleset as hidden SessionStart context.
//!   3. Detects a missing statusline config and emits a one-time setup nudge.

use ponytail_hook as pt;
use serde_json::Value;

pub fn run() {
    let host = pt::runtime::host();
    let mode = pt::get_default_mode();

    // "off" mode — skip activation entirely, don't write flag or emit rules.
    if mode == "off" {
        pt::clear_mode(host);
        let out = if matches!(host, pt::Host::Codex | pt::Host::Copilot) {
            ""
        } else {
            "OK"
        };
        pt::write_hook_output("SessionStart", "off", out);
        return;
    }

    // 1. Write flag file (best-effort — never block the hook).
    pt::set_mode(host, &mode);

    // 2. Emit the ponytail ruleset, filtered to the active intensity level.
    let mut output = pt::get_ponytail_instructions(&mode);

    // 3. Detect missing statusline config — nudge Claude to help set it up.
    // Codex/Copilot render context elsewhere and don't read this nudge.
    if !matches!(host, pt::Host::Codex | pt::Host::Copilot) {
        nudge_statusline(&mut output);
    }

    pt::write_hook_output("SessionStart", &mode, &output);
}

/// Append the statusline setup nudge once, only when settings.json lacks a
/// `statusLine` and the one-time nudged flag is absent. Mirrors the JS block
/// verbatim, including the shell-safety fallback.
fn nudge_statusline(output: &mut String) {
    let claude_dir = pt::get_claude_dir();
    let settings_path = claude_dir.join("settings.json");
    let nudge_flag = claude_dir.join(".ponytail-statusline-nudged");

    let has_statusline = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|raw| pt::parse_config_value(&raw).ok())
        .is_some_and(|v: Value| v.get("statusLine").is_some());

    if has_statusline || nudge_flag.exists() {
        return;
    }

    // Mark nudged so it never repeats (best-effort).
    let _ = std::fs::write(&nudge_flag, "");

    let is_windows = cfg!(target_os = "windows");
    let script_name = if is_windows {
        "ponytail-statusline.ps1"
    } else {
        "ponytail-statusline.sh"
    };
    let script_path = pt::plugin_root().join("hooks").join(script_name);
    let script_path_str = script_path.to_string_lossy();

    if pt::is_shell_safe(&script_path_str) {
        let command = if is_windows {
            format!(
                "powershell -ExecutionPolicy Bypass -File \"{}\"",
                script_path_str
            )
        } else {
            format!("bash \"{}\"", script_path_str)
        };
        // JSON-encode the command exactly like JS `JSON.stringify(command)`.
        let cmd_json = serde_json::to_string(&command).unwrap_or_default();
        let snippet = format!(
            "\"statusLine\": {{ \"type\": \"command\", \"command\": {} }}",
            cmd_json
        );
        output.push_str("\n\n");
        output.push_str("STATUSLINE SETUP NEEDED: The ponytail plugin includes a statusline badge showing active mode (e.g. [PONYTAIL], [PONYTAIL:ULTRA]). It is not configured yet. To enable, add this to ");
        output.push_str(&settings_path.to_string_lossy());
        output.push_str(": ");
        output.push_str(&snippet);
        output.push_str(" Proactively offer to set this up for the user on first interaction.");
    } else {
        output.push_str("\n\n");
        output.push_str("STATUSLINE SETUP NEEDED: The ponytail plugin includes a statusline badge showing active mode. Its install path contains characters unsafe to embed in a shell command, so configure it manually: add a statusLine command of type \"command\" that runs ");
        output.push_str(script_name);
        output.push_str(" from the plugin's hooks directory to ");
        output.push_str(&settings_path.to_string_lossy());
        output.push_str(", quoting/escaping the path for your shell. Proactively offer to set this up for the user on first interaction.");
    }
}
