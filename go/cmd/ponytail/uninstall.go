package main

// Port of scripts/uninstall.js — removes state ponytail wrote outside the
// plugin's own files: the mode flag, the config file, and the statusLine entry
// it added to settings.json. Plugin files themselves are removed by each host's
// own uninstall command (see README); this only cleans up what those commands
// can't see.

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/DietrichGebert/ponytail/go/internal/config"
	"github.com/DietrichGebert/ponytail/go/internal/jsonorder"
)

// statuslineMarker identifies a ponytail statusline command. The shell scripts
// are gone in the Go port, but an installation made by an older Node release
// still points at them, so match both.
var statuslineMarkers = []string{"ponytail-statusline", "ponytail\" statusline", "ponytail statusline"}

func isPonytailStatusline(command string) bool {
	for _, marker := range statuslineMarkers {
		if strings.Contains(command, marker) {
			return true
		}
	}
	return false
}

func removeIfExists(stdout io.Writer, path, label string) error {
	err := os.Remove(path)
	if err == nil {
		fmt.Fprintf(stdout, "Removed %s: %s\n", label, path)
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func runUninstall(stdout, stderr io.Writer) error {
	if err := removeIfExists(stdout, filepath.Join(config.ClaudeDir(), ".ponytail-active"), "mode flag"); err != nil {
		return err
	}
	if err := removeIfExists(stdout, config.ConfigPath(), "config file"); err != nil {
		return err
	}

	settingsPath := filepath.Join(config.ClaudeDir(), "settings.json")
	raw, err := os.ReadFile(settingsPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil // no settings.json — nothing to clean
	}
	if err != nil {
		return err
	}

	bom := ""
	body := raw
	if stripped := config.StripBOM(raw); len(stripped) != len(raw) {
		bom = "\ufeff"
		body = stripped
	}

	parsed, err := jsonorder.Unmarshal(body)
	if err != nil {
		// ponytail: malformed settings.json — can't safely edit it; leave intact, warn.
		fmt.Fprintf(stderr, "settings.json is malformed — could not remove the ponytail statusLine entry. "+
			"Remove it manually from: %s (%s)\n", settingsPath, err)
		return nil
	}
	settings, ok := parsed.(*jsonorder.Object)
	if !ok {
		return nil
	}

	statusLineValue, ok := settings.Get("statusLine")
	if !ok {
		return nil
	}
	statusLine, ok := statusLineValue.(*jsonorder.Object)
	if !ok {
		return nil
	}
	commandValue, ok := statusLine.Get("command")
	if !ok {
		return nil
	}
	command, ok := commandValue.(string)
	if !ok || !isPonytailStatusline(command) {
		return nil
	}

	// Only remove the parts ponytail owns. If the user combined statuslines
	// (e.g. caveman && ponytail), keep the other plugin's command intact.
	// ponytail: splits on && / ; to detect other segments — good enough; a user
	// piping statuslines together is on their own.
	var others []string
	for _, part := range strings.FieldsFunc(command, func(r rune) bool { return r == ';' }) {
		for _, segment := range strings.Split(part, "&&") {
			segment = strings.TrimSpace(segment)
			if segment != "" && !isPonytailStatusline(segment) {
				others = append(others, segment)
			}
		}
	}

	message := ""
	if len(others) == 0 {
		settings.Delete("statusLine")
		message = fmt.Sprintf("Removed ponytail statusLine entry from %s\n", settingsPath)
	} else {
		statusLine.Set("command", strings.Join(others, " && "))
		message = fmt.Sprintf("Removed ponytail statusLine segment from %s\n", settingsPath)
	}

	encoded, err := jsonorder.Marshal(settings)
	if err != nil {
		return err
	}
	if err := os.WriteFile(settingsPath, append([]byte(bom), encoded...), 0o644); err != nil {
		return err
	}
	fmt.Fprint(stdout, message)
	return nil
}
