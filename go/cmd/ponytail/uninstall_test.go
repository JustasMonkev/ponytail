package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func uninstall(t *testing.T) (stdout string, stderr string) {
	t.Helper()
	var out, errOut bytes.Buffer
	if err := runUninstall(&out, &errOut); err != nil {
		t.Fatalf("runUninstall: %v", err)
	}
	return out.String(), errOut.String()
}

func settingsPath(home string) string {
	return filepath.Join(claudeDir(home), "settings.json")
}

func TestUninstallRemovesFlagAndConfig(t *testing.T) {
	home := sandbox(t)
	runPromptWith(t, "/ponytail ultra")
	runPromptWith(t, "/ponytail default lite")

	flagPath := filepath.Join(claudeDir(home), ".ponytail-active")
	configPath := filepath.Join(home, "xdg", "ponytail", "config.json")
	for _, path := range []string{flagPath, configPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("setup: %s missing: %v", path, err)
		}
	}

	stdout, _ := uninstall(t)

	for _, path := range []string{flagPath, configPath} {
		if _, err := os.Stat(path); err == nil {
			t.Errorf("%s must be removed", path)
		}
	}
	if !strings.Contains(stdout, "mode flag") || !strings.Contains(stdout, "config file") {
		t.Errorf("stdout must report what was removed:\n%s", stdout)
	}
}

func TestUninstallOnCleanMachineIsQuiet(t *testing.T) {
	sandbox(t)
	stdout, stderr := uninstall(t)
	if stdout != "" || stderr != "" {
		t.Errorf("nothing to clean must print nothing (%q / %q)", stdout, stderr)
	}
}

func TestUninstallRemovesOwnStatusLine(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home, `{"model":"opus","statusLine":{"type":"command","command":"bash /p/ponytail-statusline.sh"},"env":{"A":"1"}}`)

	stdout, _ := uninstall(t)
	if !strings.Contains(stdout, "Removed ponytail statusLine entry") {
		t.Errorf("stdout = %q", stdout)
	}

	raw, err := os.ReadFile(settingsPath(home))
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if _, ok := parsed["statusLine"]; ok {
		t.Error("ponytail statusLine must be removed")
	}
	// Everything else the user owns must survive, in its original order.
	if parsed["model"] != "opus" {
		t.Error("unrelated settings must survive")
	}
	if !strings.Contains(string(raw), "\"model\": \"opus\",\n  \"env\"") {
		t.Errorf("key order must be preserved:\n%s", raw)
	}
}

// The Go port installs itself as `"<exe>" statusline`, so uninstall must
// recognise that form as well as the legacy shell script.
func TestUninstallRemovesGoBinaryStatusLine(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home, `{"statusLine":{"type":"command","command":"\"/opt/ponytail/bin/ponytail\" statusline"}}`)

	uninstall(t)

	raw, _ := os.ReadFile(settingsPath(home))
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if _, ok := parsed["statusLine"]; ok {
		t.Errorf("Go statusline entry must be removed: %s", raw)
	}
}

