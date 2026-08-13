//! ponytail — UserPromptSubmit hook to track which ponytail mode is active
//! (Rust port of `hooks/ponytail-mode-tracker.js`). Inspects user input for
//! `/ponytail` commands and writes the mode to the flag file.

use std::time::Duration;

use ponytail_hook as pt;
use regex::Regex;
use serde_json::Value;

pub fn run() {
    // Never hang the session (#443): recover on EOF or a 1s fallback.
    let input = pt::read_stdin_with_timeout(Duration::from_millis(1000));
    finish(&input);
}

/// Process the (possibly empty/partial) stdin payload. Silent on parse error,
/// matching the JS `catch (e) {}` contract.
fn finish(input: &str) {
    let data: Value = match pt::parse_config_value(input) {
        Ok(v) => v,
        Err(_) => return,
    };

    let raw_prompt = data.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
    let mut prompt = raw_prompt.trim().to_lowercase();

    // Claude Code dispatches `/ponytail` as a skill: `data.prompt` then carries
    // the skill body wrapped in XML tags, never the typed command, so the
    // `[/@$]ponytail` anchor below can't match (#584). Rebuild the command
    // string from the tags — but only when the prompt *starts* with the
    // platform's dispatch envelope.
    if let Some(rebuilt) = rebuild_command(&prompt) {
        prompt = rebuilt;
    }

    let host = pt::runtime::host();
    let mut mode_switched = false;
    let mut deactivated = false;

    if prompt.starts_with("/ponytail")
        || prompt.starts_with("@ponytail")
        || prompt.starts_with("$ponytail")
    {
        let parts: Vec<&str> = prompt.split_whitespace().collect();
        let cmd0 = parts.first().copied().unwrap_or("");
        let cmd = if let Some(rest) = cmd0.strip_prefix('@').or_else(|| cmd0.strip_prefix('$')) {
            format!("/{}", rest)
        } else {
            cmd0.to_string()
        };
        let arg = parts.get(1).copied().unwrap_or("");

        let mut mode: Option<String> = None;
        let mut is_report_only = false;

        if cmd == "/ponytail-review" || cmd == "/ponytail:ponytail-review" {
            mode = Some("review".to_string());
        } else if cmd == "/ponytail" || cmd == "/ponytail:ponytail" {
            // `/ponytail default <mode>` persists the default to config.
            // review is not a valid default (#377); only off/lite/full/ultra.
            if arg == "default" {
                let dmode = parts.get(2).copied().unwrap_or("");
                if matches!(dmode, "off" | "lite" | "full" | "ultra") {
                    pt::write_default_mode(dmode);
                    pt::write_hook_output(
                        "UserPromptSubmit",
                        dmode,
                        &format!("PONYTAIL DEFAULT SET — new sessions start in {}.", dmode),
                    );
                }
                return; // don't fall through to the session-mode switch
            }
            if arg == "lite" {
                mode = Some("lite".to_string());
            } else if arg == "full" {
                mode = Some("full".to_string());
            } else if arg == "ultra" {
                mode = Some("ultra".to_string());
            } else if arg == "off" {
                mode = Some("off".to_string());
            } else if arg.is_empty() {
                is_report_only = true;
                mode = pt::read_mode(host).or_else(|| Some(pt::get_default_mode()));
            } else {
                mode = Some(pt::get_default_mode());
            }
        }

        if is_report_only {
            let m = mode.as_deref().unwrap_or("full");
            pt::write_hook_output(
                "UserPromptSubmit",
                m,
                &format!("PONYTAIL MODE ACTIVE — level: {}", m),
            );
        } else if let Some(m) = &mode {
            if m != "off" {
                pt::set_mode(host, m);
                mode_switched = true;
                // Qoder folds the confirmation into the ruleset below; one write.
                if !matches!(host, pt::Host::Qoder) {
                    pt::write_hook_output(
                        "UserPromptSubmit",
                        m,
                        &format!("PONYTAIL MODE CHANGED — level: {}", m),
                    );
                }
            } else {
                pt::clear_mode(host);
                deactivated = true;
                pt::write_hook_output("UserPromptSubmit", "off", "PONYTAIL MODE OFF");
            }
        }
    }

    // Detect standalone deactivation commands.
    if !mode_switched && !deactivated && pt::is_deactivation_command(&prompt) {
        pt::clear_mode(host);
        deactivated = true;
        pt::write_hook_output("UserPromptSubmit", "off", "PONYTAIL MODE OFF");
    }

    // Qoder has no SessionStart; UserPromptSubmit does double duty — activate
    // the default on first prompt then inject the ruleset every prompt. Skip
    // when just deactivated.
    if matches!(host, pt::Host::Qoder) && !deactivated {
        let mut current_mode = pt::read_mode(host);
        if current_mode.is_none() {
            let cm = pt::get_default_mode();
            if cm != "off" {
                pt::set_mode(host, &cm);
            }
            current_mode = Some(cm);
        }
        if let Some(cm) = current_mode {
            if cm != "off" {
                let header = if mode_switched {
                    format!("PONYTAIL MODE CHANGED — level: {}\n\n", cm)
                } else {
                    String::new()
                };
                pt::write_hook_output(
                    "UserPromptSubmit",
                    &cm,
                    &(header + &pt::get_ponytail_instructions(&cm)),
                );
            }
        }
    }
}

/// Rebuild the typed `/ponytail` command from the platform dispatch envelope
/// (`<command-name>`/`<command-args>`) when the prompt starts with it. Returns
/// `None` if there's no envelope or the captured name is empty (falsy in JS).
fn rebuild_command(prompt: &str) -> Option<String> {
    let name_re = Regex::new(
        r"^(?:<command-message>[^<]*</command-message>\s*)?<command-name>\s*/?([^<\n]*?)\s*</command-name>",
    )
    .expect("static envelope regex");
    let caps = name_re.captures(prompt)?;
    let name = caps.get(1)?.as_str();
    if name.is_empty() {
        return None;
    }
    let arg = Regex::new(r"<command-args>\s*([^<\n]*?)\s*</command-args>")
        .expect("static args regex")
        .captures(prompt)
        .map(|c| c.get(1).map(|m| m.as_str()).unwrap_or(""))
        .unwrap_or("");
    Some(format!("/{} {}", name, arg).trim().to_string())
}
