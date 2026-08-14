package main

// Port of hooks/ponytail-subagent.js — the SubagentStart hook.
//
// SessionStart context is parent-thread only and never reaches subagents, so
// without this every Task-spawned agent runs ponytail-unaware (#252). When
// ponytail mode is active, inject the same ruleset into each subagent.
//
// Scoping (opt-in, #506): set PONYTAIL_SUBAGENT_MATCHER to a regex and the
// ruleset is injected only into subagents whose agent_type matches. The regex is
// unanchored and case-insensitive — "explore|general" matches either, "^general$"
// is exact. Unset means inject into every subagent, as before.

import (
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/DietrichGebert/ponytail/go/internal/config"
	"github.com/DietrichGebert/ponytail/go/internal/hostruntime"
	"github.com/DietrichGebert/ponytail/go/internal/instructions"
)

func runSubagent(stdin io.Reader, stdout io.Writer) {
	host := hostruntime.Detect()
	mode := host.ReadMode()

	// Absent flag or off → ponytail isn't active; inject nothing.
	if mode == "" || mode == "off" {
		return
	}

	// Condensed ruleset, not the full SKILL.md — the full body repeats ~1,300
	// tokens into every spawn and heavy sessions spawn dozens (#597).
	inject := func() {
		host.WriteHookOutput(stdout, "SubagentStart", instructions.GetSubagentInstructions(mode))
	}

	// A bad regex must never crash the hook; treat it as "no matcher" and inject.
	var matcher *regexp.Regexp
	if pattern := os.Getenv("PONYTAIL_SUBAGENT_MATCHER"); pattern != "" {
		if compiled, err := regexp.Compile("(?i)" + pattern); err == nil {
			matcher = compiled
		}
	}

	// No matcher → keep the original synchronous, stdin-independent path. On
	// Windows the PowerShell `if {}` wrapper can swallow the piped JSON so EOF
	// never arrives (#443); the default path must not wait on stdin or it would
	// stall every subagent spawn.
	if matcher == nil {
		inject()
		return
	}

	// Matcher set → read agent_type from stdin and skip only on a definite
	// mismatch. A missing/unparseable agent_type, a stdin error, or the timeout
	// all fail open (inject), so scoping never silently drops the persona.
	var payload struct {
		AgentType string `json:"agent_type"`
	}
	agentType := ""
	if err := json.Unmarshal(config.StripBOM(readWithTimeout(stdin, stdinTimeout)), &payload); err == nil {
		agentType = strings.TrimSpace(payload.AgentType)
	}
	if agentType != "" && !matcher.MatchString(agentType) {
		return
	}
	inject()
}
