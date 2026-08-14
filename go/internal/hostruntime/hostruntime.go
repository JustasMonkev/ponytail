// Package hostruntime is the Go port of hooks/ponytail-runtime.js — host
// detection, the mode flag file, and the per-host hook output format.
package hostruntime

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/DietrichGebert/ponytail/go/internal/config"
)

const stateFile = ".ponytail-active"

// Host describes which agent host is running the hook and where its state lives.
type Host struct {
	IsCopilot bool
	IsCodex   bool
	IsQoder   bool
	StateDir  string
}

// isVSCodeCopilotRoot reports whether a plugin root looks like VS Code Copilot's.
//
// ponytail: VS Code Copilot never sets COPILOT_PLUGIN_DATA — it only injects
// CLAUDE_PLUGIN_ROOT, pointed at an install path under .vscode/agent-plugins/
// (#528). Without this fallback isCopilot was false, so ponytail assumed native
// Claude Code and emitted the statusline nudge, which VS Code Copilot doesn't read.
func isVSCodeCopilotRoot(pluginRoot string) bool {
	if pluginRoot == "" {
		return false
	}
	hasSegment := false
	for _, segment := range strings.FieldsFunc(pluginRoot, func(r rune) bool { return r == '/' || r == '\\' }) {
		if segment == "agent-plugins" {
			hasSegment = true
			break
		}
	}
	return hasSegment && strings.Contains(strings.ToLower(pluginRoot), ".vscode")
}

// Detect resolves the host and its state directory from the environment.
func Detect() Host {
	h := Host{}
	h.IsCopilot = os.Getenv("COPILOT_PLUGIN_DATA") != "" || isVSCodeCopilotRoot(os.Getenv("CLAUDE_PLUGIN_ROOT"))
	h.IsCodex = !h.IsCopilot && os.Getenv("PLUGIN_DATA") != ""
	h.IsQoder = !h.IsCopilot && !h.IsCodex && os.Getenv("QODER_SESSION_ID") != ""

	h.StateDir = config.ClaudeDir()
	if h.IsCodex {
		h.StateDir = os.Getenv("PLUGIN_DATA")
	}
	// COPILOT_PLUGIN_DATA is unset under VS Code Copilot, so fall back to the
	// Claude dir rather than building a path from an empty string.
	if h.IsCopilot {
		if dir := os.Getenv("COPILOT_PLUGIN_DATA"); dir != "" {
			h.StateDir = dir
		} else {
			h.StateDir = config.ClaudeDir()
		}
	}
	if h.IsQoder {
		home, err := os.UserHomeDir()
		if err != nil {
			home = ""
		}
		h.StateDir = filepath.Join(home, ".qoder")
	}
	return h
}

func (h Host) StatePath() string {
	return filepath.Join(h.StateDir, stateFile)
}

func (h Host) SetMode(mode string) error {
	path := h.StatePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(mode), 0o644)
}

func (h Host) ClearMode() {
	_ = os.Remove(h.StatePath())
}

// ReadMode returns the live mode written by activate/mode-tracker. An absent
// flag means ponytail is off, and reads "" rather than erroring.
func (h Host) ReadMode() string {
	raw, err := os.ReadFile(h.StatePath())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

type hookSpecificOutput struct {
	HookEventName     string `json:"hookEventName"`
	AdditionalContext string `json:"additionalContext"`
}

type hookOutput struct {
	HookSpecificOutput *hookSpecificOutput `json:"hookSpecificOutput,omitempty"`
}

type copilotOutput struct {
	AdditionalContext string `json:"additionalContext,omitempty"`
}

// encode mirrors JSON.stringify: no HTML escaping, so the ruleset keeps its
// literal <input type="date"> rather than <input ...>.
func encode(value any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return []byte("{}")
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
}

// WriteHookOutput emits the hook payload in the shape the detected host reads.
func (h Host) WriteHookOutput(w io.Writer, event, context string) {
	switch {
	case h.IsCopilot:
		// Copilot reads additionalContext on SessionStart; ignores output elsewhere.
		out := copilotOutput{}
		if event == "SessionStart" && context != "" {
			out.AdditionalContext = context
		}
		_, _ = w.Write(encode(out))

	case h.IsCodex, h.IsQoder:
		// No systemMessage: Codex renders it as a yellow `warning:` line that reads
		// like an error every session, and dims the completed-hook bullet from green
		// to neutral (#605). The mode stays visible through the hook-context line
		// Codex prints from additionalContext. Qoder uses the same shape, and its
		// UserPromptSubmit additionalContext is injected into the Agent's conversation.
		out := hookOutput{}
		if context != "" {
			out.HookSpecificOutput = &hookSpecificOutput{HookEventName: event, AdditionalContext: context}
		}
		_, _ = w.Write(encode(out))

	case event == "SubagentStart":
		// Native Claude: SessionStart accepts raw stdout, but SubagentStart needs the
		// hookSpecificOutput JSON form or the context is dropped.
		_, _ = w.Write(encode(hookOutput{
			HookSpecificOutput: &hookSpecificOutput{HookEventName: event, AdditionalContext: context},
		}))

	default:
		_, _ = io.WriteString(w, context)
	}
}
