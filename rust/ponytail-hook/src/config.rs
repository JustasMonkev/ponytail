//! ponytail — shared configuration resolver.
//!
//! Resolution order for default mode:
//!   1. `PONYTAIL_DEFAULT_MODE` environment variable
//!   2. Config file `defaultMode` field (BOM-tolerant)
//!   3. `"full"`
//!
//! Ported from `hooks/ponytail-config.js`.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

pub const DEFAULT_MODE: &str = "full";
pub const VALID_MODES: &[&str] = &["off", "lite", "full", "ultra", "review"];
pub const RUNTIME_MODES: &[&str] = &["off", "lite", "full", "ultra"];

/// Normalize a runtime mode (`off`/`lite`/`full`/`ultra`), or `None`.
pub fn normalize_mode(mode: &str) -> Option<String> {
    let n = mode.trim().to_lowercase();
    if RUNTIME_MODES.contains(&n.as_str()) {
        Some(n)
    } else {
        None
    }
}

/// Like [`normalize_mode`] but also accepts the session-only `review` mode
/// (valid in config, never a valid default).
pub fn normalize_config_mode(mode: &str) -> Option<String> {
    let n = mode.trim().to_lowercase();
    if VALID_MODES.contains(&n.as_str()) {
        Some(n)
    } else {
        None
    }
}

/// A persisted mode may be either a runtime level or the `review` session mode.
pub fn normalize_persisted_mode(mode: &str) -> Option<String> {
    normalize_mode(mode).or_else(|| normalize_config_mode(mode))
}

/// "stop ponytail" / "normal mode" turn ponytail off, but only as a standalone
/// command (ignoring case and trailing punctuation).
pub fn is_deactivation_command(text: &str) -> bool {
    fn is_trail(c: char) -> bool {
        c == '.' || c == '!' || c == '?' || c.is_whitespace()
    }
    let t = text.trim().to_lowercase();
    let t = t.trim_end_matches(is_trail);
    t == "stop ponytail" || t == "normal mode"
}

/// ponytail: only embed a path in a shell command when it is ordinary path
/// characters. Allowlist beats escaping every shell's metacharacters.
pub fn is_shell_safe(p: &str) -> bool {
    !p.is_empty()
        && p.bytes().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, b' ' | b'_' | b'.' | b'-' | b':' | b'/' | b'\\' | b'~')
        })
}

/// Strip a leading UTF-8 BOM (`U+FEFF`), common on Windows-saved files.
pub fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

/// Parse config text (BOM-stripped) into a JSON value.
pub fn parse_config_value(text: &str) -> serde_json::Result<Value> {
    serde_json::from_str(strip_bom(text))
}

/// Read a boolean field (`=== true`) from config text; `false` if absent,
/// invalid, or not a plain object.
pub fn config_bool_field(text: Option<&str>, field: &str) -> bool {
    match text.and_then(|t| parse_config_value(t).ok()) {
        Some(v) if v.is_object() => v.get(field).and_then(|f| f.as_bool()).unwrap_or(false),
        _ => false,
    }
}

/// Resolve a boolean env-or-config flag. Env takes precedence: any truthy value
/// except `0`/`false`/`no`/empty means true. Mirrors `getHideStatus` /
/// `getQuietStartup`.
pub fn resolve_bool_flag(env_val: Option<&str>, config_val: bool) -> bool {
    if let Some(env) = env_val {
        let v = env.trim().to_lowercase();
        return !v.is_empty() && v != "0" && v != "false" && v != "no";
    }
    config_val
}

/// Pure resolution of the default mode from env + config text.
pub fn resolve_default_mode(env_mode: Option<&str>, config_text: Option<&str>) -> String {
    if let Some(m) = env_mode {
        let n = m.to_lowercase();
        if RUNTIME_MODES.contains(&n.as_str()) {
            return n;
        }
    }
    if let Some(text) = config_text {
        if let Ok(v) = parse_config_value(text) {
            if let Some(m) = v.get("defaultMode").and_then(|x| x.as_str()) {
                let n = m.to_lowercase();
                if RUNTIME_MODES.contains(&n.as_str()) {
                    return n;
                }
            }
        }
    }
    DEFAULT_MODE.to_string()
}

/// Merge a field into config text, returning pretty JSON. Existing fields are
/// preserved; a non-object or unreadable file resets to `{}`.
pub fn set_config_field(text: Option<&str>, field: &str, value: Value) -> String {
    let mut obj = match text {
        Some(t) => match parse_config_value(t) {
            Ok(v) if v.is_object() => v,
            _ => Value::Object(serde_json::Map::new()),
        },
        None => Value::Object(serde_json::Map::new()),
    };
    if let Value::Object(ref mut m) = obj {
        m.insert(field.to_string(), value);
    }
    serde_json::to_string_pretty(&obj).expect("object serializes")
}

// --- paths ---------------------------------------------------------------

/// Best-effort home directory: `$HOME` then `$USERPROFILE`, else empty.
pub fn home() -> PathBuf {
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Ok(h) = std::env::var("USERPROFILE") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    PathBuf::new()
}

pub fn get_config_dir() -> PathBuf {
    if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return PathBuf::from(x).join("ponytail");
        }
    }
    if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Roaming"));
        return appdata.join("ponytail");
    }
    home().join(".config").join("ponytail")
}

pub fn get_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

/// `CLAUDE_CONFIG_DIR` overrides `~/.claude`, matching Claude Code.
pub fn get_claude_dir() -> PathBuf {
    std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".claude"))
}

// --- impure readers/writers ----------------------------------------------

fn read_config_text() -> Option<String> {
    fs::read_to_string(get_config_path()).ok()
}

