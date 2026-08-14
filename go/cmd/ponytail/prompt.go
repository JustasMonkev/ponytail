package main

// Port of hooks/ponytail-mode-tracker.js — the UserPromptSubmit hook.
// Inspects user input for /ponytail commands and writes the mode to the flag file.

import (
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/DietrichGebert/ponytail/go/internal/config"
	"github.com/DietrichGebert/ponytail/go/internal/hostruntime"
	"github.com/DietrichGebert/ponytail/go/internal/instructions"
)

var (
	// Claude Code dispatches /ponytail as a skill: the prompt then carries the
	// whole skill body wrapped in XML tags, never the typed command, so the
	// [/@$]ponytail anchor can't match and the mode flag was never written (#584).
	// Rebuild the command string from the tags — but only when the prompt *starts*
	// with the platform's dispatch envelope. The prompt is untrusted text; tags
	// merely pasted or discussed mid-message must stay inert, same reason the
	// anchors exist at all.
	commandNameRe = regexp.MustCompile(`^(?:<command-message>[^<]*</command-message>\s*)?<command-name>\s*/?([^<\n]*?)\s*</command-name>`)
	commandArgsRe = regexp.MustCompile(`<command-args>\s*([^<\n]*?)\s*</command-args>`)
	ponytailCmdRe = regexp.MustCompile(`^[/@$]ponytail`)
	whitespaceRe  = regexp.MustCompile(`\s+`)
)

// stdinTimeout bounds the wait for the piped prompt JSON.
//
// Never hang the session. On Windows, Claude Code runs the hook through a
// PowerShell `if {}` wrapper that can swallow the piped prompt JSON, so EOF never
// arrives and the hook blocks forever — freezing the session (#443). After a short
// fallback, process whatever arrived (recovering the mode if data came without
// EOF) and exit. Mirrors the best-effort, never-block contract the other lifecycle
// hooks already follow.
const stdinTimeout = time.Second

// readWithTimeout returns whatever arrived on r before EOF or the deadline.
func readWithTimeout(r io.Reader, timeout time.Duration) []byte {
	type result struct{ data []byte }
	done := make(chan result, 1)
	go func() {
		data, _ := io.ReadAll(r)
		done <- result{data}
	}()
	select {
	case res := <-done:
		return res.data
	case <-time.After(timeout):
		return nil
	}
}

func runPrompt(stdin io.Reader, stdout io.Writer) {
	host := hostruntime.Detect()

	var data struct {
		Prompt string `json:"prompt"`
	}
	// Silent fail on a malformed payload, matching the JS try/catch: an
	// unparseable prompt must never break the turn.
	if err := json.Unmarshal(config.StripBOM(readWithTimeout(stdin, stdinTimeout)), &data); err != nil {
		return
	}

	prompt := strings.ToLower(strings.TrimSpace(data.Prompt))
	if name := commandNameRe.FindStringSubmatch(prompt); name != nil && name[1] != "" {
		args := ""
		if match := commandArgsRe.FindStringSubmatch(prompt); match != nil {
			args = match[1]
		}
		prompt = strings.TrimSpace("/" + name[1] + " " + args)
	}

	modeSwitched, deactivated := false, false

	if ponytailCmdRe.MatchString(prompt) {
		parts := whitespaceRe.Split(prompt, -1)
		cmd := parts[0]
		if strings.HasPrefix(cmd, "@") || strings.HasPrefix(cmd, "$") {
			cmd = "/" + cmd[1:]
		}
		arg := ""
		if len(parts) > 1 {
			arg = parts[1]
		}

		mode := ""
		isReportOnly := false

		switch cmd {
		case "/ponytail-review", "/ponytail:ponytail-review":
			mode = "review"
		case "/ponytail", "/ponytail:ponytail":
			// `/ponytail default <mode>` persists the default to config (survives
			// restarts). Plain switches stay session-scoped ("sticks until session
			// end"), so this is the only path that writes config. review is not a
			// valid default (#377), so only off/lite/full/ultra are accepted.
			if arg == "default" {
				dmode := ""
				if len(parts) > 2 {
					dmode = parts[2]
				}
				switch dmode {
				case "off", "lite", "full", "ultra":
					if _, err := config.WriteDefaultMode(dmode); err == nil {
						host.WriteHookOutput(stdout, "UserPromptSubmit",
							"PONYTAIL DEFAULT SET — new sessions start in "+dmode+".")
					}
				}
				return // don't fall through to the session-mode switch
			}
			switch arg {
			case "lite", "full", "ultra", "off":
				mode = arg
			case "":
				isReportOnly = true
				mode = host.ReadMode()
				if mode == "" {
					mode = config.GetDefaultMode()
				}
			default:
				mode = config.GetDefaultMode()
			}
		}

		switch {
		case isReportOnly:
			host.WriteHookOutput(stdout, "UserPromptSubmit", "PONYTAIL MODE ACTIVE — level: "+mode)
		case mode != "" && mode != "off":
			_ = host.SetMode(mode)
			modeSwitched = true
			// ponytail: Qoder needs the full ruleset every turn, so when a mode
			// switch happens we fold the confirmation into the ruleset output
			// below (one JSON on stdout) instead of emitting two separate writes.
			if !host.IsQoder {
				host.WriteHookOutput(stdout, "UserPromptSubmit", "PONYTAIL MODE CHANGED — level: "+mode)
			}
		case mode == "off":
			host.ClearMode()
			deactivated = true
			host.WriteHookOutput(stdout, "UserPromptSubmit", "PONYTAIL MODE OFF")
		}
	}

	// Detect deactivation.
	if !modeSwitched && !deactivated && config.IsDeactivationCommand(prompt) {
		host.ClearMode()
		deactivated = true
		host.WriteHookOutput(stdout, "UserPromptSubmit", "PONYTAIL MODE OFF")
	}

	// Qoder has no SessionStart event, so UserPromptSubmit does double duty:
	// activate the default mode on first prompt (if no flag exists yet), then
	// inject the ruleset on every prompt. Claude Code/Codex do this in
	// SessionStart via activate; Qoder can't, so we do it here.
	// Skip when deactivated — the user just turned ponytail off.
	if host.IsQoder && !deactivated {
		currentMode := host.ReadMode()
		if currentMode == "" {
			// First prompt in session — initialize from config/env default.
			currentMode = config.GetDefaultMode()
			if currentMode != "off" {
				_ = host.SetMode(currentMode)
			}
		}
		if currentMode != "" && currentMode != "off" {
			// ponytail: one JSON per invocation — the mode-switch confirmation is
			// folded into the ruleset header so Qoder gets both in one write.
			header := ""
			if modeSwitched {
				header = "PONYTAIL MODE CHANGED — level: " + currentMode + "\n\n"
			}
			host.WriteHookOutput(stdout, "UserPromptSubmit", header+instructions.GetPonytailInstructions(currentMode))
		}
	}
}