func TestUninstallLeavesForeignStatusLineAlone(t *testing.T) {
	home := sandbox(t)
	original := `{"statusLine":{"type":"command","command":"bash ~/my-custom-statusline.sh"}}`
	writeSettings(t, home, original)

	stdout, _ := uninstall(t)
	if stdout != "" {
		t.Errorf("nothing of ours to remove, got %q", stdout)
	}

	raw, err := os.ReadFile(settingsPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != original {
		t.Errorf("a user's own statusLine must be left byte-for-byte intact:\n%s", raw)
	}
}

// #374: a combined statusline must keep the other plugin's part — uninstall must
// not nuke the whole command or leave a husk.
func TestUninstallKeepsOtherSegmentsOfCombinedStatusLine(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home,
		`{"statusLine":{"type":"command","command":"bash ~/caveman-statusline.sh && bash /p/ponytail-statusline.sh"}}`)

	stdout, _ := uninstall(t)
	if !strings.Contains(stdout, "Removed ponytail statusLine segment") {
		t.Errorf("stdout = %q", stdout)
	}

	raw, _ := os.ReadFile(settingsPath(home))
	var parsed struct {
		StatusLine struct {
			Type    string `json:"type"`
			Command string `json:"command"`
		} `json:"statusLine"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.StatusLine.Command != "bash ~/caveman-statusline.sh" {
		t.Errorf("command = %q", parsed.StatusLine.Command)
	}
	if parsed.StatusLine.Type != "command" {
		t.Error("sibling fields of statusLine must survive")
	}
}

func TestUninstallSplitsOnSemicolonsToo(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home,
		`{"statusLine":{"command":"bash /p/ponytail-statusline.sh; bash ~/other.sh"}}`)

	uninstall(t)

	raw, _ := os.ReadFile(settingsPath(home))
	if !strings.Contains(string(raw), "bash ~/other.sh") || strings.Contains(string(raw), "ponytail-statusline") {
		t.Errorf("settings = %s", raw)
	}
}

// #434: a malformed settings.json must not crash mid-cleanup. It can't be safely
// edited, so uninstall warns and leaves the file byte-for-byte intact instead of
// throwing after other state was already removed.
func TestUninstallLeavesMalformedSettingsIntact(t *testing.T) {
	home := sandbox(t)
	malformed := `{ "statusLine": { "command": "ponytail-statusline.sh", broken`
	writeSettings(t, home, malformed)
	runPromptWith(t, "/ponytail ultra")

	stdout, stderr := uninstall(t)
	if !strings.Contains(strings.ToLower(stdout+stderr), "malformed") {
		t.Errorf("must warn about the malformed file (%q / %q)", stdout, stderr)
	}

	raw, err := os.ReadFile(settingsPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != malformed {
		t.Errorf("malformed settings.json must be left unchanged:\n%s", raw)
	}
	// The rest of the cleanup still ran.
	if _, err := os.Stat(filepath.Join(claudeDir(home), ".ponytail-active")); err == nil {
		t.Error("the mode flag must still be removed")
	}
}

// A UTF-8 BOM must survive the rewrite (strip-on-read-but-not-write regression).
func TestUninstallPreservesBOM(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home, "\ufeff"+`{"statusLine":{"type":"command","command":"bash /p/ponytail-statusline.sh"}}`)

	uninstall(t)

	raw, err := os.ReadFile(settingsPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), "\ufeff") {
		t.Error("BOM must be preserved across the rewrite")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(string(raw), "\ufeff")), &parsed); err != nil {
		t.Fatal(err)
	}
	if _, ok := parsed["statusLine"]; ok {
		t.Error("ponytail entry must still be removed")
	}
}

// Shapes uninstall must not choke on or rewrite.
func TestUninstallIgnoresUnexpectedStatusLineShapes(t *testing.T) {
	for name, contents := range map[string]string{
		"no statusLine":       `{"model":"opus"}`,
		"statusLine a string": `{"statusLine":"bash ponytail-statusline.sh"}`,
		"command not string":  `{"statusLine":{"command":42}}`,
		"no command field":    `{"statusLine":{"type":"command"}}`,
		"top level array":     `[1,2,3]`,
	} {
		t.Run(name, func(t *testing.T) {
			home := sandbox(t)
			writeSettings(t, home, contents)

			if _, stderr := uninstall(t); stderr != "" && !strings.Contains(stderr, "malformed") {
				t.Errorf("unexpected stderr: %q", stderr)
			}
			raw, err := os.ReadFile(settingsPath(home))
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != contents {
				t.Errorf("settings must be left untouched:\n%s", raw)
			}
		})
	}
}

func TestUninstallHonoursClaudeConfigDir(t *testing.T) {
	sandbox(t)
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, ".ponytail-active"), []byte("full"), 0o644); err != nil {
		t.Fatal(err)
	}

	stdout, _ := uninstall(t)
	if !strings.Contains(stdout, dir) {
		t.Errorf("stdout = %q, want the overridden dir", stdout)
	}
	if _, err := os.Stat(filepath.Join(dir, ".ponytail-active")); err == nil {
		t.Error("flag in the overridden dir must be removed")
	}
}
