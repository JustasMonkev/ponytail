package main

// Port of hooks/ponytail-activate.js — the SessionStart activation hook.
//
// Runs on every session start:
//  1. Writes flag file at $CLAUDE_CONFIG_DIR/.ponytail-active (defaults to
//     ~/.claude; the statusline reads this)
//  2. Emits the ponytail ruleset as hidden SessionStart context
//  3. Detects missing statusline config and emits a setup nudge

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"

	"github.com/DietrichGebert/ponytail/go/internal/config"
	"github.com/DietrichGebert/ponytail/go/internal/hostruntime"
	"github.com/DietrichGebert/ponytail/go/internal/instructions"
)

const nudgeFlagFile = ".ponytail-statusline-nudged"

func runActivate(stdout io.Writer) {
	host := hostruntime.Detect()
	claudeDir := config.ClaudeDir()
	settingsPath := filepath.Join(claudeDir, "settings.json")

	mode := config.GetDefaultMode()

	// "off" mode — skip activation entirely, don't write the flag or emit rules.
	if mode == "off" {
		host.ClearMode()
		hookOutput := "OK"
		if host.IsCodex || host.IsCopilot {
			hookOutput = ""
		}
		host.WriteHookOutput(stdout, "SessionStart", hookOutput)
		return
	}

	// 1. Write flag file. Silent fail — the flag is best-effort, don't block the hook.
	_ = host.SetMode(mode)

	// 2. Emit the ponytail ruleset, filtered to the active intensity level.
	output := instructions.GetPonytailInstructions(mode)

	// 3. Detect missing statusline config — nudge Claude to help set it up.
	if !host.IsCodex && !host.IsCopilot {
		output += statuslineNudge(claudeDir, settingsPath)
	}

	host.WriteHookOutput(stdout, "SessionStart", output)
}

// isTruthyJSON reports JavaScript truthiness for a decoded JSON value: null,
// false, 0 and "" are falsy, every object and non-empty value is truthy.
func isTruthyJSON(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		return v != ""
	default:
		return true
	}
}

// statuslineNudge returns the setup hint, or "" when the statusline is already
// configured or the user has already been nudged once.
func statuslineNudge(claudeDir, settingsPath string) string {
	if raw, err := os.ReadFile(settingsPath); err == nil {
		var settings map[string]any
		// Strip the UTF-8 BOM some editors prepend on Windows (breaks the parse).
		if err := json.Unmarshal(config.StripBOM(raw), &settings); err != nil {
			// A settings.json that exists but won't parse aborts the whole check in
			// the JS, nudge included. Nudging anyway would tell the agent to add a
			// second statusLine to a file that may already have one.
			return ""
		}
		// JS tests `settings.statusLine` for truthiness, so null/false/""/0 count
		// as unconfigured — a key-presence test would silently skip the nudge.
		if isTruthyJSON(settings["statusLine"]) {
			return ""
		}
	}

	// Nudge at most once — the flag file marks that the user has already seen
	// (and implicitly declined) the statusline setup offer. Repeating it every
	// session start turns a helpful hint into a nag.
	nudgeFlagPath := filepath.Join(claudeDir, nudgeFlagFile)
	if _, err := os.Stat(nudgeFlagPath); err == nil {
		return ""
	}
	// Recording the nudge is best-effort, exactly as in the JS: if the directory
	// can't be written the hint is still worth emitting, it just repeats.
	_ = os.WriteFile(nudgeFlagPath, nil, 0o644)

	exe, err := os.Executable()
	if err != nil {
		exe = "ponytail"
	}
	if !config.IsShellSafe(exe) {
		// ponytail: install path has shell metacharacters — don't embed it in a
		// command snippet; have the agent wire it up by hand instead.
		return "\n\n" +
			"STATUSLINE SETUP NEEDED: The ponytail plugin includes a statusline badge showing active mode. " +
			"Its install path contains characters unsafe to embed in a shell command, so configure it manually: " +
			"add a statusLine command of type \"command\" that runs `ponytail statusline` from the plugin's install directory to " +
			settingsPath + ", quoting/escaping the path for your shell. " +
			"Proactively offer to set this up for the user on first interaction."
	}

	command := `"` + exe + `" statusline`
	encoded, err := json.Marshal(command)
	if err != nil {
		return ""
	}
	return "\n\n" +
		"STATUSLINE SETUP NEEDED: The ponytail plugin includes a statusline badge showing active mode " +
		"(e.g. [PONYTAIL], [PONYTAIL:ULTRA]). It is not configured yet. " +
		"To enable, add this to " + settingsPath + ": " +
		`"statusLine": { "type": "command", "command": ` + string(encoded) + " }" + " " +
		"Proactively offer to set this up for the user on first interaction."
}
