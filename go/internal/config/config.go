// Package config is the Go port of hooks/ponytail-config.js — the shared
// configuration resolver.
//
// Resolution order for default mode:
//  1. PONYTAIL_DEFAULT_MODE environment variable
//  2. Config file defaultMode field:
//     - $XDG_CONFIG_HOME/ponytail/config.json (any platform, if set)
//     - ~/.config/ponytail/config.json (macOS / Linux fallback)
//     - %APPDATA%\ponytail\config.json (Windows fallback)
//  3. "full"
package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode"
)

const DefaultMode = "full"

// VALID_MODES / RUNTIME_MODES from the JS. review is session-only and never a
// valid default (#377), so it lives in ValidModes but not RuntimeModes.
var (
	ValidModes   = []string{"off", "lite", "full", "ultra", "review"}
	RuntimeModes = []string{"off", "lite", "full", "ultra"}
)

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// NormalizeMode returns the runtime level, or "" when mode is not one.
func NormalizeMode(mode string) string {
	normalized := strings.ToLower(strings.TrimSpace(mode))
	if contains(RuntimeModes, normalized) {
		return normalized
	}
	return ""
}

// NormalizeConfigMode also accepts review.
func NormalizeConfigMode(mode string) string {
	normalized := strings.ToLower(strings.TrimSpace(mode))
	if contains(ValidModes, normalized) {
		return normalized
	}
	return ""
}

func NormalizePersistedMode(mode string) string {
	if m := NormalizeMode(mode); m != "" {
		return m
	}
	return NormalizeConfigMode(mode)
}

// IsDeactivationCommand reports whether the whole message is "stop ponytail" or
// "normal mode". Matching the phrase anywhere in the message turned ponytail off
// mid-task for ordinary requests like "add a normal mode toggle", so require the
// whole message to be the command, ignoring case and trailing punctuation.
func IsDeactivationCommand(text string) bool {
	t := strings.ToLower(strings.TrimSpace(text))
	t = strings.TrimRightFunc(t, func(r rune) bool {
		return r == '.' || r == '!' || r == '?' || unicode.IsSpace(r)
	})
	return t == "stop ponytail" || t == "normal mode"
}

var shellSafeRe = regexp.MustCompile(`^[A-Za-z0-9 _.\-:/\\~]+$`)

// IsShellSafe reports whether a path is made only of ordinary path characters.
//
// ponytail: only embed the plugin install path in a statusline shell command when
// it's made of ordinary path characters. An allowlist beats escaping every shell's
// metacharacters; a hostile clone path (quotes, &, $, backtick, ;, etc.) falls back
// to manual setup instead. Allows : \ / for normal Windows and POSIX paths. Full
// per-shell escaper only if a real need appears.
func IsShellSafe(p string) bool {
	return shellSafeRe.MatchString(p)
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

func ConfigDir() string {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "ponytail")
	}
	if runtime.GOOS == "windows" {
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = filepath.Join(homeDir(), "AppData", "Roaming")
		}
		return filepath.Join(appData, "ponytail")
	}
	return filepath.Join(homeDir(), ".config", "ponytail")
}

func ConfigPath() string {
	return filepath.Join(ConfigDir(), "config.json")
}

// ClaudeDir honours CLAUDE_CONFIG_DIR, matching Claude Code.
func ClaudeDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	return filepath.Join(homeDir(), ".claude")
}

// ReadJSONFile parses a JSON object, stripping the UTF-8 BOM Windows editors
// prepend. A missing or malformed file yields nil, matching the JS try/catch.
func ReadJSONFile(path string) map[string]any {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(StripBOM(raw), &parsed); err != nil {
		return nil
	}
	return parsed
}

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

func StripBOM(raw []byte) []byte {
	return bytes.TrimPrefix(raw, utf8BOM)
}

// MarshalIndent mirrors JSON.stringify(value, null, 2): two-space indent and no
// HTML escaping, so a statusline command keeps its literal & and < characters.
func MarshalIndent(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func configString(cfg map[string]any, key string) string {
	if cfg == nil {
		return ""
	}
	v, _ := cfg[key].(string)
	return v
}

// GetDefaultMode resolves env, then config file, then "full".
func GetDefaultMode() string {
	// 1. Environment variable (highest priority).
	// ponytail: a default must be a runtime level (off/lite/full/ultra); review is
	// a session-only mode, never a valid default (#377).
	if env := os.Getenv("PONYTAIL_DEFAULT_MODE"); env != "" {
		if lowered := strings.ToLower(env); contains(RuntimeModes, lowered) {
			return lowered
		}
	}

	// 2. Config file.
	if mode := configString(ReadJSONFile(ConfigPath()), "defaultMode"); mode != "" {
		if lowered := strings.ToLower(mode); contains(RuntimeModes, lowered) {
			return lowered
		}
	}

	// 3. Default.
	return DefaultMode
}

// envFlag reads a boolean env var where any value other than "", 0, false and no
// counts as true. The bool result reports whether the var was set at all.
func envFlag(name string) (bool, bool) {
	raw, ok := os.LookupEnv(name)
	if !ok {
		return false, false
	}
	v := strings.ToLower(strings.TrimSpace(raw))
	return v != "" && v != "0" && v != "false" && v != "no", true
}

func configBool(cfg map[string]any, key string) bool {
	if cfg == nil {
		return false
	}
	v, _ := cfg[key].(bool)
	return v
}

// GetQuietStartup silences the pi "Ponytail loaded" startup toast while keeping
// ponytail active. PONYTAIL_QUIET_STARTUP takes precedence over config.
func GetQuietStartup() bool {
	if value, set := envFlag("PONYTAIL_QUIET_STARTUP"); set {
		return value
	}
	return configBool(ReadJSONFile(ConfigPath()), "quietStartup")
}

// GetHideStatus hides the status-bar indicator while keeping ponytail active
// (#324). PONYTAIL_HIDE_STATUS takes precedence over config.
func GetHideStatus() bool {
	if value, set := envFlag("PONYTAIL_HIDE_STATUS"); set {
		return value
	}
	return configBool(ReadJSONFile(ConfigPath()), "hideStatus")
}

// writeConfigField merges one key into the config file, preserving every other
// key and creating the directory when missing.
func writeConfigField(key string, value any) error {
	path := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	cfg := ReadJSONFile(path)
	if cfg == nil {
		cfg = map[string]any{}
	}
	cfg[key] = value
	encoded, err := MarshalIndent(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, encoded, 0o644)
}

// WriteDefaultMode persists the default mode, returning the normalized value or
// "" when the mode is not a runtime level (review is session-only, #377).
func WriteDefaultMode(mode string) (string, error) {
	normalized := NormalizeMode(mode)
	if normalized == "" {
		return "", nil
	}
	if err := writeConfigField("defaultMode", normalized); err != nil {
		return "", err
	}
	return normalized, nil
}

// WriteHideStatus persists the status-badge preference (#618). The
// PONYTAIL_HIDE_STATUS env var still wins over the stored value on read.
func WriteHideStatus(hide bool) (bool, error) {
	if err := writeConfigField("hideStatus", hide); err != nil {
		return false, err
	}
	return hide, nil
}
