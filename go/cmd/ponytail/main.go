// Command ponytail is the Go port of ponytail's Node runtime: the Claude Code /
// Codex / Copilot / Qoder lifecycle hooks, the statusline badge, the uninstall
// cleanup, and the MCP server — one binary with a subcommand per entry point,
// replacing hooks/*.js, hooks/ponytail-statusline.*, scripts/uninstall.js and
// ponytail-mcp/.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/DietrichGebert/ponytail/go/internal/instructions"
	"github.com/DietrichGebert/ponytail/go/internal/mcp"
)

const usage = `ponytail — lazy senior dev mode for AI agents

Usage: ponytail <command>

  activate     SessionStart hook: write the mode flag and emit the ruleset
  prompt       UserPromptSubmit hook: track /ponytail commands (reads stdin)
  subagent     SubagentStart hook: inject the condensed ruleset
  statusline   print the [PONYTAIL] status badge
  uninstall    remove the mode flag, config file and statusLine entry
  mcp          serve the ruleset over MCP on stdio
  version      print the ponytail version
`

func main() {
	ignoreSIGPIPE()

	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	switch os.Args[1] {
	case "activate":
		runActivate(os.Stdout)
	case "prompt":
		runPrompt(os.Stdin, os.Stdout)
	case "subagent":
		runSubagent(os.Stdin, os.Stdout)
	case "statusline":
		runStatusline(os.Stdout)
	case "uninstall":
		if err := runUninstall(os.Stdout, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, "ponytail uninstall:", err)
			os.Exit(1)
		}
	case "mcp":
		if err := mcp.Serve(context.Background(), os.Stdin, os.Stdout, Version()); err != nil {
			fmt.Fprintln(os.Stderr, "ponytail mcp:", err)
			os.Exit(1)
		}
	case "version", "--version", "-v":
		fmt.Fprintln(os.Stdout, Version())
	case "help", "--help", "-h":
		fmt.Fprint(os.Stdout, usage)
	default:
		fmt.Fprintf(os.Stderr, "ponytail: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
}

// Version reads the version from the checkout's package.json, the same source
// the Node MCP server uses, so the two can never report different versions.
func Version() string {
	root := instructions.Root()
	if root == "" {
		return "unknown"
	}
	raw, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return "unknown"
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil || pkg.Version == "" {
		return "unknown"
	}
	return pkg.Version
}
