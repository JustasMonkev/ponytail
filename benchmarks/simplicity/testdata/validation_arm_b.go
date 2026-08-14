// Package instructions is the Go port of hooks/ponytail-instructions.js — the
// shared Ponytail instruction builder.
package testdata

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

// These are transcribed from the JS, where \s covers the Unicode space set and
// `.` excludes CR and the line separators as well as LF. Using Go's narrower \s
// and `.` here let another mode's intensity row survive into the payload when
// SKILL.md contains a non-breaking space — a routine copy-paste artifact.
var (
	js    = strings.NewReplacer(`\s`, "["+config.JSSpaceClass+"]", `\S`, "[^"+config.JSSpaceClass+"]")
	jsDot = `[^\n\r\x{2028}\x{2029}]`

	tableLabelRe = regexp.MustCompile(js.Replace(`^\|\s*\*\*(` + jsDot + `+?)\*\*\s*\|`))
	exampleRe    = regexp.MustCompile(js.Replace(`^-\s*([^:]+):\s*"`))
)

// stripFrontmatter removes a leading `---` … `---` block and the whitespace
// after it: the JS /^---[\s\S]*?---\s*/ without the engine.
//
// The pattern is anchored, its `[\s\S]*?` is lazy and its trailing `\s*` always
// matches, so the whole pattern reduces to "if the body opens with ---, cut
// through the next --- and the JS whitespace behind it". IsJSSpace is the same
// character set the ported `\s` expands to, so the trim is the same trim.
func stripFrontmatter(body string) string {
	const fence = "---"
	if !strings.HasPrefix(body, fence) {
		return body
	}
	closing := strings.Index(body[len(fence):], fence)
	if closing < 0 {
		return body
	}
	return strings.TrimLeftFunc(body[2*len(fence)+closing:], config.IsJSSpace)
}

// splitLines splits on the JS /\r?\n/ without paying the regexp engine, which
// profiled as more than half the cost of every tools/call. `\r?\n` always
// consumes the \n and at most the single \r directly before it, so splitting on
// \n and dropping one trailing \r is the same split, character for character.
func splitLines(s string) []string {
	lines := make([]string, 0, strings.Count(s, "\n")+1)
	for {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			return append(lines, s)
		}
		line := s[:i]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		lines = append(lines, line)
		s = s[i+1:]
	}
}

// modeLabel returns the mode a line is keyed to, or "" when the line is not a
// mode-specific intensity row or worked example and so belongs in every mode.
//
// Both patterns are anchored at ^ and neither is multiline, so a line can only
// match if its first byte is the literal the pattern opens with. The byte test
// is a prefilter, not an extra rule: it decides exactly what the regex would
// have decided, and skips the engine for the ~90% of lines that are prose.
func modeLabel(line string) string {
	if line == "" {
		return ""
	}
	if line[0] == '|' {
		if label := tableLabelRe.FindStringSubmatch(line); label != nil {
			return config.NormalizeMode(strings.TrimSpace(label[1]))
		}
	}
	// A worked example needs a quoted value: every one of them is
	// `- lite: "..."`. Without that requirement an ordinary rule bullet that
	// happens to start with a mode word (e.g. "- Full: ...") is silently dropped
	// in every other mode — it looks like a worked example but is really prose
	// meant to survive verbatim. The colon and the quote are literals of the
	// pattern, so scanning for them first keeps the engine off the long prose
	// bullets, which is where it spent nearly all of its time.
	if line[0] == '-' {
		if colon := strings.IndexByte(line, ':'); colon >= 0 && strings.IndexByte(line[colon+1:], '"') >= 0 {
			if label := exampleRe.FindStringSubmatch(line); label != nil {
				return config.NormalizeMode(strings.TrimSpace(label[1]))
			}
		}
	}
	return ""
}

// Root locates the ponytail checkout so the runtime ruleset (SKILL.md) and the
// package version can be read.
//
// The JS hooks resolve these relative to __dirname; a compiled binary has no
// source directory, so look at the plugin-root env vars each host sets, then walk
// up from the executable. Nothing found is not an error: callers fall back to the
// condensed ruleset, exactly as the JS falls back when the read throws.
//
// The working directory is deliberately NOT searched. SKILL.md becomes system
// instructions for the agent, and the working directory is the repository under
// edit — untrusted content. A checked-in skills/ponytail/SKILL.md would otherwise
// replace ponytail's rules with whatever that repo says. The Node hooks always
// read their own __dirname and are not reachable this way; neither is this.
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
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		if root := walkUp(filepath.Dir(exe)); root != "" {
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
	withoutFrontmatter := stripFrontmatter(body)

	lines := splitLines(withoutFrontmatter)
	kept := lines[:0] // filtering in place: the write index never passes the read index
	for _, line := range lines {
		if label := modeLabel(line); label != "" && label != effectiveMode {
			continue
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
