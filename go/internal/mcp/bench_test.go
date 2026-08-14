package mcp

// Performance harness for the MCP server. The server is a per-request stdio
// process serving a ruleset that lives on disk, so the cost that matters is
// per-request latency and allocation, not throughput of a long-lived service.

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// benchEnv points the benchmark at the real SKILL.md, which is what a running
// server reads — benchmarking the condensed fallback would measure the wrong path.
func benchEnv(b *testing.B) {
	b.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		b.Fatal(err)
	}
	skill := filepath.Join(root, "skills", "ponytail", "SKILL.md")
	if _, err := os.Stat(skill); err != nil {
		b.Skipf("real SKILL.md unavailable: %v", err)
	}
	home := b.TempDir()
	b.Setenv("HOME", home)
	b.Setenv("USERPROFILE", home)
	b.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
	b.Setenv("PONYTAIL_ROOT", root)
	os.Unsetenv("PONYTAIL_SKILL_PATH")
	os.Unsetenv("PONYTAIL_DEFAULT_MODE")
}

var benchRequests = map[string]string{
	"initialize":  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}`,
	"tools/list":  `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
	"tools/call":  `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ponytail_instructions","arguments":{"mode":"ultra"}}}`,
	"prompts/get": `{"jsonrpc":"2.0","id":1,"method":"prompts/get","params":{"name":"ponytail","arguments":{"mode":"full"}}}`,
	"ping":        `{"jsonrpc":"2.0","id":1,"method":"ping"}`,
}

// BenchmarkHandleLine measures one request end to end, minus the stdio framing.
func BenchmarkHandleLine(b *testing.B) {
	benchEnv(b)
	for name, request := range benchRequests {
		line := []byte(request + "\n")
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if handleLine(line, "4.9.0") == nil && name != "" {
					b.Fatal("no response")
				}
			}
		})
	}
}

// BenchmarkServeSession measures a realistic host session: handshake, discovery,
// then a burst of ruleset fetches — all through the real read/encode loop.
func BenchmarkServeSession(b *testing.B) {
	benchEnv(b)
	const fetches = 20

	lines := []string{
		benchRequests["initialize"],
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		benchRequests["tools/list"],
		benchRequests["prompts/list"],
	}
	for i := 0; i < fetches; i++ {
		lines = append(lines, benchRequests["tools/call"])
	}
	session := strings.Join(lines, "\n") + "\n"

	b.ReportAllocs()
	b.SetBytes(int64(len(session)))
	for i := 0; i < b.N; i++ {
		if err := Serve(context.Background(), strings.NewReader(session), io.Discard, "4.9.0"); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkBuildInstructions isolates the ruleset build — the disk read and the
// per-line mode filter that every tools/call and prompts/get pays for.
func BenchmarkBuildInstructions(b *testing.B) {
	benchEnv(b)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if BuildInstructions("ultra") == "" {
			b.Fatal("empty ruleset")
		}
	}
}

// BenchmarkResolveMode isolates mode resolution, which consults the config file.
func BenchmarkResolveMode(b *testing.B) {
	benchEnv(b)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if ResolveMode("") == "" {
			b.Fatal("empty mode")
		}
	}
}

// BenchmarkToolsCallCold measures the first request of a process, which is the
// number a host actually feels: the server is spawned per session and a cache
// that only pays off on request two does nothing for a one-shot fetch.
func BenchmarkToolsCallCold(b *testing.B) {
	benchEnv(b)
	line := []byte(benchRequests["tools/call"] + "\n")
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		resetCaches()
		b.StartTimer()
		if handleLine(line, "4.9.0") == nil {
			b.Fatal("no response")
		}
	}
}

// resetCaches drops memoized state so BenchmarkToolsCallCold measures a genuine
// first request. Nothing is memoized today; anything added later must be wired
// in here, or the cold-start number silently becomes a warm-start number.
func resetCaches() {}
