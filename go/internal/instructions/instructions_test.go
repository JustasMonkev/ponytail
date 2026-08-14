package instructions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleSkill = `---
name: ponytail
description: frontmatter that must be stripped
---

# Ponytail

| Level | Behavior |
|---|---|
| **lite** | name the lazier option |
| **full** | the ladder enforced |
| **ultra** | YAGNI extremist |

- lite: "one line for lite"
- full: "one line for full"
- ultra: "one line for ultra"

- No unrequested abstractions: keep this bullet in every mode.
- Full: this is prose, not a worked example, so it survives every mode.
`

func withSkill(t *testing.T, body string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "SKILL.md")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PONYTAIL_SKILL_PATH", path)
}

func TestFilterSkillBodyStripsFrontmatter(t *testing.T) {
	got := FilterSkillBodyForMode(sampleSkill, "full")
	if strings.Contains(got, "frontmatter that must be stripped") {
		t.Error("frontmatter must be removed")
	}
	if !strings.HasPrefix(got, "# Ponytail") {
		t.Errorf("body must start at the heading, got %q", got[:min(40, len(got))])
	}
}

func TestFilterSkillBodyKeepsOnlyActiveModeRows(t *testing.T) {
	for _, mode := range []string{"lite", "full", "ultra"} {
		got := FilterSkillBodyForMode(sampleSkill, mode)
		if !strings.Contains(got, "| **"+mode+"** |") {
			t.Errorf("%s: own table row must survive", mode)
		}
		if !strings.Contains(got, `- `+mode+`: "one line for `+mode+`"`) {
			t.Errorf("%s: own worked example must survive", mode)
		}
		for _, other := range []string{"lite", "full", "ultra"} {
			if other == mode {
				continue
			}
			if strings.Contains(got, "| **"+other+"** |") {
				t.Errorf("%s: table row for %s must be dropped", mode, other)
			}
			if strings.Contains(got, `- `+other+`: "one line for `+other+`"`) {
				t.Errorf("%s: worked example for %s must be dropped", mode, other)
			}
		}
	}
}

// A bullet whose label is not a mode, and a mode-looking bullet without a quoted
// value, are ordinary prose and must survive in every mode.
func TestFilterSkillBodyKeepsProseBullets(t *testing.T) {
	for _, mode := range []string{"lite", "full", "ultra"} {
		got := FilterSkillBodyForMode(sampleSkill, mode)
		if !strings.Contains(got, "No unrequested abstractions") {
			t.Errorf("%s: non-mode bullet was dropped", mode)
		}
		if !strings.Contains(got, "- Full: this is prose") {
			t.Errorf("%s: unquoted mode-labelled prose was dropped", mode)
		}
	}
}

func TestFilterSkillBodyUnknownModeUsesDefault(t *testing.T) {
	if FilterSkillBodyForMode(sampleSkill, "bogus") != FilterSkillBodyForMode(sampleSkill, "full") {
		t.Error("an unknown mode must filter as full")
	}
}

func TestFilterSkillBodyNormalizesCRLF(t *testing.T) {
	got := FilterSkillBodyForMode("---\r\nx: 1\r\n---\r\nkeep\r\nme\r\n", "full")
	if strings.Contains(got, "\r") {
		t.Errorf("carriage returns must be normalized away, got %q", got)
	}
	if !strings.Contains(got, "keep\nme") {
		t.Errorf("body lost, got %q", got)
	}
}

func TestGetPonytailInstructionsUsesSkillFile(t *testing.T) {
	withSkill(t, sampleSkill)
	got := GetPonytailInstructions("ultra")
	if !strings.HasPrefix(got, "PONYTAIL MODE ACTIVE — level: ultra\n\n") {
		t.Errorf("missing mode header, got %q", got[:min(60, len(got))])
	}
	if !strings.Contains(got, "YAGNI extremist") {
		t.Error("skill body must be included")
	}
}

func TestGetPonytailInstructionsFallsBackWhenSkillMissing(t *testing.T) {
	t.Setenv("PONYTAIL_SKILL_PATH", filepath.Join(t.TempDir(), "absent.md"))
	got := GetPonytailInstructions("lite")
	if got != FallbackInstructions("lite") {
		t.Error("an unreadable SKILL.md must fall back to the condensed ruleset")
	}
	if !strings.Contains(got, "Current level: **lite**") {
		t.Error("fallback must name the active level")
	}
}

