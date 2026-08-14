package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sandbox isolates HOME, the config dir and the host markers, and points the
// ruleset at the condensed fallback so assertions don't depend on SKILL.md.
func sandbox(t *testing.T) (home string) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
	t.Setenv("PONYTAIL_SKILL_PATH", filepath.Join(home, "absent-skill.md"))
	for _, name := range []string{
		"CLAUDE_CONFIG_DIR", "COPILOT_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "PLUGIN_DATA",
		"PLUGIN_ROOT", "QODER_SESSION_ID", "PONYTAIL_DEFAULT_MODE", "PONYTAIL_SUBAGENT_MATCHER",
		"PONYTAIL_ROOT",
	} {
		os.Unsetenv(name)
	}
	return home
}

func claudeDir(home string) string { return filepath.Join(home, ".claude") }

func readFlag(t *testing.T, home string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(claudeDir(home), ".ponytail-active"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func writeSettings(t *testing.T, home, contents string) string {
	t.Helper()
	if err := os.MkdirAll(claudeDir(home), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(claudeDir(home), "settings.json")
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// --- activate ---

func TestActivateWritesFlagAndEmitsRuleset(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home, `{"statusLine":{"type":"command","command":"x"}}`)

	var out bytes.Buffer
	runActivate(&out)

	if got := readFlag(t, home); got != "full" {
		t.Errorf("flag = %q, want full", got)
	}
	if !strings.HasPrefix(out.String(), "PONYTAIL MODE ACTIVE — level: full") {
		t.Errorf("unexpected output: %.80s", out.String())
	}
}

func TestActivateHonoursConfiguredMode(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home, `{"statusLine":{}}`)
	t.Setenv("PONYTAIL_DEFAULT_MODE", "ultra")

	var out bytes.Buffer
	runActivate(&out)

	if got := readFlag(t, home); got != "ultra" {
		t.Errorf("flag = %q, want ultra", got)
	}
	if !strings.Contains(out.String(), "level: ultra") {
		t.Error("ruleset must be tagged ultra")
	}
}

// "off" skips activation entirely: no flag, no rules.
func TestActivateOffClearsFlag(t *testing.T) {
	home := sandbox(t)
	if err := os.MkdirAll(claudeDir(home), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir(home), ".ponytail-active"), []byte("full"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PONYTAIL_DEFAULT_MODE", "off")

	var out bytes.Buffer
	runActivate(&out)

	if got := readFlag(t, home); got != "" {
		t.Errorf("flag must be cleared, got %q", got)
	}
	if out.String() != "OK" {
		t.Errorf("native host expects OK, got %q", out.String())
	}
}

func TestActivateOffOnCodexEmitsEmptyJSON(t *testing.T) {
	sandbox(t)
	t.Setenv("PLUGIN_DATA", t.TempDir())
	t.Setenv("PONYTAIL_DEFAULT_MODE", "off")

	var out bytes.Buffer
	runActivate(&out)

	if out.String() != "{}" {
		t.Errorf("Codex off = %q, want {}", out.String())
	}
}

func TestActivateNudgesOnceWhenStatuslineMissing(t *testing.T) {
	sandbox(t)

	var first bytes.Buffer
	runActivate(&first)
	if !strings.Contains(first.String(), "STATUSLINE SETUP NEEDED") {
		t.Fatal("first session must nudge")
	}
	if !strings.Contains(first.String(), `"statusLine": { "type": "command", "command": `) {
		t.Errorf("nudge must carry a ready-to-paste snippet:\n%s", first.String())
	}

	// Repeating the hint every session start turns it into a nag.
	var second bytes.Buffer
	runActivate(&second)
	if strings.Contains(second.String(), "STATUSLINE SETUP NEEDED") {
		t.Error("second session must not nudge again")
	}
}

func TestActivateDoesNotNudgeWhenStatuslineConfigured(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home, `{"statusLine":{"type":"command","command":"anything"}}`)

	var out bytes.Buffer
	runActivate(&out)
	if strings.Contains(out.String(), "STATUSLINE SETUP NEEDED") {
		t.Error("a configured statusline must suppress the nudge")
	}
	if _, err := os.Stat(filepath.Join(claudeDir(home), ".ponytail-statusline-nudged")); err == nil {
		t.Error("no nudge flag should be written when nothing was nudged")
	}
}

// A BOM-prefixed settings.json still parses, so a configured statusline is seen.
func TestActivateReadsBOMSettings(t *testing.T) {
	home := sandbox(t)
	writeSettings(t, home, "\ufeff"+`{"statusLine":{"type":"command","command":"x"}}`)

	var out bytes.Buffer
	runActivate(&out)
	if strings.Contains(out.String(), "STATUSLINE SETUP NEEDED") {
		t.Error("BOM must not hide an existing statusLine")
	}
}

// Codex and Copilot don't render the badge, so they never get the nudge.
func TestActivateSkipsNudgeForCodexAndCopilot(t *testing.T) {
	for _, host := range []struct{ name, env string }{
		{"codex", "PLUGIN_DATA"},
		{"copilot", "COPILOT_PLUGIN_DATA"},
	} {
		t.Run(host.name, func(t *testing.T) {
			sandbox(t)
			t.Setenv(host.env, t.TempDir())

			var out bytes.Buffer
			runActivate(&out)
			if strings.Contains(out.String(), "STATUSLINE SETUP NEEDED") {
				t.Error("must not nudge a host that ignores the statusline")
			}
		})
	}
}

// --- prompt (mode tracker) ---

func runPromptWith(t *testing.T, prompt string) string {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"prompt": prompt})
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	runPrompt(bytes.NewReader(payload), &out)
	return out.String()
}