/// Resolve the live default mode from env + config file, falling back to
/// [`DEFAULT_MODE`].
pub fn get_default_mode() -> String {
    let env_mode = std::env::var("PONYTAIL_DEFAULT_MODE").ok();
    resolve_default_mode(env_mode.as_deref(), read_config_text().as_deref())
}

pub fn get_quiet_startup() -> bool {
    let env_val = std::env::var("PONYTAIL_QUIET_STARTUP").ok();
    resolve_bool_flag(
        env_val.as_deref(),
        config_bool_field(read_config_text().as_deref(), "quietStartup"),
    )
}

pub fn get_hide_status() -> bool {
    let env_val = std::env::var("PONYTAIL_HIDE_STATUS").ok();
    resolve_bool_flag(
        env_val.as_deref(),
        config_bool_field(read_config_text().as_deref(), "hideStatus"),
    )
}

fn write_config_field(field: &str, value: Value) {
    let path = get_config_path();
    let text = fs::read_to_string(&path).ok();
    let body = set_config_field(text.as_deref(), field, value);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, body);
}

/// Persist `defaultMode`; only a runtime level is valid. Returns the normalized
/// mode, or `None` if invalid.
pub fn write_default_mode(mode: &str) -> Option<String> {
    let normalized = normalize_mode(mode)?;
    write_config_field("defaultMode", Value::String(normalized.clone()));
    Some(normalized)
}

/// Persist the status-badge preference (`hideStatus`).
pub fn write_hide_status(hide: bool) -> bool {
    write_config_field("hideStatus", Value::Bool(hide));
    hide
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_modes() {
        assert_eq!(normalize_mode("  FULL "), Some("full".into()));
        assert_eq!(normalize_mode("review"), None);
        assert_eq!(normalize_mode(""), None);
        assert_eq!(normalize_config_mode("review"), Some("review".into()));
        assert_eq!(normalize_config_mode("bogus"), None);
        // persisted accepts runtime or review
        assert_eq!(normalize_persisted_mode("Ultra"), Some("ultra".into()));
        assert_eq!(normalize_persisted_mode("Review"), Some("review".into()));
        assert_eq!(normalize_persisted_mode("nope"), None);
    }

    #[test]
    fn deactivation_command() {
        assert!(is_deactivation_command("stop ponytail"));
        assert!(is_deactivation_command("  Normal Mode!!  "));
        assert!(!is_deactivation_command("add a normal mode toggle"));
        assert!(!is_deactivation_command("please stop ponytail now"));
    }

    #[test]
    fn shell_safe_paths() {
        assert!(is_shell_safe("/home/u/.config/ponytail"));
        assert!(is_shell_safe("C:\\Users\\bob"));
        assert!(is_shell_safe("~/.config"));
        assert!(!is_shell_safe(""));
        assert!(!is_shell_safe("/tmp/a;rm -rf /"));
        assert!(!is_shell_safe("path with `backtick`"));
        assert!(!is_shell_safe("a'b"));
    }

    #[test]
    fn bom_stripped_before_parse() {
        let text = "\u{FEFF}{\"defaultMode\": \"lite\"}";
        let v = parse_config_value(text).unwrap();
        assert_eq!(v["defaultMode"], "lite");
    }

    #[test]
    fn default_mode_resolution_order() {
        // env wins
        assert_eq!(
            resolve_default_mode(Some("Ultra"), Some("{\"defaultMode\":\"off\"}")),
            "ultra"
        );
        // invalid env falls through to config
        assert_eq!(
            resolve_default_mode(Some("review"), Some("{\"defaultMode\":\"lite\"}")),
            "lite"
        );
        // config
        assert_eq!(
            resolve_default_mode(None, Some("{\"defaultMode\":\"off\"}")),
            "off"
        );
        // review never a default from config
        assert_eq!(
            resolve_default_mode(None, Some("{\"defaultMode\":\"review\"}")),
            "full"
        );
        // unreadable / missing -> default
        assert_eq!(resolve_default_mode(None, Some("{bad json")), "full");
        assert_eq!(resolve_default_mode(None, None), "full");
    }

    #[test]
    fn bool_flag_resolution() {
        assert!(resolve_bool_flag(Some("1"), false));
        assert!(resolve_bool_flag(Some("yes"), false));
        assert!(!resolve_bool_flag(Some("0"), true));
        assert!(!resolve_bool_flag(Some("false"), true));
        assert!(!resolve_bool_flag(Some(""), true));
        assert!(!resolve_bool_flag(Some("no"), true));
        // no env -> config wins
        assert!(resolve_bool_flag(None, true));
        assert!(!resolve_bool_flag(None, false));
    }

    #[test]
    fn config_bool_field_truthiness() {
        let t = Some("{\"quietStartup\": true, \"hideStatus\": false}");
        assert!(config_bool_field(t, "quietStartup"));
        assert!(!config_bool_field(t, "hideStatus"));
        assert!(!config_bool_field(t, "missing"));
        assert!(!config_bool_field(Some("not json"), "quietStartup"));
        assert!(!config_bool_field(None, "quietStartup"));
    }

    #[test]
    fn set_config_field_preserves_and_sets() {
        let existing = "{\"defaultMode\":\"lite\",\"hideStatus\":true}";
        let out = set_config_field(Some(existing), "defaultMode", Value::String("full".into()));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["defaultMode"], "full");
        assert_eq!(v["hideStatus"], true);

        // unreadable resets to an object with just the new field
        let out = set_config_field(Some("{bad"), "defaultMode", Value::String("off".into()));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["defaultMode"], "off");
        assert!(v.get("hideStatus").is_none());

        // fresh
        let out = set_config_field(None, "hideStatus", Value::Bool(true));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hideStatus"], true);
    }
}
