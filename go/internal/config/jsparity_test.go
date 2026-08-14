package config

// JavaScript-compatibility regressions. These are the string-handling details
// where Go's defaults quietly disagree with the JS the port replaces, and where
// disagreeing means two hosts resolve the same input to different intensities.

import (
	"os"
	"path/filepath"
	"testing"
)

// JS trims U+FEFF and does not trim U+0085; Go's unicode.IsSpace is the exact
// opposite. A BOM-prefixed mode is what a Windows-saved config produces.
func TestNormalizeModeMatchesJavaScriptTrim(t *testing.T) {
	for _, input := range []string{"\ufefffull", "full\ufeff", "\ufeff full \ufeff"} {
		if got := NormalizeMode(input); got != "full" {
			t.Errorf("NormalizeMode(%q) = %q, want full", input, got)
		}
	}
	for _, input := range []string{"\u0085full", "full\u0085"} {
		if got := NormalizeMode(input); got != "" {
			t.Errorf("NormalizeMode(%q) = %q; U+0085 is not JS whitespace", input, got)
		}
	}
}

// JS toLowerCase maps U+0130 to "i" + U+0307, so "LİTE" is not a mode name.
// Go's simple case mapping would fold it to a valid "lite".
func TestNormalizeModeMatchesJavaScriptLowercasing(t *testing.T) {
	for _, input := range []string{"LİTE", "lİte", "REVİEW"} {
		if got := NormalizeConfigMode(input); got != "" {
			t.Errorf("NormalizeConfigMode(%q) = %q, want empty", input, got)
		}
	}
	if got := NormalizeMode("LITE"); got != "lite" {
		t.Errorf("plain ASCII must still fold, got %q", got)
	}
}

func TestDeactivationCommandUsesJavaScriptWhitespace(t *testing.T) {
	if !IsDeactivationCommand("stop ponytail\ufeff") {
		t.Error("a trailing U+FEFF must not defeat the deactivation command")
	}
	if IsDeactivationCommand("stop ponytail\u0085") {
		t.Error("U+0085 is not whitespace to JavaScript, so this is not the command")
	}
}

func TestEnvFlagsUseJavaScriptWhitespace(t *testing.T) {
	isolate(t)
	t.Setenv("PONYTAIL_HIDE_STATUS", "\ufeff0")
	if GetHideStatus() {
		t.Error("a BOM-padded 0 trims to 0, which reads as false")
	}
	t.Setenv("PONYTAIL_HIDE_STATUS", "\u00850")
	if !GetHideStatus() {
		t.Error("U+0085 is not trimmed, so the value is not literally 0")
	}
}

// os.UserHomeDir only reads $HOME, and filepath.Join("", x) is relative — which
// would scatter ponytail's state into whatever directory a hook ran from.
func TestHomeDirNeverYieldsARelativePath(t *testing.T) {
	os.Unsetenv("HOME")
	os.Unsetenv("USERPROFILE")
	os.Unsetenv("XDG_CONFIG_HOME")
	os.Unsetenv("CLAUDE_CONFIG_DIR")
	t.Cleanup(func() { os.Setenv("HOME", os.TempDir()) })

	for name, path := range map[string]string{"ClaudeDir": ClaudeDir(), "ConfigDir": ConfigDir()} {
		if !filepath.IsAbs(path) {
			t.Errorf("%s() = %q, must be absolute", name, path)
		}
	}
}

// Rewriting the config must not reshuffle the user's other keys.
func TestWriteDefaultModePreservesKeyOrder(t *testing.T) {
	isolate(t)
	writeConfig(t, `{"zzz":1,"aaa":2,"mmm":3}`)

	if _, err := WriteDefaultMode("ultra"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(ConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"zzz\": 1,\n  \"aaa\": 2,\n  \"mmm\": 3,\n  \"defaultMode\": \"ultra\"\n}"
	if string(raw) != want {
		t.Errorf("got:\n%s\nwant:\n%s", raw, want)
	}
}