func TestPromptSwitchesMode(t *testing.T) {
	home := sandbox(t)
	for _, mode := range []string{"lite", "full", "ultra"} {
		out := runPromptWith(t, "/ponytail "+mode)
		if got := readFlag(t, home); got != mode {
			t.Errorf("/ponytail %s: flag = %q", mode, got)
		}
		if out != "PONYTAIL MODE CHANGED — level: "+mode {
			t.Errorf("/ponytail %s: output = %q", mode, out)
		}
	}
}

func TestPromptAcceptsAlternatePrefixesAndNamespace(t *testing.T) {
	home := sandbox(t)
	for _, command := range []string{"@ponytail ultra", "$ponytail ultra", "/ponytail:ponytail ultra"} {
		os.Remove(filepath.Join(claudeDir(home), ".ponytail-active"))
		runPromptWith(t, command)
		if got := readFlag(t, home); got != "ultra" {
			t.Errorf("%q: flag = %q, want ultra", command, got)
		}
	}
}

func TestPromptReviewIsSessionOnly(t *testing.T) {
	home := sandbox(t)
	runPromptWith(t, "/ponytail-review")
	if got := readFlag(t, home); got != "review" {
		t.Errorf("flag = %q, want review", got)
	}
	// review must never leak into the persisted default (#377).
	if _, err := os.Stat(filepath.Join(home, "xdg", "ponytail", "config.json")); err == nil {
		t.Error("/ponytail-review must not write config")
	}
}

func TestPromptBareCommandReportsWithoutChanging(t *testing.T) {
	home := sandbox(t)
	runPromptWith(t, "/ponytail lite")

	out := runPromptWith(t, "/ponytail")
	if out != "PONYTAIL MODE ACTIVE — level: lite" {
		t.Errorf("output = %q", out)
	}
	if got := readFlag(t, home); got != "lite" {
		t.Errorf("bare /ponytail must not change the mode, got %q", got)
	}
}

func TestPromptBareCommandFallsBackToDefault(t *testing.T) {
	sandbox(t)
	t.Setenv("PONYTAIL_DEFAULT_MODE", "ultra")
	if out := runPromptWith(t, "/ponytail"); out != "PONYTAIL MODE ACTIVE — level: ultra" {
		t.Errorf("output = %q", out)
	}
}

func TestPromptUnknownArgumentUsesDefault(t *testing.T) {
	home := sandbox(t)
	t.Setenv("PONYTAIL_DEFAULT_MODE", "lite")
	runPromptWith(t, "/ponytail banana")
	if got := readFlag(t, home); got != "lite" {
		t.Errorf("flag = %q, want lite", got)
	}
}

