//! ponytail — runtime host detection, state, and hook output.
//!
//! Ported from `hooks/ponytail-runtime.js`.

use std::fs;
use std::path::PathBuf;

use crate::config;

const STATE_FILE: &str = ".ponytail-active";

/// Which host the hook is running under. Determines state location and the
/// exact JSON shape emitted on stdout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Host {
    Claude,
    Copilot,
    Codex,
    Qoder,
}

/// VS Code Copilot never sets `COPILOT_PLUGIN_DATA`; it only points
/// `CLAUDE_PLUGIN_ROOT` at an install path under `.vscode/agent-plugins/`.
pub fn is_vs_code_copilot_root(plugin_root: &str) -> bool {
    plugin_root
        .split(['/', '\\'])
        .any(|seg| seg.eq_ignore_ascii_case("agent-plugins"))
        && plugin_root.to_lowercase().contains(".vscode")
}

/// Detect the host from the relevant env signals.
pub fn detect_host(
    copilot_data: bool,
    plugin_data: bool,
    qoder_session: bool,
    plugin_root: Option<&str>,
) -> Host {
    let is_copilot = copilot_data
        || plugin_root
            .filter(|p| !p.is_empty())
            .map(is_vs_code_copilot_root)
            .unwrap_or(false);
    if is_copilot {
        return Host::Copilot;
    }
    if plugin_data {
        return Host::Codex;
    }
    if qoder_session {
        return Host::Qoder;
    }
    Host::Claude
}

/// Detect the host from the live process environment.
pub fn host() -> Host {
    detect_host(
        std::env::var("COPILOT_PLUGIN_DATA").is_ok(),
        std::env::var("PLUGIN_DATA").is_ok(),
        std::env::var("QODER_SESSION_ID").is_ok(),
        std::env::var("CLAUDE_PLUGIN_ROOT").ok().as_deref(),
    )
}

/// JSON-encode a string value, preserving exact escaping. Falls back to `""`.
fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// Build the exact stdout payload a host expects for a hook event.
///
/// `mode` is accepted for API parity with the JS port (which ignores it).
pub fn build_hook_output(event: &str, _mode: &str, context: &str, host: Host) -> String {
    let empty = context.is_empty();
    match host {
        Host::Copilot => {
            if event == "SessionStart" && !empty {
                format!("{{\"additionalContext\":{}}}", json_string(context))
            } else {
                "{}".to_string()
            }
        }
        Host::Codex | Host::Qoder => {
            if empty {
                "{}".to_string()
            } else {
                format!(
                    "{{\"hookSpecificOutput\":{{\"hookEventName\":{},\"additionalContext\":{}}}}}",
                    json_string(event),
                    json_string(context)
                )
            }
        }
        Host::Claude => {
            if event == "SubagentStart" {
                format!(
                    "{{\"hookSpecificOutput\":{{\"hookEventName\":{},\"additionalContext\":{}}}}}",
                    json_string(event),
                    json_string(context)
                )
            } else {
                context.to_string()
            }
        }
    }
}

/// Write the exact hook payload to stdout.
pub fn write_hook_output(event: &str, mode: &str, context: &str) {
    let payload = build_hook_output(event, mode, context, host());
    use std::io::Write;
    let _ = std::io::stdout().write_all(payload.as_bytes());
}

// --- state ---------------------------------------------------------------

/// Where the active-mode flag lives for a given host.
pub fn state_dir(host: Host) -> PathBuf {
    match host {
        Host::Codex => std::env::var("PLUGIN_DATA")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(config::get_claude_dir),
        Host::Copilot => std::env::var("COPILOT_PLUGIN_DATA")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(config::get_claude_dir),
        Host::Qoder => config::home().join(".qoder"),
        Host::Claude => config::get_claude_dir(),
    }
}

pub fn state_path(host: Host) -> PathBuf {
    state_dir(host).join(STATE_FILE)
}

/// Live mode written by activate/mode-tracker. Absent flag = ponytail off.
pub fn read_mode(host: Host) -> Option<String> {
    fs::read_to_string(state_path(host)).ok().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

pub fn set_mode(host: Host, mode: &str) {
    let path = state_path(host);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, mode);
}

pub fn clear_mode(host: Host) {
    let _ = fs::remove_file(state_path(host));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vscode_copilot_root_detection() {
        assert!(is_vs_code_copilot_root(
            "/home/u/.vscode/agent-plugins/ponytail"
        ));
        assert!(is_vs_code_copilot_root(
            "C:\\Users\\u\\.vscode\\agent-plugins\\ponytail"
        ));
        assert!(!is_vs_code_copilot_root("/home/u/.config/ponytail"));
        assert!(!is_vs_code_copilot_root(""));
    }

    #[test]
    fn host_detection_order() {
        // copilot wins over codex/qoder signals
        assert_eq!(detect_host(true, true, true, None), Host::Copilot);
        // vscode plugin root alone -> copilot
        assert_eq!(
            detect_host(false, true, true, Some("/x/.vscode/agent-plugins/p")),
            Host::Copilot
        );
        // codex when no copilot
        assert_eq!(detect_host(false, true, false, None), Host::Codex);
        // qoder
        assert_eq!(detect_host(false, false, true, None), Host::Qoder);
        // claude default
        assert_eq!(detect_host(false, false, false, None), Host::Claude);
        // empty plugin root ignored
        assert_eq!(detect_host(false, false, false, Some("")), Host::Claude);
    }

    #[test]
    fn copilot_hook_output() {
        // SessionStart with context
        assert_eq!(
            build_hook_output("SessionStart", "full", "hi", Host::Copilot),
            "{\"additionalContext\":\"hi\"}"
        );
        // non-SessionStart ignores context
        assert_eq!(
            build_hook_output("UserPromptSubmit", "full", "hi", Host::Copilot),
            "{}"
        );
        // SessionStart without context
        assert_eq!(
            build_hook_output("SessionStart", "full", "", Host::Copilot),
            "{}"
        );
    }

    #[test]
    fn codex_and_qoder_output() {
        let expected = "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"ctx\"}}";
        assert_eq!(
            build_hook_output("SessionStart", "full", "ctx", Host::Codex),
            expected
        );
        assert_eq!(
            build_hook_output("SessionStart", "full", "ctx", Host::Qoder),
            expected
        );
        assert_eq!(
            build_hook_output("SessionStart", "full", "", Host::Codex),
            "{}"
        );
    }

    #[test]
    fn claude_output() {
        // SubagentStart needs the JSON form
        assert_eq!(
            build_hook_output("SubagentStart", "full", "ctx", Host::Claude),
            "{\"hookSpecificOutput\":{\"hookEventName\":\"SubagentStart\",\"additionalContext\":\"ctx\"}}"
        );
        // other events: raw stdout
        assert_eq!(
            build_hook_output("SessionStart", "full", "raw text", Host::Claude),
            "raw text"
        );
    }

    #[test]
    fn hook_output_escapes_context() {
        let out = build_hook_output("SessionStart", "full", "a\"b\n", Host::Codex);
        assert!(out.contains("\"additionalContext\":\"a\\\"b\\n\""));
    }

    #[test]
    fn mode_param_ignored_matches_js() {
        // JS writeHookOutput ignores mode; output identical regardless.
        assert_eq!(
            build_hook_output("SessionStart", "full", "ctx", Host::Claude),
            build_hook_output("SessionStart", "off", "ctx", Host::Claude)
        );
    }
}
