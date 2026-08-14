// Package mcp is the Go port of ponytail-mcp/ — it serves the lazy-senior-dev
// ruleset over stdio as a prompt (user-invoked) and a tool (for hosts that pull
// context via tools). It does NOT replace the always-on adapters; it's the clean
// option for hosts whose only injection point is the prompt menu (#70).
//
// ponytail: speaks MCP's JSON-RPC framing directly rather than pulling in an SDK.
// The server has two capabilities and no subscriptions, sampling, or resources —
// four request types is less code than a dependency. Swap in a real SDK if this
// ever needs the rest of the protocol.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"

	"github.com/DietrichGebert/ponytail/go/internal/config"
	"github.com/DietrichGebert/ponytail/go/internal/instructions"
)

// Modes are the three intensities the server offers. "off" has no instructions
// to serve.
var Modes = []string{"lite", "full", "ultra"}

// latestProtocolVersion is used when the client asks for one we don't recognise.
const latestProtocolVersion = "2025-06-18"

var supportedProtocolVersions = map[string]bool{
	"2024-11-05": true,
	"2025-03-26": true,
	"2025-06-18": true,
}

const modeDescription = "Ponytail intensity: lite, full, or ultra. Omit for the configured default."

// ResolveMode maps a requested mode to a runtime intensity. Unknown, empty, or
// "off" falls back to the configured default, then to "full".
// ponytail: keep the surface to these three; "off"/"review" aren't served here.
func ResolveMode(requested string) string {
	if asked := config.NormalizeMode(requested); asked != "" && asked != "off" {
		return asked
	}
	if fallback := config.NormalizeMode(config.GetDefaultMode()); fallback != "" && fallback != "off" {
		return fallback
	}
	return "full"
}

// BuildInstructions returns the ruleset for the resolved intensity.
func BuildInstructions(requested string) string {
	return instructions.GetPonytailInstructions(ResolveMode(requested))
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

const (
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
)

var nullID = json.RawMessage("null")

// Serve runs the MCP server over the given streams until the input closes or the
// context is cancelled.
func Serve(ctx context.Context, stdin io.Reader, stdout io.Writer, version string) error {
	reader := bufio.NewReader(stdin)
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)

	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		line, err := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			if payload := handleLine(line, version); payload != nil {
				if writeErr := encoder.Encode(payload); writeErr != nil {
					return writeErr
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

// handleLine returns what to write for one input line: a single response, an
// array of responses for a batch, or nil when nothing is owed (notifications,
// an all-notification batch, or input too broken to answer).
func handleLine(line []byte, version string) any {
	// A batch is a JSON array of requests and/or notifications. Batching was
	// removed in protocol 2025-06-18 but is part of 2024-11-05 and 2025-03-26,
	// which this server still negotiates — dropping a batch silently leaves the
	// client waiting on responses that never come.
	if trimmed := bytes.TrimLeft(line, " \t\r\n"); len(trimmed) > 0 && trimmed[0] == '[' {
		var batch []json.RawMessage
		if err := json.Unmarshal(line, &batch); err != nil {
			return nil
		}
		if len(batch) == 0 {
			return &response{JSONRPC: "2.0", ID: nullID, Error: &rpcError{Code: codeInvalidRequest, Message: "Invalid Request: empty batch"}}
		}
		responses := []*response{}
		for _, member := range batch {
			if resp := handleOne(member, version); resp != nil {
				responses = append(responses, resp)
			}
		}
		if len(responses) == 0 {
			return nil // a batch of notifications is answered with silence
		}
		return responses
	}

	if resp := handleOne(line, version); resp != nil {
		return resp
	}
	return nil
}

// handleOne answers a single JSON-RPC message, or returns nil when none is owed.
func handleOne(message []byte, version string) *response {
	var req request
	if err := json.Unmarshal(message, &req); err != nil {
		// The envelope has a field of the wrong type — e.g. a numeric "method".
		// If it still carries an id, the client is waiting on that id, so answer
		// it rather than letting the call hang. Input that isn't even an object
		// gives us no id to answer with, so it stays silent.
		var envelope struct {
			ID json.RawMessage `json:"id"`
		}
		if json.Unmarshal(message, &envelope) != nil || len(envelope.ID) == 0 || string(envelope.ID) == "null" {
			return nil
		}
		return &response{JSONRPC: "2.0", ID: envelope.ID, Error: &rpcError{Code: codeInvalidRequest, Message: "Invalid Request"}}
	}
	// Notifications carry no id and get no reply.
	if len(req.ID) == 0 || string(req.ID) == "null" {
		return nil
	}

	result, rpcErr := dispatch(req, version)
	return &response{JSONRPC: "2.0", ID: req.ID, Result: result, Error: rpcErr}
}

func dispatch(req request, version string) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		return initializeResult(req.Params, version), nil
	case "ping":
		return map[string]any{}, nil
	case "prompts/list":
		return promptsList(), nil
	case "prompts/get":
		return promptsGet(req.Params)
	case "tools/list":
		return toolsList(), nil
	case "tools/call":
		return toolsCall(req.Params)
	default:
		return nil, &rpcError{Code: codeMethodNotFound, Message: "Method not found: " + req.Method}
	}
}

func initializeResult(params json.RawMessage, version string) any {
	protocol := latestProtocolVersion
	var parsed struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(params, &parsed); err == nil && supportedProtocolVersions[parsed.ProtocolVersion] {
		protocol = parsed.ProtocolVersion
	}
	return map[string]any{
		"protocolVersion": protocol,
		"capabilities": map[string]any{
			"prompts": map[string]any{"listChanged": true},
			"tools":   map[string]any{"listChanged": true},
		},
		"serverInfo": map[string]any{"name": "ponytail", "version": version},
	}
}

// modeSchema is the shared optional-enum argument for the prompt and the tool.
func modeSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"mode": map[string]any{
				"type":        "string",
				"enum":        Modes,
				"description": modeDescription,
			},
		},
		"additionalProperties": false,
	}
}

