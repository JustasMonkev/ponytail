//! Integration tests for the `ponytail-hook` binary. Each test spawns the
//! built binary in a hermetic env (isolated HOME/CLAUDE_CONFIG_DIR/XDG_CONFIG_HOME)
//! so it never touches the user's real config or flag files.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;

// Cargo sets `CARGO_BIN_EXE_<crate-name>` (hyphenated, lowercase) at compile
// time for integration tests; `env!` with the uppercase form fails. Fall back
// to the target dir path when invoked outside `cargo test`.
const BIN: &str = match option_env!("CARGO_BIN_EXE_ponytail-hook") {
    Some(p) => p,
    None => "target/debug/ponytail-hook",
};

fn claude_dir(dir: &Path) -> PathBuf {
    dir.join("claude")
}

fn flag_path(dir: &Path) -> PathBuf {
    claude_dir(dir).join(".ponytail-active")
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join("xdg").join("ponytail").join("config.json")
}

/// Hermetic env: HOME, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME all under the temp
/// dir; no host-detection vars leak through (env_clear).
fn base_env(dir: &Path) -> Vec<(&'static str, String)> {
    vec![
        ("HOME", dir.to_string_lossy().into_owned()),
        (
            "CLAUDE_CONFIG_DIR",
            claude_dir(dir).to_string_lossy().into_owned(),
        ),
        (
            "XDG_CONFIG_HOME",
            dir.join("xdg").to_string_lossy().into_owned(),
        ),
    ]
}

