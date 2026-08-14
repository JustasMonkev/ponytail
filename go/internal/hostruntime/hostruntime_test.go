package hostruntime

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// clearHostEnv removes every host marker so each test starts from native Claude.
func clearHostEnv(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	for _, name := range []string{
		"COPILOT_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "PLUGIN_DATA",
		"QODER_SESSION_ID", "CLAUDE_CONFIG_DIR",
	} {
		t.Setenv(name, "")
		os.Unsetenv(name)
	}
	return home
}

func TestDetectNativeClaude(t *testing.T) {
	home := clearHostEnv(t)
	h := Detect()
	if h.IsCopilot || h.IsCodex || h.IsQoder {
		t.Errorf("expected native Claude, got %+v", h)
	}
	if want := filepath.Join(home, ".claude"); h.StateDir != want {
		t.Errorf("StateDir = %q, want %q", h.StateDir, want)
	}
}

func TestDetectCodex(t *testing.T) {
	clearHostEnv(t)
	dir := t.TempDir()
	t.Setenv("PLUGIN_DATA", dir)
	h := Detect()
	if !h.IsCodex || h.IsCopilot || h.IsQoder {
		t.Errorf("expected Codex, got %+v", h)
	}
	if h.StateDir != dir {
		t.Errorf("StateDir = %q, want %q", h.StateDir, dir)
	}
}

func TestDetectCopilotViaPluginData(t *testing.T) {
	clearHostEnv(t)
	dir := t.TempDir()
	t.Setenv("COPILOT_PLUGIN_DATA", dir)
	t.Setenv("PLUGIN_DATA", "/should/be/ignored")
	h := Detect()
	if !h.IsCopilot || h.IsCodex {
		t.Errorf("Copilot must win over Codex, got %+v", h)
	}
	if h.StateDir != dir {
		t.Errorf("StateDir = %q, want %q", h.StateDir, dir)
	}
}

// #528: VS Code Copilot never sets COPILOT_PLUGIN_DATA — it only injects
// CLAUDE_PLUGIN_ROOT under .vscode/agent-plugins/. Without the fallback,
// ponytail assumed native Claude and emitted a statusline nudge VS Code ignores.
func TestDetectVSCodeCopilotViaPluginRoot(t *testing.T) {
	home := clearHostEnv(t)

	roots := []string{
		"/Users/dev/.vscode/agent-plugins/ponytail",
		`C:\Users\dev\.VSCode\agent-plugins\ponytail`,
		"/home/dev/.vscode-insiders/agent-plugins/ponytail",
	}
	for _, root := range roots {
		t.Setenv("CLAUDE_PLUGIN_ROOT", root)
		h := Detect()
		if !h.IsCopilot {
			t.Errorf("CLAUDE_PLUGIN_ROOT=%q must detect as Copilot", root)
		}
		// COPILOT_PLUGIN_DATA is unset here, so state falls back to the Claude dir
		// rather than a path built from an empty string.
		if want := filepath.Join(home, ".claude"); h.StateDir != want {
			t.Errorf("StateDir = %q, want %q", h.StateDir, want)
		}
	}

	notCopilot := []string{
		"/opt/plugins/ponytail",
		"/home/dev/.vscode/plugins/ponytail", // right editor, wrong directory
		"/home/dev/agent-plugins/ponytail",   // right directory, wrong editor
		"/home/dev/.vscode/my-agent-plugins-backup/ponytail",
		"",
	}
	for _, root := range notCopilot {
		t.Setenv("CLAUDE_PLUGIN_ROOT", root)
		if Detect().IsCopilot {
			t.Errorf("CLAUDE_PLUGIN_ROOT=%q must not detect as Copilot", root)
		}
	}
}

func TestDetectQoder(t *testing.T) {
	home := clearHostEnv(t)
	t.Setenv("QODER_SESSION_ID", "abc123")
	h := Detect()
	if !h.IsQoder {
		t.Errorf("expected Qoder, got %+v", h)
	}
	if want := filepath.Join(home, ".qoder"); h.StateDir != want {
		t.Errorf("StateDir = %q, want %q", h.StateDir, want)
	}

	// Copilot and Codex both take precedence over Qoder.
	t.Setenv("PLUGIN_DATA", t.TempDir())
	if Detect().IsQoder {
		t.Error("Codex must take precedence over Qoder")
	}
}

