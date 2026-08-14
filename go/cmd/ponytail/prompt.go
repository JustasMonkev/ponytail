package main

// Port of hooks/ponytail-mode-tracker.js — the UserPromptSubmit hook.
// Inspects user input for /ponytail commands and writes the mode to the flag file.

import (
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/DietrichGebert/ponytail/go/internal/config"
	"github.com/DietrichGebert/ponytail/go/internal/hostruntime"
	"github.com/DietrichGebert/ponytail/go/internal/instructions"
)

// jsSpace is JavaScript's \s, which these regexes were transcribed from.
const jsSpace = config.JSSpaceClass

var (
	// Claude Code dispatches /ponytail as a skill: the prompt then carries the
	// whole skill body wrapped in XML tags, never the typed command, so the
	// [/@$]ponytail anchor can't match and the mode flag was never written (#584).
	// Rebuild the command string from the tags — but only when the prompt *starts*
	// with the platform's dispatch envelope. The prompt is untrusted text; tags
	// merely pasted or discussed mid-message must stay inert, same reason the
	// anchors exist at all.
	commandNameRe = regexp.MustCompile(`^(?:<command-message>[^<]*</command-message>[` + jsSpace + `]*)?<command-name>[` + jsSpace + `]*/?([^<\n]*?)[` + jsSpace + `]*</command-name>`)
	commandArgsRe = regexp.MustCompile(`<command-args>[` + jsSpace + `]*([^<\n]*?)[` + jsSpace + `]*</command-args>`)
	ponytailCmdRe = regexp.MustCompile(`^[/@$]ponytail`)
	whitespaceRe  = regexp.MustCompile(`[` + config.JSSpaceClass + `]+`)
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
//
// The bytes buffered so far are what the timeout path exists to recover: the
// PowerShell wrapper delivers the whole prompt JSON and then never closes the
// pipe, so discarding the buffer on timeout would leave the hook doing nothing
// on exactly the host it was written for. The reader appends under a mutex and
// the deadline path takes the same lock, so the snapshot is race-free.
func readWithTimeout(r io.Reader, timeout time.Duration) []byte {
	var (
		mu       sync.Mutex
		buffered []byte
	)
	done := make(chan struct{})

	go func() {
		defer close(done)
		chunk := make([]byte, 4096)
		for {
			n, err := r.Read(chunk)
			if n > 0 {
				mu.Lock()
				buffered = append(buffered, chunk[:n]...)
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()

	select {
	case <-done:
	case <-time.After(timeout):
	}
	mu.Lock()
	defer mu.Unlock()
	return append([]byte(nil), buffered...)
}

// decodePrompt extracts the prompt text from a hook payload, reporting false
// when the payload is one the JS aborts on rather than one it reads as empty.
//
// JS reads `(data.prompt || ”).trim().toLowerCase()`. Property access on an
// array, number, string or boolean yields undefined, so those become an empty
// prompt; only `null` throws and aborts the turn. A typed Go struct would reject
// all of them alike, which under Qoder is the difference between injecting the
// whole ruleset and injecting nothing.
func decodePrompt(payload []byte) (string, bool) {
	var parsed any
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return "", false
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		if parsed == nil {
			return "", false // JSON null: `null.prompt` throws in JS
		}
		return "", true // array/number/string/bool: `.prompt` is undefined
	}
	switch value := object["prompt"].(type) {
	case string:
		return value, true
	case nil, bool:
		// undefined/null/false are falsy and become ''. `true` is truthy and
		// would reach .trim(), which throws.
		if truthy, isBool := value.(bool); isBool && truthy {
			return "", false
		}
		return "", true
	case float64:
		if value == 0 {
			return "", true // 0 is falsy, so JS substitutes ''
		}
		return "", false // a non-zero number reaches .trim() and throws
	default:
		return "", false // object/array reaches .trim() and throws
	}
}

func runPrompt(stdin io.Reader, stdout io.Writer) {
	host := hostruntime.Detect()

	// Silent fail on a payload the JS aborts on, matching its try/catch: an
	// unparseable prompt must never break the turn.
	raw, ok := decodePrompt(config.StripBOM(readWithTimeout(stdin, stdinTimeout)))
	if !ok {
		return
	}

	prompt := config.LowerJS(config.TrimJS(raw))
	if name := commandNameRe.FindStringSubmatch(prompt); name != nil && name[1] != "" {
		args := ""
		if match := commandArgsRe.FindStringSubmatch(prompt); match != nil {
			args = match[1]
		}
		prompt = config.TrimJS("/" + name[1] + " " + args)
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
			if err := host.SetMode(mode); err != nil {
				return // nothing was persisted, so don't claim the mode changed
			}
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
				if err := host.SetMode(currentMode); err != nil {
					return
				}
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
