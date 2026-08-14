package main

// Port of hooks/ponytail-statusline.sh and hooks/ponytail-statusline.ps1 — the
// status badge. One implementation replaces the shell and PowerShell copies.

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/DietrichGebert/ponytail/go/internal/config"
)

func runStatusline(stdout io.Writer) {
	// CLAUDE_CONFIG_DIR overrides ~/.claude, matching where the hooks write the
	// flag (#34).
	raw, err := os.ReadFile(filepath.Join(config.ClaudeDir(), ".ponytail-active"))
	if err != nil {
		return
	}

	firstLine, _, _ := strings.Cut(string(raw), "\n")
	mode := strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, firstLine)

	// ultra is the high-intensity mode; flag it amber so it stands out from the
	// default green at a glance. The level is still in the text, so color is a
	// redundant cue, not the only one.
	color := "108"
	if mode == "ultra" {
		color = "173"
	}

	if mode == "" || mode == "full" {
		fmt.Fprintf(stdout, "\033[38;5;%sm[PONYTAIL]\033[0m", color)
		return
	}
	fmt.Fprintf(stdout, "\033[38;5;%sm[PONYTAIL:%s]\033[0m", color, strings.ToUpper(mode))
}