/// Spawn the binary with a closed stdin (data written then pipe closed → EOF).
fn run_closed(env: &[(&str, String)], args: &[&str], stdin: &[u8]) -> String {
    let mut cmd = Command::new(BIN);
    cmd.args(args);
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn");
    {
        let Some(mut s) = child.stdin.take() else {
            panic!("no stdin");
        };
        s.write_all(stdin).expect("write");
    } // dropping s closes the pipe → EOF
    let out = child.wait_with_output().expect("wait");
    assert!(out.status.success(), "non-zero exit: {:?}", out);
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn set_flag(dir: &Path, mode: &str) {
    fs::create_dir_all(claude_dir(dir)).unwrap();
    fs::write(flag_path(dir), mode).unwrap();
}

#[test]
fn activate_writes_flag_and_ruleset() {
    let dir = TempDir::new().unwrap();
    let mut env = base_env(dir.path());
    env.push(("PONYTAIL_DEFAULT_MODE", "full".into()));
    let out = run_closed(&env, &["activate"], &[]);
    assert!(out.contains("PONYTAIL MODE ACTIVE — level: full"));
    assert_eq!(fs::read_to_string(flag_path(dir.path())).unwrap(), "full");
}

#[test]
fn mode_switch() {
    let dir = TempDir::new().unwrap();
    let env = base_env(dir.path());
    let out = run_closed(&env, &["mode-tracker"], br#"{"prompt":"/ponytail ultra"}"#);
    assert_eq!(out, "PONYTAIL MODE CHANGED — level: ultra");
    assert_eq!(fs::read_to_string(flag_path(dir.path())).unwrap(), "ultra");
}

#[test]
fn default_write() {
    let dir = TempDir::new().unwrap();
    let env = base_env(dir.path());
    let out = run_closed(
        &env,
        &["mode-tracker"],
        br#"{"prompt":"/ponytail default lite"}"#,
    );
    assert_eq!(out, "PONYTAIL DEFAULT SET — new sessions start in lite.");
    let cfg = fs::read_to_string(config_path(dir.path())).unwrap();
    assert!(cfg.contains("\"defaultMode\": \"lite\""), "config: {}", cfg);
}

#[test]
fn deactivation() {
    let dir = TempDir::new().unwrap();
    set_flag(dir.path(), "full");
    let env = base_env(dir.path());
    let out = run_closed(&env, &["mode-tracker"], br#"{"prompt":"/ponytail off"}"#);
    assert_eq!(out, "PONYTAIL MODE OFF");
    assert!(!flag_path(dir.path()).exists());
}

#[test]
fn review_mode() {
    let dir = TempDir::new().unwrap();
    let env = base_env(dir.path());
    let out = run_closed(&env, &["mode-tracker"], br#"{"prompt":"/ponytail-review"}"#);
    assert_eq!(out, "PONYTAIL MODE CHANGED — level: review");
    assert_eq!(fs::read_to_string(flag_path(dir.path())).unwrap(), "review");
}

#[test]
fn subagent_no_matcher() {
    let dir = TempDir::new().unwrap();
    set_flag(dir.path(), "full");
    let env = base_env(dir.path());
    let out = run_closed(&env, &["subagent"], &[]);
    assert!(out.contains("\"hookSpecificOutput\""));
    assert!(out.contains("PONYTAIL MODE ACTIVE — level: full"));
}

#[test]
fn subagent_match() {
    let dir = TempDir::new().unwrap();
    set_flag(dir.path(), "full");
    let mut env = base_env(dir.path());
    env.push(("PONYTAIL_SUBAGENT_MATCHER", "general".into()));
    let out = run_closed(&env, &["subagent"], br#"{"agent_type":"general-purpose"}"#);
    assert!(out.contains("PONYTAIL MODE ACTIVE — level: full"));
}

#[test]
fn subagent_mismatch() {
    let dir = TempDir::new().unwrap();
    set_flag(dir.path(), "full");
    let mut env = base_env(dir.path());
    env.push(("PONYTAIL_SUBAGENT_MATCHER", "^general$".into()));
    let out = run_closed(&env, &["subagent"], br#"{"agent_type":"general-purpose"}"#);
    assert_eq!(out, "");
}

#[test]
fn subagent_invalid_matcher_fails_open() {
    let dir = TempDir::new().unwrap();
    set_flag(dir.path(), "full");
    let mut env = base_env(dir.path());
    env.push(("PONYTAIL_SUBAGENT_MATCHER", "[".into()));
    let out = run_closed(&env, &["subagent"], br#"{"agent_type":"general"}"#);
    assert!(out.contains("PONYTAIL MODE ACTIVE — level: full"));
}

#[test]
fn bom_input() {
    let dir = TempDir::new().unwrap();
    let env = base_env(dir.path());
    let out = run_closed(
        &env,
        &["mode-tracker"],
        b"\xEF\xBB\xBF{\"prompt\":\"/ponytail full\"}",
    );
    assert_eq!(out, "PONYTAIL MODE CHANGED — level: full");
}

#[test]
fn malformed_input_silent() {
    let dir = TempDir::new().unwrap();
    let env = base_env(dir.path());
    let out = run_closed(&env, &["mode-tracker"], b"not json at all");
    assert_eq!(out, "");
}

#[test]
fn completion_when_stdin_remains_open() {
    let dir = TempDir::new().unwrap();
    set_flag(dir.path(), "full");
    let mut env = base_env(dir.path());
    env.push(("PONYTAIL_SUBAGENT_MATCHER", "general".into()));

    let mut cmd = Command::new(BIN);
    cmd.args(["subagent"]);
    cmd.env_clear();
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn");
    // Hold stdin open (no write, no close) to simulate the swallowed pipe on
    // Windows (#443). The hook must still complete via the 1s fallback.
    let _stdin = child.stdin.take().expect("stdin");

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() > Duration::from_secs(3) => {
                let _ = child.kill();
                panic!("subagent did not complete with stdin open");
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("wait failed: {}", e),
        }
    };
    assert!(status.success());
    // Must have exercised the timeout fallback, not exited immediately.
    assert!(
        start.elapsed() >= Duration::from_millis(900),
        "finished too fast: {:?}",
        start.elapsed()
    );
    let mut buf = String::new();
    if let Some(mut out) = child.stdout.take() {
        out.read_to_string(&mut buf).expect("read stdout");
    }
    assert!(buf.contains("PONYTAIL MODE ACTIVE — level: full"));
}