func TestIndependentModeDelegatesToItsSkill(t *testing.T) {
	withSkill(t, sampleSkill)
	want := "PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill."
	if got := GetPonytailInstructions("review"); got != want {
		t.Errorf("GetPonytailInstructions(review) = %q", got)
	}
	if got := GetSubagentInstructions("review"); got != want {
		t.Errorf("GetSubagentInstructions(review) = %q", got)
	}
}

func TestUnknownModeBecomesDefault(t *testing.T) {
	withSkill(t, sampleSkill)
	if GetPonytailInstructions("nonsense") != GetPonytailInstructions("full") {
		t.Error("unknown mode must resolve to full")
	}
	if GetSubagentInstructions("") != GetSubagentInstructions("full") {
		t.Error("empty mode must resolve to full")
	}
}

// Subagents get the condensed ruleset, never the full SKILL.md body (#597).
func TestSubagentInstructionsAreCondensed(t *testing.T) {
	withSkill(t, sampleSkill)
	got := GetSubagentInstructions("ultra")
	if got != FallbackInstructions("ultra") {
		t.Error("subagent payload must be the condensed ruleset")
	}
	if strings.Contains(got, "one line for ultra") {
		t.Error("subagent payload must not carry SKILL.md worked examples")
	}
}

// The point of the condensed payload is size: measured against the real
// SKILL.md, it must actually be smaller or #597 is unfixed.
func TestSubagentPayloadIsSmallerThanRealSkill(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	os.Unsetenv("PONYTAIL_SKILL_PATH")
	t.Setenv("PONYTAIL_ROOT", repoRoot)
	if _, err := os.Stat(SkillPath()); err != nil {
		t.Skipf("real SKILL.md not available: %v", err)
	}

	full := GetPonytailInstructions("ultra")
	condensed := GetSubagentInstructions("ultra")
	if len(condensed) >= len(full) {
		t.Errorf("condensed payload (%d bytes) must be smaller than the full ruleset (%d bytes)", len(condensed), len(full))
	}
}

func TestFallbackCarriesTheSafetyCarveOuts(t *testing.T) {
	// The rules ponytail must never simplify away — a reworded fallback that
	// drops one of these silently removes a safety guard.
	invariants := []string{
		"input validation at trust boundaries",
		"prevents data loss",
		"security",
		"accessibility",
		"ONE risk-targeted runnable check",
		"coverage is the deliverable",
		"No self-reference",
	}
	for _, mode := range []string{"lite", "full", "ultra"} {
		got := FallbackInstructions(mode)
		for _, phrase := range invariants {
			if !strings.Contains(got, phrase) {
				t.Errorf("%s fallback is missing invariant %q", mode, phrase)
			}
		}
	}
}

func TestFallbackDescribesTheActiveIntensity(t *testing.T) {
	for mode, blurb := range Intensity {
		if !strings.Contains(FallbackInstructions(mode), blurb) {
			t.Errorf("%s fallback must describe its own intensity", mode)
		}
	}
	// off has no intensity blurb of its own and borrows full's.
	if !strings.Contains(FallbackInstructions("off"), Intensity["full"]) {
		t.Error("an unlisted level must borrow the full blurb")
	}
}

func TestRootAndSkillPathOverrides(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, "skills", "ponytail")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(sampleSkill), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PONYTAIL_SKILL_PATH", "")
	os.Unsetenv("PONYTAIL_SKILL_PATH")
	t.Setenv("PONYTAIL_ROOT", root)
	if got := Root(); got != root {
		t.Errorf("Root() = %q, want %q", got, root)
	}
	if got, want := SkillPath(), filepath.Join(skillDir, "SKILL.md"); got != want {
		t.Errorf("SkillPath() = %q, want %q", got, want)
	}

	// CLAUDE_PLUGIN_ROOT is only trusted when the skill actually lives there.
	os.Unsetenv("PONYTAIL_ROOT")
	t.Setenv("CLAUDE_PLUGIN_ROOT", filepath.Join(t.TempDir(), "not-a-checkout"))
	if got := Root(); got == os.Getenv("CLAUDE_PLUGIN_ROOT") {
		t.Error("a plugin root without skills/ must not be accepted")
	}
	t.Setenv("CLAUDE_PLUGIN_ROOT", root)
	if got := Root(); got != root {
		t.Errorf("Root() = %q, want %q", got, root)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
