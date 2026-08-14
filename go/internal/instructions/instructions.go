// Package instructions is the Go port of hooks/ponytail-instructions.js — the
// shared Ponytail instruction builder.
package instructions

//go:generate node ../../../scripts/gen-go-fallback.js

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/DietrichGebert/ponytail/go/internal/config"
)

// Modes whose behavior lives in their own skill rather than the shared ruleset.
var independentModes = map[string]bool{"review": true}

// Intensity is one line per level, from SKILL.md's table — the condensed payload
// must still say what the active level *means*, or a lite subagent enforces full
// and an ultra subagent never hears it should be the extremist.
var Intensity = map[string]string{
	"lite":  "Build what's asked, but name the lazier alternative in one line. User picks.",
	"full":  "The ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.",
	"ultra": "YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same breath.",
}

const skillRelPath = "skills/ponytail/SKILL.md"

var (
	frontmatterRe = regexp.MustCompile(`(?s)^---.*?---[\t\n\f\r ]*`)
	tableLabelRe  = regexp.MustCompile(`^\|\s*\*\*(.+?)\*\*\s*\|`)
	exampleRe     = regexp.MustCompile(`^-\s*([^:]+):\s*"`)
	lineSplitRe   = regexp.MustCompile(`\r?\n`)
)

// Root locates the ponytail checkout so the runtime ruleset (SKILL.md) and the
// package version can be read.
//
// The JS hooks resolve these relative to __dirname; a compiled binary has no
// source directory, so look at the plugin-root env vars each host sets, then walk
// up from the executable and the working directory. Nothing found is not an
// error: callers fall back to the embedded ruleset, exactly as the JS falls back
// when the read throws.
func Root() string {
	if explicit := os.Getenv("PONYTAIL_ROOT"); explicit != "" {
		return explicit
	}
	for _, env := range []string{"CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"} {
		if root := os.Getenv(env); root != "" && hasSkill(root) {
			return root
		}
	}
	if exe, err := os.Executable(); err == nil {
		if root := walkUp(filepath.Dir(exe)); root != "" {
			return root
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		if root := walkUp(cwd); root != "" {
			return root
		}
	}
	return ""
}

func hasSkill(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(skillRelPath)))
	return err == nil && !info.IsDir()
}

// walkUp climbs to the filesystem root looking for the skills directory. The
// loop is bounded by the path itself: filepath.Dir is a fixed point at the root.
func walkUp(dir string) string {
	for {
		if hasSkill(dir) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// SkillPath returns the SKILL.md path, or "" when the checkout can't be located.
// PONYTAIL_SKILL_PATH overrides the search outright.
func SkillPath() string {
	if explicit := os.Getenv("PONYTAIL_SKILL_PATH"); explicit != "" {
		return explicit
	}
	root := Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, filepath.FromSlash(skillRelPath))
}

// FilterSkillBodyForMode strips the frontmatter and drops the intensity-table
// rows and worked examples belonging to other modes.
//
// Only the intensity table rows and worked examples are mode-specific, and both
// are keyed by a mode name (lite/full/ultra). A bullet whose label is not a mode
// — e.g. "No unrequested abstractions: ..." — is a normal rule and must be kept
// verbatim.
func FilterSkillBodyForMode(body, mode string) string {
	effectiveMode := config.NormalizeMode(mode)
	if effectiveMode == "" {
		effectiveMode = config.DefaultMode
	}
	withoutFrontmatter := frontmatterRe.ReplaceAllString(body, "")

	lines := lineSplitRe.Split(withoutFrontmatter, -1)
	kept := lines[:0:0]
	for _, line := range lines {
		if label := tableLabelRe.FindStringSubmatch(line); label != nil {
			if labelMode := config.NormalizeMode(strings.TrimSpace(label[1])); labelMode != "" {
				if labelMode != effectiveMode {
					continue
				}
				kept = append(kept, line)
				continue
			}
		}

		// Require a quoted value: every worked example is `- lite: "..."`. Without
		// this, an ordinary rule bullet that happens to start with a mode word
		// (e.g. "- Full: ...") is silently dropped in every other mode — it looks
		// like a worked example but is really prose meant to survive verbatim.
		if label := exampleRe.FindStringSubmatch(line); label != nil {
			if labelMode := config.NormalizeMode(strings.TrimSpace(label[1])); labelMode != "" {
				if labelMode != effectiveMode {
					continue
				}
				kept = append(kept, line)
				continue
			}
		}

		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

// FallbackInstructions is the condensed ruleset used when SKILL.md can't be read
// and for subagent injection.
func FallbackInstructions(mode string) string {
	intensity, ok := Intensity[mode]
	if !ok {
		intensity = Intensity["full"]
	}
	return "PONYTAIL MODE ACTIVE — level: " + mode + "\n\n" +
		fallbackHead +
		"Current level: **" + mode + "** — " + intensity +
		" Switch: `/ponytail lite|full|ultra`.\n\n" +
		fallbackTail
}

func independent(mode string) string {
	return "PONYTAIL MODE ACTIVE — level: " + mode + ". Behavior defined by /ponytail-" + mode + " skill."
}

// GetPonytailInstructions returns the full ruleset filtered to the active level,
// falling back to the condensed form when SKILL.md is unreadable.
func GetPonytailInstructions(mode string) string {
	configuredMode := config.NormalizePersistedMode(mode)
	if configuredMode == "" {
		configuredMode = config.DefaultMode
	}
	if independentModes[configuredMode] {
		return independent(configuredMode)
	}

	effectiveMode := config.NormalizeMode(configuredMode)
	if effectiveMode == "" {
		effectiveMode = config.DefaultMode
	}

	path := SkillPath()
	if path == "" {
		return FallbackInstructions(effectiveMode)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return FallbackInstructions(effectiveMode)
	}
	return "PONYTAIL MODE ACTIVE — level: " + effectiveMode + "\n\n" +
		FilterSkillBodyForMode(string(body), effectiveMode)
}

// GetSubagentInstructions returns the condensed ruleset, not the full SKILL.md
// (#597). A heavy Task session spawns dozens of subagents and the full body
// repeats ~1,300 tokens per spawn; the condensed form keeps everything
// operational (ladder, rules, output format, safety boundaries) at roughly half
// the size, dropping only the intensity comparison and worked examples a
// single-task subagent never uses.
func GetSubagentInstructions(mode string) string {
	configuredMode := config.NormalizePersistedMode(mode)
	if configuredMode == "" {
		configuredMode = config.DefaultMode
	}
	if independentModes[configuredMode] {
		return independent(configuredMode)
	}
	effectiveMode := config.NormalizeMode(configuredMode)
	if effectiveMode == "" {
		effectiveMode = config.DefaultMode
	}
	return FallbackInstructions(effectiveMode)
}
