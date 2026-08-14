package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isolate(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
	for _, name := range []string{"PONYTAIL_DEFAULT_MODE", "PONYTAIL_ROOT", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"} {
		os.Unsetenv(name)
	}
	// Force the condensed fallback so tests don't depend on SKILL.md's contents.
	t.Setenv("PONYTAIL_SKILL_PATH", filepath.Join(home, "absent.md"))
}

func TestResolveModeKeepsValidIntensities(t *testing.T) {
	isolate(t)
	for _, mode := range Modes {
		if got := ResolveMode(mode); got != mode {
			t.Errorf("ResolveMode(%q) = %q", mode, got)
		}
	}
}

// off, review, junk and empty must all land on a served intensity — never on
// "off" (which has no instructions) or on junk.
func TestResolveModeFallsBackToAServedMode(t *testing.T) {
	isolate(t)
	for _, input := range []string{"off", "review", "nonsense", ""} {
		got := ResolveMode(input)
		if !slicesContains(Modes, got) {
			t.Errorf("ResolveMode(%q) = %q, not a served mode", input, got)
		}
	}

	// A configured default is honoured...
	t.Setenv("PONYTAIL_DEFAULT_MODE", "ultra")
	if got := ResolveMode(""); got != "ultra" {
		t.Errorf("ResolveMode(\"\") = %q, want ultra", got)
	}
	// ...unless it is "off", which has nothing to serve.
	t.Setenv("PONYTAIL_DEFAULT_MODE", "off")
	if got := ResolveMode("off"); got != "full" {
		t.Errorf("ResolveMode(off) with default off = %q, want full", got)
	}
}

func TestBuildInstructionsIsTaggedWithResolvedMode(t *testing.T) {
	isolate(t)
	text := BuildInstructions("ultra")
	if !strings.Contains(text, "PONYTAIL MODE ACTIVE") || !strings.Contains(text, "ultra") {
		t.Errorf("unexpected instructions: %.80s", text)
	}
}

// --- protocol ---

// exchange feeds newline-delimited requests through Serve and returns the
// decoded responses.
func exchange(t *testing.T, requests ...string) []map[string]any {
	t.Helper()
	var out bytes.Buffer
	input := strings.Join(requests, "\n") + "\n"
	if err := Serve(context.Background(), strings.NewReader(input), &out, "9.9.9"); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	var responses []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			t.Fatalf("response is not JSON: %v (%q)", err, line)
		}
		responses = append(responses, parsed)
	}
	return responses
}

func TestInitializeEchoesSupportedProtocol(t *testing.T) {
	isolate(t)
	responses := exchange(t,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}`)
	if len(responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(responses))
	}
	result := responses[0]["result"].(map[string]any)
	if result["protocolVersion"] != "2024-11-05" {
		t.Errorf("protocolVersion = %v, want the client's own", result["protocolVersion"])
	}
	info := result["serverInfo"].(map[string]any)
	if info["name"] != "ponytail" || info["version"] != "9.9.9" {
		t.Errorf("serverInfo = %v", info)
	}
	caps := result["capabilities"].(map[string]any)
	if _, ok := caps["prompts"]; !ok {
		t.Error("prompts capability must be advertised")
	}
	if _, ok := caps["tools"]; !ok {
		t.Error("tools capability must be advertised")
	}
}

func TestInitializeFallsBackForUnknownProtocol(t *testing.T) {
	isolate(t)
	responses := exchange(t, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}`)
	result := responses[0]["result"].(map[string]any)
	if result["protocolVersion"] != latestProtocolVersion {
		t.Errorf("protocolVersion = %v, want %s", result["protocolVersion"], latestProtocolVersion)
	}
}

// Notifications carry no id and must produce no reply — an unsolicited response
// desynchronises the client.
func TestNotificationsGetNoReply(t *testing.T) {
	isolate(t)
	responses := exchange(t,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":null,"method":"ping"}`,
		`{"jsonrpc":"2.0","id":7,"method":"ping"}`)
	if len(responses) != 1 {
		t.Fatalf("expected exactly 1 response, got %d: %v", len(responses), responses)
	}
	if responses[0]["id"] != float64(7) {
		t.Errorf("wrong response echoed: %v", responses[0])
	}
}

