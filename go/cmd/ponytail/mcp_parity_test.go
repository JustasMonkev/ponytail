package main

// Differential test for the MCP mode resolution against ponytail-mcp/instructions.js.
// That module is SDK-free, so this runs without an npm install.

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	gomcp "github.com/DietrichGebert/ponytail/go/internal/mcp"
)

func TestMCPModeResolutionMatchesNode(t *testing.T) {
	root := repoRoot(t)
	node := nodeBinary(t)
	harness := filepath.Join(root, "go", "testdata", "dump-mcp.mjs")

	// Each case pins the requested mode and the configured default, since the
	// fallback chain runs through both.
	for _, defaultMode := range []string{"", "lite", "ultra", "off"} {
		for _, requested := range parityModes {
			name := "default=" + orNone(defaultMode) + "/requested=" + orNone(strings.TrimSpace(requested))
			t.Run(name, func(t *testing.T) {
				env, home := parityEnv(t)
				if defaultMode != "" {
					env = append(env, "PONYTAIL_DEFAULT_MODE="+defaultMode)
				}

				cmd := exec.Command(node, harness, root, requested)
				cmd.Env = env
				var stderr bytes.Buffer
				cmd.Stderr = &stderr
				raw, err := cmd.Output()
				if err != nil {
					t.Fatalf("node harness failed: %v\n%s", err, stderr.String())
				}
				var want struct {
					Modes        []string `json:"modes"`
					Resolved     string   `json:"resolved"`
					Instructions string   `json:"instructions"`
				}
				if err := json.Unmarshal(raw, &want); err != nil {
					t.Fatal(err)
				}

				t.Setenv("HOME", home)
				t.Setenv("USERPROFILE", home)
				t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
				t.Setenv("PONYTAIL_SKILL_PATH", filepath.Join(root, "skills", "ponytail", "SKILL.md"))
				if defaultMode == "" {
					os.Unsetenv("PONYTAIL_DEFAULT_MODE")
				} else {
					t.Setenv("PONYTAIL_DEFAULT_MODE", defaultMode)
				}

				if !slices.Equal(gomcp.Modes, want.Modes) {
					t.Errorf("served modes = %v, node = %v", gomcp.Modes, want.Modes)
				}
				if got := gomcp.ResolveMode(requested); got != want.Resolved {
					t.Errorf("ResolveMode(%q) = %q, node = %q", requested, got, want.Resolved)
				}
				if got := gomcp.BuildInstructions(requested); got != want.Instructions {
					t.Errorf("BuildInstructions(%q) diverges:\n%s", requested, firstDiff(got, want.Instructions))
				}
			})
		}
	}
}

// A full handshake through the built binary, the way a host drives it.
func TestMCPServerHandshakeThroughBinary(t *testing.T) {
	root := repoRoot(t)
	binary := goBinary(t)
	env, _ := parityEnv(t)
	env = append(env, "PONYTAIL_ROOT="+root)

	session := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ponytail_instructions","arguments":{"mode":"ultra"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"prompts/list"}`,
		`{"jsonrpc":"2.0","id":5,"method":"prompts/get","params":{"name":"ponytail","arguments":{}}}`,
	}, "\n") + "\n"

	out := run(t, env, session, binary, "mcp")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 5 {
		t.Fatalf("expected 5 responses (the notification gets none), got %d:\n%s", len(lines), out)
	}
	for i, line := range lines {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			t.Fatalf("response %d is not JSON: %v", i, err)
		}
		if _, isErr := parsed["error"]; isErr {
			t.Errorf("response %d is an error: %s", i, line)
		}
	}

	// The version must come from the checkout's package.json, not a hardcoded const.
	raw, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(lines[0], `"version":"`+pkg.Version+`"`) {
		t.Errorf("initialize must report package.json's version %q:\n%s", pkg.Version, lines[0])
	}
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}
