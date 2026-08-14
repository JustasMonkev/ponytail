package main

// JavaScript-compatibility regressions for the prompt hook: the payload and
// whitespace handling where a typed Go decode disagrees with JS property access.

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// JS splits on \s, which covers the Unicode space set. With Go's narrower class
// a non-breaking space stops separating the command from its argument.
func TestPromptSplitsOnUnicodeWhitespace(t *testing.T) {
	home := sandbox(t)
	for _, separator := range []string{" ", "\u00a0", "\u3000", "\v", "\t"} {
		os.Remove(filepath.Join(claudeDir(home), ".ponytail-active"))
		runPromptWith(t, "/ponytail"+separator+"ultra")
		if got := readFlag(t, home); got != "ultra" {
			t.Errorf("separator %q: flag = %q, want ultra", separator, got)
		}
	}
}

// A payload whose top level isn't an object reads as an empty prompt in JS —
// except null, which throws and aborts the turn. Qoder makes the difference
// visible, because an empty prompt still injects the ruleset there.
func TestPromptHandlesNonObjectPayloadsLikeJS(t *testing.T) {
	sandbox(t)
	t.Setenv("QODER_SESSION_ID", "session-1")

	for _, payload := range []string{`[]`, `123`, `"hello"`, `true`} {
		var out bytes.Buffer
		runPrompt(strings.NewReader(payload), &out)
		if !strings.Contains(out.String(), "PONYTAIL MODE ACTIVE") {
			t.Errorf("payload %s must read as an empty prompt, got %q", payload, out.String())
		}
	}

	var out bytes.Buffer
	runPrompt(strings.NewReader(`null`), &out)
	if out.Len() != 0 {
		t.Errorf("a null payload must abort the turn, got %q", out.String())
	}
}

// Reporting a mode change that was never persisted leaves the session lying
// about its own state.
func TestPromptStaysSilentWhenTheFlagCannotBeWritten(t *testing.T) {
	home := sandbox(t)
	// A directory where the flag file belongs makes the write fail.
	if err := os.MkdirAll(filepath.Join(claudeDir(home), ".ponytail-active"), 0o755); err != nil {
		t.Fatal(err)
	}
	if out := runPromptWith(t, "/ponytail ultra"); out != "" {
		t.Errorf("output = %q; nothing was persisted, so nothing should be claimed", out)
	}
}

// The statusline strips what `tr -d '[:space:]'` strips in the C locale — ASCII
// whitespace and NUL — and nothing more, or a padded flag reads as a different
// mode here than in the shell script, colour included.
func TestStatuslineStripsOnlyASCIIWhitespace(t *testing.T) {
	home := sandbox(t)
	if err := os.MkdirAll(claudeDir(home), 0o755); err != nil {
		t.Fatal(err)
	}
	flagPath := filepath.Join(claudeDir(home), ".ponytail-active")

	for contents, want := range map[string]string{
		"  ultra\t":         "\033[38;5;173m[PONYTAIL:ULTRA]\033[0m",
		"ul\x00tra":         "\033[38;5;173m[PONYTAIL:ULTRA]\033[0m",
		"\u00a0ultra\u00a0": "\033[38;5;108m[PONYTAIL:\u00a0ULTRA\u00a0]\033[0m",
	} {
		if err := os.WriteFile(flagPath, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		runStatusline(&out)
		if out.String() != want {
			t.Errorf("flag %q: got %q, want %q", contents, out.String(), want)
		}
	}
}