// A malformed line must not kill the session — the next request still works.
func TestMalformedLineIsSkipped(t *testing.T) {
	isolate(t)
	responses := exchange(t, `not json at all`, ``, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if len(responses) != 1 || responses[0]["id"] != float64(2) {
		t.Fatalf("expected only the valid request to be answered, got %v", responses)
	}
}

func TestPromptsListAndGet(t *testing.T) {
	isolate(t)
	responses := exchange(t,
		`{"jsonrpc":"2.0","id":1,"method":"prompts/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"prompts/get","params":{"name":"ponytail","arguments":{"mode":"lite"}}}`)

	prompts := responses[0]["result"].(map[string]any)["prompts"].([]any)
	if len(prompts) != 1 || prompts[0].(map[string]any)["name"] != "ponytail" {
		t.Fatalf("unexpected prompt list: %v", prompts)
	}

	messages := responses[1]["result"].(map[string]any)["messages"].([]any)
	content := messages[0].(map[string]any)["content"].(map[string]any)
	text := content["text"].(string)
	if !strings.Contains(text, "level: lite") {
		t.Errorf("prompt did not honour the requested mode: %.80s", text)
	}
}

func TestPromptsGetRejectsUnknownName(t *testing.T) {
	isolate(t)
	responses := exchange(t, `{"jsonrpc":"2.0","id":1,"method":"prompts/get","params":{"name":"other"}}`)
	if _, ok := responses[0]["error"]; !ok {
		t.Errorf("expected an error for an unknown prompt, got %v", responses[0])
	}
}

func TestToolsListAdvertisesReadOnlyTool(t *testing.T) {
	isolate(t)
	responses := exchange(t, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	tools := responses[0]["result"].(map[string]any)["tools"].([]any)
	tool := tools[0].(map[string]any)
	if tool["name"] != "ponytail_instructions" {
		t.Fatalf("unexpected tool: %v", tool)
	}
	annotations := tool["annotations"].(map[string]any)
	if annotations["readOnlyHint"] != true || annotations["openWorldHint"] != false {
		t.Errorf("annotations = %v", annotations)
	}
	schema := tool["inputSchema"].(map[string]any)
	props := schema["properties"].(map[string]any)["mode"].(map[string]any)
	enum := props["enum"].([]any)
	if len(enum) != len(Modes) {
		t.Errorf("mode enum = %v, want %v", enum, Modes)
	}
}

func TestToolsCallReturnsTextAndStructuredContent(t *testing.T) {
	isolate(t)
	responses := exchange(t,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ponytail_instructions","arguments":{"mode":"ultra"}}}`)
	result := responses[0]["result"].(map[string]any)

	structured := result["structuredContent"].(map[string]any)
	if structured["mode"] != "ultra" {
		t.Errorf("structured mode = %v", structured["mode"])
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if text != structured["instructions"] {
		t.Error("text content and structuredContent.instructions must match")
	}
	if !strings.Contains(text, "level: ultra") {
		t.Errorf("instructions not tagged with the mode: %.80s", text)
	}
}

// An out-of-range mode is not an error: the ruleset falls back to the default,
// matching the Node server's optional enum.
func TestToolsCallFallsBackForUnknownMode(t *testing.T) {
	isolate(t)
	responses := exchange(t,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ponytail_instructions","arguments":{"mode":"off"}}}`)
	structured := responses[0]["result"].(map[string]any)["structuredContent"].(map[string]any)
	if structured["mode"] != "full" {
		t.Errorf("mode = %v, want full", structured["mode"])
	}
}

func TestToolsCallRejectsUnknownTool(t *testing.T) {
	isolate(t)
	responses := exchange(t, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope"}}`)
	if _, ok := responses[0]["error"]; !ok {
		t.Errorf("expected an error, got %v", responses[0])
	}
}

func TestUnknownMethodReturnsMethodNotFound(t *testing.T) {
	isolate(t)
	responses := exchange(t, `{"jsonrpc":"2.0","id":1,"method":"resources/list"}`)
	rpcErr := responses[0]["error"].(map[string]any)
	if rpcErr["code"] != float64(codeMethodNotFound) {
		t.Errorf("code = %v, want %d", rpcErr["code"], codeMethodNotFound)
	}
}

// The ruleset contains <input type="date">; a host that receives it
// unicode-escaped shows the user mangled rules.
func TestServeDoesNotEscapeHTML(t *testing.T) {
	isolate(t)
	var out bytes.Buffer
	err := Serve(context.Background(),
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ponytail_instructions","arguments":{"mode":"full"}}}`+"\n"),
		&out, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), `<`) {
		t.Error("output must not unicode-escape < and >")
	}
}

// A closed context stops the loop instead of blocking forever on stdin.
func TestServeStopsOnCancelledContext(t *testing.T) {
	isolate(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer
	if err := Serve(ctx, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`+"\n"), &out, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Errorf("cancelled server must not answer, got %q", out.String())
	}
}

func slicesContains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}
