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
	path := filepath.Join(config.ClaudeDir(), ".ponytail-active")

	// The shell script guards with `[ -f ]`. Without the same check a FIFO left
	// at this path blocks the read forever and a symlink to /dev/zero reads
	// without bound — and the statusline runs on every prompt render.
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}

	firstLine, _, _ := strings.Cut(string(raw), "\n")
	// `tr -d '[:space:]'` in the C locale strips ASCII whitespace only, and bash
	// drops NUL from command substitution. Stripping every unicode space instead
	// would turn a non-breaking-space-padded flag into a recognised mode here and
	// not there — including the colour it picks.
	mode := strings.Map(func(r rune) rune {
		if r <= unicode.MaxASCII && (unicode.IsSpace(r) || r == 0) {
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