func TestPromptOffClearsFlag(t *testing.T) {
	home := sandbox(t)
	runPromptWith(t, "/ponytail ultra")

	if out := runPromptWith(t, "/ponytail off"); out != "PONYTAIL MODE OFF" {
		t.Errorf("output = %q", out)
	}
	if got := readFlag(t, home); got != "" {
		t.Errorf("flag must be cleared, got %q", got)
	}
}

func TestPromptDefaultSubcommandPersists(t *testing.T) {
	home := sandbox(t)
	out := runPromptWith(t, "/ponytail default ultra")
	if out != "PONYTAIL DEFAULT SET — new sessions start in ultra." {
		t.Errorf("output = %q", out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "xdg", "ponytail", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"defaultMode": "ultra"`) {
		t.Errorf("config = %s", raw)
	}
	// A default switch is not a session switch.
	if got := readFlag(t, home); got != "" {
		t.Errorf("/ponytail default must not write the session flag, got %q", got)
	}
}

func TestPromptDefaultRejectsReviewAndJunk(t *testing.T) {
	home := sandbox(t)
	for _, arg := range []string{"review", "banana", ""} {
		out := runPromptWith(t, strings.TrimSpace("/ponytail default "+arg))
		if out != "" {
			t.Errorf("/ponytail default %q: output = %q, want none", arg, out)
		}
		if _, err := os.Stat(filepath.Join(home, "xdg", "ponytail", "config.json")); err == nil {
			t.Errorf("/ponytail default %q must not write config", arg)
		}
	}
}

// #584: Claude Code dispatches /ponytail as a skill, so the prompt carries the
// skill body wrapped in XML tags rather than the typed command.
func TestPromptRebuildsSkillDispatchEnvelope(t *testing.T) {
	home := sandbox(t)
	runPromptWith(t, "<command-message>ponytail is running…</command-message><command-name>/ponytail</command-name><command-args>ultra</command-args>")
	if got := readFlag(t, home); got != "ultra" {
		t.Errorf("flag = %q, want ultra", got)
	}
}

func TestPromptIgnoresTagsMidMessage(t *testing.T) {
	home := sandbox(t)
	// The prompt is untrusted text: tags merely pasted or discussed must stay inert.
	runPromptWith(t, "here is an example: <command-name>/ponytail</command-name><command-args>ultra</command-args>")
	if got := readFlag(t, home); got != "" {
		t.Errorf("mid-message tags must not switch the mode, got %q", got)
	}
}

func TestPromptDeactivationCommands(t *testing.T) {
	home := sandbox(t)
	for _, text := range []string{"stop ponytail", "normal mode", "Stop Ponytail."} {
		runPromptWith(t, "/ponytail ultra")
		if out := runPromptWith(t, text); out != "PONYTAIL MODE OFF" {
			t.Errorf("%q: output = %q", text, out)
		}
		if got := readFlag(t, home); got != "" {
			t.Errorf("%q: flag must be cleared, got %q", text, got)
		}
	}
}

func TestPromptLeavesModeAloneForOrdinaryText(t *testing.T) {
	home := sandbox(t)
	runPromptWith(t, "/ponytail ultra")
	for _, text := range []string{"add a normal mode toggle", "please stop ponytail eventually", "refactor the parser"} {
		if out := runPromptWith(t, text); out != "" {
			t.Errorf("%q: output = %q, want none", text, out)
		}
		if got := readFlag(t, home); got != "ultra" {
			t.Errorf("%q: mode must survive, got %q", text, got)
		}
	}
}

func TestPromptSurvivesMalformedPayloads(t *testing.T) {
	home := sandbox(t)
	runPromptWith(t, "/ponytail ultra")

	for _, payload := range []string{``, `not json`, `{"prompt":`, `{}`, `{"prompt":123}`} {
		var out bytes.Buffer
		runPrompt(strings.NewReader(payload), &out)
		if out.String() != "" {
			t.Errorf("payload %q: output = %q, want none", payload, out.String())
		}
	}
	if got := readFlag(t, home); got != "ultra" {
		t.Errorf("a malformed payload must not disturb the mode, got %q", got)
	}
}

func TestPromptStripsBOM(t *testing.T) {
	home := sandbox(t)
	var out bytes.Buffer
	runPrompt(strings.NewReader("\ufeff"+`{"prompt":"/ponytail lite"}`), &out)
	if got := readFlag(t, home); got != "lite" {
		t.Errorf("flag = %q, want lite", got)
	}
}

// Qoder has no SessionStart, so UserPromptSubmit injects the ruleset each turn.
func TestPromptQoderInjectsRulesetEveryTurn(t *testing.T) {
	home := sandbox(t)
	t.Setenv("QODER_SESSION_ID", "session-1")
	qoderFlag := filepath.Join(home, ".qoder", ".ponytail-active")

	out := runPromptWith(t, "refactor the parser")
	var parsed struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("Qoder output is not JSON: %v (%q)", err, out)
	}
	if parsed.HookSpecificOutput.HookEventName != "UserPromptSubmit" {
		t.Errorf("event = %q", parsed.HookSpecificOutput.HookEventName)
	}
	if !strings.Contains(parsed.HookSpecificOutput.AdditionalContext, "PONYTAIL MODE ACTIVE") {
		t.Errorf("ruleset missing: %.80s", parsed.HookSpecificOutput.AdditionalContext)
	}
	raw, err := os.ReadFile(qoderFlag)
	if err != nil || strings.TrimSpace(string(raw)) != "full" {
		t.Errorf("Qoder must self-activate on the first prompt (%v, %q)", err, raw)
	}
}

// A mode switch folds its confirmation into the single ruleset write (one JSON).
func TestPromptQoderFoldsModeChangeIntoOneWrite(t *testing.T) {
	sandbox(t)
	t.Setenv("QODER_SESSION_ID", "session-1")

	out := runPromptWith(t, "/ponytail ultra")
	var parsed struct {
		HookSpecificOutput struct {
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("expected exactly one JSON object, got %q", out)
	}
	if !strings.HasPrefix(parsed.HookSpecificOutput.AdditionalContext, "PONYTAIL MODE CHANGED — level: ultra\n\n") {
		t.Errorf("confirmation header missing: %.60s", parsed.HookSpecificOutput.AdditionalContext)
	}
}

func TestPromptQoderSkipsInjectionAfterDeactivation(t *testing.T) {
	sandbox(t)
	t.Setenv("QODER_SESSION_ID", "session-1")
	runPromptWith(t, "/ponytail ultra")

	if out := runPromptWith(t, "stop ponytail"); !strings.Contains(out, "PONYTAIL MODE OFF") {
		t.Errorf("output = %q", out)
	} else if strings.Contains(out, "The ladder") {
		t.Error("a deactivated turn must not re-inject the ruleset")
	}
}

// --- subagent ---

func TestSubagentInjectsWhenActive(t *testing.T) {
	sandbox(t)
	runPromptWith(t, "/ponytail ultra")

	var out bytes.Buffer
	runSubagent(strings.NewReader(`{"agent_type":"general-purpose"}`), &out)

	var parsed struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, out.String())
	}
	if parsed.HookSpecificOutput.HookEventName != "SubagentStart" {
		t.Errorf("event = %q", parsed.HookSpecificOutput.HookEventName)
	}
	if !strings.Contains(parsed.HookSpecificOutput.AdditionalContext, "level: ultra") {
		t.Error("subagent must inherit the active level")
	}
}

func TestSubagentInjectsNothingWhenInactive(t *testing.T) {
	sandbox(t)
	var out bytes.Buffer
	runSubagent(strings.NewReader(`{}`), &out)
	if out.Len() != 0 {
		t.Errorf("no flag means no injection, got %q", out.String())
	}
}

func TestSubagentMatcherScopesInjection(t *testing.T) {
	sandbox(t)
	runPromptWith(t, "/ponytail full")
	t.Setenv("PONYTAIL_SUBAGENT_MATCHER", "explore|general")

	var matched bytes.Buffer
	runSubagent(strings.NewReader(`{"agent_type":"General-Purpose"}`), &matched)
	if matched.Len() == 0 {
		t.Error("matcher is case-insensitive and unanchored; this must match")
	}

	var skipped bytes.Buffer
	runSubagent(strings.NewReader(`{"agent_type":"code-reviewer"}`), &skipped)
	if skipped.Len() != 0 {
		t.Errorf("a definite mismatch must inject nothing, got %q", skipped.String())
	}
}

// Scoping must never silently drop the persona: anything short of a definite
// mismatch fails open.
func TestSubagentMatcherFailsOpen(t *testing.T) {
	sandbox(t)
	runPromptWith(t, "/ponytail full")

	cases := map[string]string{
		"unparseable payload": `not json`,
		"missing agent_type":  `{}`,
		"empty agent_type":    `{"agent_type":"   "}`,
		"null agent_type":     `{"agent_type":null}`,
	}
	t.Setenv("PONYTAIL_SUBAGENT_MATCHER", "^nothing-matches-this$")
	for name, payload := range cases {
		var out bytes.Buffer
		runSubagent(strings.NewReader(payload), &out)
		if out.Len() == 0 {
			t.Errorf("%s: must fail open and inject", name)
		}
	}

	// A bad regex is treated as "no matcher" rather than crashing the hook.
	t.Setenv("PONYTAIL_SUBAGENT_MATCHER", "([unclosed")
	var out bytes.Buffer
	runSubagent(strings.NewReader(`{"agent_type":"anything"}`), &out)
	if out.Len() == 0 {
		t.Error("an invalid matcher must fall back to injecting")
	}
}

// A non-string agent_type must be coerced the way JS coerces it, not treated as
// absent: reading it as "unknown" would fail open and inject into a subagent the
// user explicitly scoped out.
func TestSubagentMatcherCoercesNonStringAgentType(t *testing.T) {
	sandbox(t)
	runPromptWith(t, "/ponytail full")
	t.Setenv("PONYTAIL_SUBAGENT_MATCHER", "^explore$")

	for name, payload := range map[string]string{
		"number": `{"agent_type":42}`,
		"object": `{"agent_type":{"a":1}}`,
		"true":   `{"agent_type":true}`,
	} {
		var out bytes.Buffer
		runSubagent(strings.NewReader(payload), &out)
		if out.Len() != 0 {
			t.Errorf("%s: must be scoped out, not injected into", name)
		}
	}

	// The coerced value still matches when the matcher covers it.
	t.Setenv("PONYTAIL_SUBAGENT_MATCHER", "^42$")
	var out bytes.Buffer
	runSubagent(strings.NewReader(`{"agent_type":42}`), &out)
	if out.Len() == 0 {
		t.Error("a numeric agent_type must match its own string form")
	}
}

// --- statusline ---

func TestStatuslineBadge(t *testing.T) {
	home := sandbox(t)
	flagPath := filepath.Join(claudeDir(home), ".ponytail-active")
	if err := os.MkdirAll(claudeDir(home), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := map[string]string{
		"full":         "\033[38;5;108m[PONYTAIL]\033[0m",
		"":             "\033[38;5;108m[PONYTAIL]\033[0m",
		"  \n":         "\033[38;5;108m[PONYTAIL]\033[0m",
		"lite":         "\033[38;5;108m[PONYTAIL:LITE]\033[0m",
		"ultra":        "\033[38;5;173m[PONYTAIL:ULTRA]\033[0m",
		"review":       "\033[38;5;108m[PONYTAIL:REVIEW]\033[0m",
		"ultra\nextra": "\033[38;5;173m[PONYTAIL:ULTRA]\033[0m",
	}
	for contents, want := range cases {
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

func TestStatuslinePrintsNothingWithoutFlag(t *testing.T) {
	sandbox(t)
	var out bytes.Buffer
	runStatusline(&out)
	if out.Len() != 0 {
		t.Errorf("no flag means no badge, got %q", out.String())
	}
}

func TestStatuslineHonoursClaudeConfigDir(t *testing.T) {
	sandbox(t)
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, ".ponytail-active"), []byte("lite"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	runStatusline(&out)
	if !strings.Contains(out.String(), "PONYTAIL:LITE") {
		t.Errorf("got %q", out.String())
	}
}