func promptsList() any {
	return map[string]any{
		"prompts": []any{
			map[string]any{
				"name":        "ponytail",
				"title":       "Ponytail mode",
				"description": "Lazy senior dev instructions: YAGNI, stdlib first, the smallest correct change.",
				"arguments": []any{
					map[string]any{"name": "mode", "description": modeDescription, "required": false},
				},
			},
		},
	}
}

type callParams struct {
	Name      string `json:"name"`
	Arguments struct {
		Mode json.RawMessage `json:"mode"`
	} `json:"arguments"`
	mode string // the validated intensity, "" when the caller omitted it
}

// parseCall decodes the params and enforces the declared inputSchema. The Node
// server got this from zod (`z.enum(MODES).optional()`), which rejects anything
// outside the enum rather than falling back — and the spec requires a server to
// validate its own tool inputs. Only an omitted mode is allowed through.
func parseCall(params json.RawMessage) (callParams, *rpcError) {
	var parsed callParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &parsed); err != nil {
			return parsed, &rpcError{Code: codeInvalidParams, Message: "Invalid params"}
		}
	}
	raw := parsed.Arguments.Mode
	if len(raw) == 0 {
		return parsed, nil
	}
	var mode string
	if err := json.Unmarshal(raw, &mode); err != nil || !slices.Contains(Modes, mode) {
		return parsed, &rpcError{
			Code:    codeInvalidParams,
			Message: "Invalid params: mode must be one of " + strings.Join(Modes, ", "),
		}
	}
	parsed.mode = mode
	return parsed, nil
}

func promptsGet(params json.RawMessage) (any, *rpcError) {
	parsed, rpcErr := parseCall(params)
	if rpcErr != nil {
		return nil, rpcErr
	}
	// name is a required field of GetPromptRequest — tools/call already rejects a
	// missing name, and the two paths must not disagree.
	if parsed.Name != "ponytail" {
		return nil, &rpcError{Code: codeInvalidParams, Message: "Unknown prompt: " + parsed.Name}
	}
	return map[string]any{
		"description": "Lazy senior dev instructions: YAGNI, stdlib first, the smallest correct change.",
		"messages": []any{
			map[string]any{
				"role":    "user",
				"content": map[string]any{"type": "text", "text": BuildInstructions(parsed.mode)},
			},
		},
	}, nil
}

func toolsList() any {
	return map[string]any{
		"tools": []any{
			map[string]any{
				"name":        "ponytail_instructions",
				"title":       "Ponytail instructions",
				"description": "Return the Ponytail ruleset for the given intensity (lite, full, or ultra).",
				"inputSchema": modeSchema(),
				"outputSchema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"mode":         map[string]any{"type": "string"},
						"instructions": map[string]any{"type": "string"},
					},
					"required":             []any{"mode", "instructions"},
					"additionalProperties": false,
				},
				"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
			},
		},
	}
}

func toolsCall(params json.RawMessage) (any, *rpcError) {
	parsed, rpcErr := parseCall(params)
	if rpcErr != nil {
		return nil, rpcErr
	}
	if parsed.Name != "ponytail_instructions" {
		return nil, &rpcError{Code: codeInvalidParams, Message: "Unknown tool: " + parsed.Name}
	}
	mode := ResolveMode(parsed.mode)
	text := instructions.GetPonytailInstructions(mode)
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": text}},
		"structuredContent": map[string]any{"mode": mode, "instructions": text},
	}, nil
}
