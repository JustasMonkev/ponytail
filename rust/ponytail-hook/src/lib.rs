//! ponytail-hook — shared hook behavior, Rust port of the JS config/runtime
//! modules.

pub mod config;
pub mod instructions;
pub mod runtime;

pub use config::{
    config_bool_field, get_claude_dir, get_config_dir, get_config_path, get_default_mode,
    get_hide_status, get_quiet_startup, is_deactivation_command, is_shell_safe,
    normalize_config_mode, normalize_mode, normalize_persisted_mode, parse_config_value,
    resolve_bool_flag, resolve_default_mode, set_config_field, strip_bom, write_default_mode,
    write_hide_status,
};
pub use instructions::{
    filter_skill_body_for_mode, get_fallback_instructions, get_ponytail_instructions,
    get_subagent_instructions,
};
pub use runtime::{
    build_hook_output, clear_mode, detect_host, host, is_vs_code_copilot_root, read_mode, set_mode,
    state_dir, state_path, write_hook_output, Host,
};

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Resolve the plugin install root: `PONYTAIL_PLUGIN_ROOT` env, then
/// `CLAUDE_PLUGIN_ROOT` env, then the nearest ancestor of the running
/// executable containing `skills/ponytail/SKILL.md`. Empty if none found.
///
/// Mirrors `instructions::resolve_plugin_root`; duplicated here so the command
/// modules can locate sibling assets (the statusline scripts) without widening
/// the worker modules' public surface.
pub fn plugin_root() -> PathBuf {
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

/// Read stdin until EOF, with a hard timeout fallback so a swallowed pipe
/// (Windows PowerShell `if {}` wrapper, #443) can never hang the session.
/// Returns whatever arrived — possibly empty or partial — mirroring the JS
/// `data`/`end` + 1s `setTimeout` contract. Malformed/BOM input is left
/// untouched for the caller to handle fail-open.
pub fn read_stdin_with_timeout(timeout: Duration) -> String {
    let input = Arc::new(Mutex::new(String::new()));
    let done = Arc::new(AtomicBool::new(false));
    let (input_c, done_c) = (Arc::clone(&input), Arc::clone(&done));
    // Detached reader: it accumulates chunks incrementally (so a timed-out
    // partial payload is recoverable, as in JS), and is killed when the
    // process exits — no join, no blocking the normal EOF path.
    let _ = thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut g) = input_c.lock() {
                        g.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
            }
        }
        done_c.store(true, Ordering::SeqCst);
    });

    let start = Instant::now();
    while start.elapsed() < timeout {
        if done.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    input.lock().map(|g| g.clone()).unwrap_or_default()
}