func TestModeFlagRoundTrip(t *testing.T) {
	clearHostEnv(t)
	h := Detect()

	if got := h.ReadMode(); got != "" {
		t.Errorf("absent flag must read as empty, got %q", got)
	}
	// Clearing an absent flag must not error.
	h.ClearMode()

	if err := h.SetMode("ultra"); err != nil {
		t.Fatalf("SetMode created no directory: %v", err)
	}
	if got := h.ReadMode(); got != "ultra" {
		t.Errorf("ReadMode() = %q, want ultra", got)
	}

	// Trailing whitespace from an editor or shell must not corrupt the mode.
	if err := os.WriteFile(h.StatePath(), []byte("  lite \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := h.ReadMode(); got != "lite" {
		t.Errorf("ReadMode() = %q, want lite", got)
	}

	h.ClearMode()
	if got := h.ReadMode(); got != "" {
		t.Errorf("cleared flag must read as empty, got %q", got)
	}
}

func capture(h Host, event, context string) string {
	var buf bytes.Buffer
	h.WriteHookOutput(&buf, event, context)
	return buf.String()
}

func TestWriteHookOutputNativeClaude(t *testing.T) {
	clearHostEnv(t)
	h := Detect()

	// SessionStart accepts raw stdout.
	if got := capture(h, "SessionStart", "RULES"); got != "RULES" {
		t.Errorf("SessionStart = %q, want raw text", got)
	}
	if got := capture(h, "UserPromptSubmit", "MODE"); got != "MODE" {
		t.Errorf("UserPromptSubmit = %q, want raw text", got)
	}

	// SubagentStart needs the JSON form or the context is dropped.
	var parsed struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	out := capture(h, "SubagentStart", "RULES")
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("SubagentStart output is not JSON: %v (%q)", err, out)
	}
	if parsed.HookSpecificOutput.HookEventName != "SubagentStart" ||
		parsed.HookSpecificOutput.AdditionalContext != "RULES" {
		t.Errorf("unexpected SubagentStart payload: %s", out)
	}
}

func TestWriteHookOutputCopilot(t *testing.T) {
	clearHostEnv(t)
	t.Setenv("COPILOT_PLUGIN_DATA", t.TempDir())
	h := Detect()

	if got := capture(h, "SessionStart", "RULES"); got != `{"additionalContext":"RULES"}` {
		t.Errorf("SessionStart = %s", got)
	}
	// Copilot ignores output outside SessionStart, and empty context yields {}.
	if got := capture(h, "UserPromptSubmit", "RULES"); got != "{}" {
		t.Errorf("UserPromptSubmit = %s, want {}", got)
	}
	if got := capture(h, "SessionStart", ""); got != "{}" {
		t.Errorf("empty context = %s, want {}", got)
	}
}

func TestWriteHookOutputCodexAndQoder(t *testing.T) {
	for _, host := range []struct{ name, env string }{
		{"codex", "PLUGIN_DATA"},
		{"qoder", "QODER_SESSION_ID"},
	} {
		t.Run(host.name, func(t *testing.T) {
			clearHostEnv(t)
			t.Setenv(host.env, t.TempDir())
			h := Detect()

			got := capture(h, "SessionStart", "RULES")
			want := `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"RULES"}}`
			if got != want {
				t.Errorf("got %s, want %s", got, want)
			}
			// No systemMessage: Codex renders it as a yellow warning line (#605).
			if bytes.Contains([]byte(got), []byte("systemMessage")) {
				t.Error("output must not carry systemMessage")
			}
			if got := capture(h, "SessionStart", ""); got != "{}" {
				t.Errorf("empty context = %s, want {}", got)
			}
		})
	}
}

// JSON.stringify leaves < and & alone; Go's encoder escapes them by default,
// which would mangle the ruleset's <input type="date"> example.
func TestWriteHookOutputDoesNotEscapeHTML(t *testing.T) {
	clearHostEnv(t)
	t.Setenv("PLUGIN_DATA", t.TempDir())
	got := capture(Detect(), "SessionStart", `<input type="date"> && more`)
	if !bytes.Contains([]byte(got), []byte(`<input type=\"date\"> && more`)) {
		t.Errorf("HTML must not be unicode-escaped: %s", got)
	}
}
