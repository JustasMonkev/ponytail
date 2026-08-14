package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// isolate points HOME and XDG_CONFIG_HOME at a fresh temp dir so tests never
// read or write the developer's real config.
func isolate(t *testing.T) (home string, configHome string) {
	t.Helper()
	home = t.TempDir()
	configHome = filepath.Join(home, "xdg")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("PONYTAIL_DEFAULT_MODE", "")
	t.Setenv("PONYTAIL_HIDE_STATUS", "")
	t.Setenv("PONYTAIL_QUIET_STARTUP", "")
	os.Unsetenv("PONYTAIL_DEFAULT_MODE")
	os.Unsetenv("PONYTAIL_HIDE_STATUS")
	os.Unsetenv("PONYTAIL_QUIET_STARTUP")
	return home, configHome
}

func writeConfig(t *testing.T, contents string) {
	t.Helper()
	path := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestNormalizeMode(t *testing.T) {
	cases := map[string]string{
		"full":     "full",
		"  ULTRA ": "ultra",
		"Lite":     "lite",
		"off":      "off",
		"review":   "", // session-only, not a runtime level (#377)
		"":         "",
		"nonsense": "",
	}
	for input, want := range cases {
		if got := NormalizeMode(input); got != want {
			t.Errorf("NormalizeMode(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizeConfigModeAcceptsReview(t *testing.T) {
	if got := NormalizeConfigMode(" Review "); got != "review" {
		t.Errorf("NormalizeConfigMode(review) = %q, want review", got)
	}
	if got := NormalizeConfigMode("bogus"); got != "" {
		t.Errorf("NormalizeConfigMode(bogus) = %q, want empty", got)
	}
}

func TestNormalizePersistedModePrefersRuntime(t *testing.T) {
	if got := NormalizePersistedMode("ultra"); got != "ultra" {
		t.Errorf("got %q", got)
	}
	if got := NormalizePersistedMode("review"); got != "review" {
		t.Errorf("got %q", got)
	}
	if got := NormalizePersistedMode("junk"); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestIsDeactivationCommand(t *testing.T) {
	on := []string{"stop ponytail", "Stop Ponytail", "  normal mode  ", "normal mode.", "stop ponytail!!", "NORMAL MODE?"}
	for _, input := range on {
		if !IsDeactivationCommand(input) {
			t.Errorf("IsDeactivationCommand(%q) = false, want true", input)
		}
	}
	// Only a standalone command counts: matching the phrase anywhere turned
	// ponytail off mid-task for ordinary requests.
	off := []string{
		"add a normal mode toggle",
		"please stop ponytail now",
		"stop ponytailing",
		"",
		"normal",
	}
	for _, input := range off {
		if IsDeactivationCommand(input) {
			t.Errorf("IsDeactivationCommand(%q) = true, want false", input)
		}
	}
}

func TestIsShellSafe(t *testing.T) {
	safe := []string{
		"/home/user/.claude/plugins/ponytail",
		`C:\Users\dev\ponytail`,
		"~/plugins/pony tail/hooks",
	}
	for _, p := range safe {
		if !IsShellSafe(p) {
			t.Errorf("IsShellSafe(%q) = false, want true", p)
		}
	}
	unsafe := []string{
		"", "/tmp/$(whoami)", "/tmp/a;rm -rf /", "/tmp/a&&b", "/tmp/`id`", `/tmp/"quoted"`, "/tmp/a|b", "/tmp/a\nb",
	}
	for _, p := range unsafe {
		if IsShellSafe(p) {
			t.Errorf("IsShellSafe(%q) = true, want false", p)
		}
	}
}

func TestConfigDirPrefersXDG(t *testing.T) {
	_, configHome := isolate(t)
	if got, want := ConfigDir(), filepath.Join(configHome, "ponytail"); got != want {
		t.Errorf("ConfigDir() = %q, want %q", got, want)
	}
}

func TestConfigDirFallsBackPerPlatform(t *testing.T) {
	home, _ := isolate(t)
	os.Unsetenv("XDG_CONFIG_HOME")

	want := filepath.Join(home, ".config", "ponytail")
	if runtime.GOOS == "windows" {
		want = filepath.Join(home, "AppData", "Roaming", "ponytail")
	}
	if got := ConfigDir(); got != want {
		t.Errorf("ConfigDir() = %q, want %q", got, want)
	}
}

func TestClaudeDirHonoursOverride(t *testing.T) {
	home, _ := isolate(t)
	if got, want := ClaudeDir(), filepath.Join(home, ".claude"); got != want {
		t.Errorf("ClaudeDir() = %q, want %q", got, want)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "/custom/claude")
	if got := ClaudeDir(); got != "/custom/claude" {
		t.Errorf("ClaudeDir() = %q, want /custom/claude", got)
	}
}

func TestGetDefaultModeResolutionOrder(t *testing.T) {
	isolate(t)

	if got := GetDefaultMode(); got != "full" {
		t.Errorf("no env, no config: got %q, want full", got)
	}

	writeConfig(t, `{"defaultMode":"ultra"}`)
	if got := GetDefaultMode(); got != "ultra" {
		t.Errorf("config: got %q, want ultra", got)
	}

	t.Setenv("PONYTAIL_DEFAULT_MODE", "LITE")
	if got := GetDefaultMode(); got != "lite" {
		t.Errorf("env wins: got %q, want lite", got)
	}
}

func TestGetDefaultModeRejectsReviewAndJunk(t *testing.T) {
	isolate(t)

	// review is session-only and must never become the default (#377).
	t.Setenv("PONYTAIL_DEFAULT_MODE", "review")
	if got := GetDefaultMode(); got != "full" {
		t.Errorf("env review: got %q, want full", got)
	}
	os.Unsetenv("PONYTAIL_DEFAULT_MODE")

	writeConfig(t, `{"defaultMode":"review"}`)
	if got := GetDefaultMode(); got != "full" {
		t.Errorf("config review: got %q, want full", got)
	}

	writeConfig(t, `{"defaultMode":42}`)
	if got := GetDefaultMode(); got != "full" {
		t.Errorf("non-string defaultMode: got %q, want full", got)
	}

	writeConfig(t, `{ not json`)
	if got := GetDefaultMode(); got != "full" {
		t.Errorf("malformed config: got %q, want full", got)
	}
}

func TestGetDefaultModeStripsBOM(t *testing.T) {
	isolate(t)
	writeConfig(t, "\ufeff"+`{"defaultMode":"lite"}`)
	if got := GetDefaultMode(); got != "lite" {
		t.Errorf("BOM config: got %q, want lite", got)
	}
}

func TestBooleanPreferences(t *testing.T) {
	isolate(t)

	if GetHideStatus() || GetQuietStartup() {
		t.Error("defaults must be false")
	}

	writeConfig(t, `{"hideStatus":true,"quietStartup":true}`)
	if !GetHideStatus() || !GetQuietStartup() {
		t.Error("config true must be honoured")
	}

	// An explicitly falsy env var overrides a true config value.
	for _, falsy := range []string{"", "0", "false", "no", " FALSE "} {
		t.Setenv("PONYTAIL_HIDE_STATUS", falsy)
		if GetHideStatus() {
			t.Errorf("PONYTAIL_HIDE_STATUS=%q must read as false", falsy)
		}
	}
	for _, truthy := range []string{"1", "true", "yes", "anything"} {
		t.Setenv("PONYTAIL_HIDE_STATUS", truthy)
		if !GetHideStatus() {
			t.Errorf("PONYTAIL_HIDE_STATUS=%q must read as true", truthy)
		}
	}
}

func TestWriteDefaultModeRejectsReview(t *testing.T) {
	isolate(t)

	if got, err := WriteDefaultMode("review"); err != nil || got != "" {
		t.Fatalf("WriteDefaultMode(review) = %q, %v; want empty, nil", got, err)
	}
	if _, err := os.Stat(ConfigPath()); err == nil {
		t.Error("rejected mode must not create a config file")
	}
}

func TestWriteDefaultModePreservesOtherKeys(t *testing.T) {
	isolate(t)
	writeConfig(t, `{"hideStatus":true,"somethingElse":"keep me"}`)

	if got, err := WriteDefaultMode(" Ultra "); err != nil || got != "ultra" {
		t.Fatalf("WriteDefaultMode = %q, %v", got, err)
	}

	raw, err := os.ReadFile(ConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["defaultMode"] != "ultra" || parsed["hideStatus"] != true || parsed["somethingElse"] != "keep me" {
		t.Errorf("unexpected config after write: %v", parsed)
	}
	if strings.HasSuffix(string(raw), "\n") {
		t.Error("config must match JSON.stringify: no trailing newline")
	}
}

func TestWriteDefaultModeRecoversFromMalformedConfig(t *testing.T) {
	isolate(t)
	writeConfig(t, `[1,2,3]`) // an array is not a config object

	if got, err := WriteDefaultMode("lite"); err != nil || got != "lite" {
		t.Fatalf("WriteDefaultMode = %q, %v", got, err)
	}
	if got := GetDefaultMode(); got != "lite" {
		t.Errorf("GetDefaultMode() = %q, want lite", got)
	}
}

func TestWriteHideStatusRoundTrips(t *testing.T) {
	isolate(t)

	if _, err := WriteDefaultMode("ultra"); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteHideStatus(true); err != nil {
		t.Fatal(err)
	}
	if !GetHideStatus() {
		t.Error("hideStatus must persist")
	}
	if got := GetDefaultMode(); got != "ultra" {
		t.Errorf("defaultMode must survive WriteHideStatus, got %q", got)
	}

	if _, err := WriteHideStatus(false); err != nil {
		t.Fatal(err)
	}
	if GetHideStatus() {
		t.Error("hideStatus must be clearable")
	}
}

func TestMarshalIndentDoesNotEscapeHTML(t *testing.T) {
	got, err := MarshalIndent(map[string]any{"command": `a && b <c>`})
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"command\": \"a && b <c>\"\n}"
	if string(got) != want {
		t.Errorf("MarshalIndent = %q, want %q", got, want)
	}
}
