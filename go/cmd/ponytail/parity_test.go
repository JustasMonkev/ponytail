package main

// Differential tests: run the original Node implementation and this port side by
// side on the same inputs and require byte-identical output. A port that only
// passes its own tests proves the tests agree with the port, not that the port
// agrees with the thing it replaced.
//
// Skipped automatically when Node or the checkout is unavailable.

import (
	"bytes"
	"encoding/json"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DietrichGebert/ponytail/go/internal/instructions"
)

// parityModes covers every level plus the shapes that must fall back.
var parityModes = []string{"lite", "full", "ultra", "off", "review", "", "nonsense", "  ULTRA  "}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "hooks", "ponytail-instructions.js")); err != nil {
		t.Skipf("Node implementation not present: %v", err)
	}
	return root
}

func nodeBinary(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed; skipping differential parity tests")
	}
	return node
}

// parityEnv builds a fully isolated environment shared by both implementations.
func parityEnv(t *testing.T, extra ...string) (env []string, home string) {
	t.Helper()
	home = t.TempDir()
	env = []string{
		"HOME=" + home,
		"USERPROFILE=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, "xdg"),
		"PATH=" + os.Getenv("PATH"),
		// The port is built into a temp dir for these tests, so it cannot find
		// the checkout by walking up from the executable the way an installed
		// binary does — and it deliberately refuses to look in the working
		// directory. Point it at the checkout Node reads via __dirname.
		"PONYTAIL_ROOT=" + repoRoot(t),
	}
	return append(env, extra...), home
}

type nodePayload struct {
	Instructions string `json:"instructions"`
	Subagent     string `json:"subagent"`
	Fallback     string `json:"fallback"`
	Filtered     string `json:"filtered"`
}

func TestInstructionsMatchNode(t *testing.T) {
	root := repoRoot(t)
	node := nodeBinary(t)
	harness := filepath.Join(root, "go", "testdata", "dump-instructions.js")

	skillBody, err := os.ReadFile(filepath.Join(root, "skills", "ponytail", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}

	for _, mode := range parityModes {
		t.Run("mode="+strings.TrimSpace(mode), func(t *testing.T) {
			env, _ := parityEnv(t)

			cmd := exec.Command(node, harness, root, mode)
			cmd.Env = env
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			raw, err := cmd.Output()
			if err != nil {
				t.Fatalf("node harness failed: %v\n%s", err, stderr.String())
			}

			var want nodePayload
			if err := json.Unmarshal(raw, &want); err != nil {
				t.Fatalf("harness output: %v", err)
			}

			// The Go side must read the same SKILL.md.
			t.Setenv("PONYTAIL_SKILL_PATH", filepath.Join(root, "skills", "ponytail", "SKILL.md"))
			t.Setenv("HOME", filepath.Dir(env[0]))
			t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "xdg"))
			os.Unsetenv("PONYTAIL_DEFAULT_MODE")

			if got := instructions.GetPonytailInstructions(mode); got != want.Instructions {
				t.Errorf("GetPonytailInstructions(%q) diverges from Node:\n%s", mode, firstDiff(got, want.Instructions))
			}
			if got := instructions.GetSubagentInstructions(mode); got != want.Subagent {
				t.Errorf("GetSubagentInstructions(%q) diverges from Node:\n%s", mode, firstDiff(got, want.Subagent))
			}
			if got := instructions.FilterSkillBodyForMode(string(skillBody), mode); got != want.Filtered {
				t.Errorf("FilterSkillBodyForMode(%q) diverges from Node:\n%s", mode, firstDiff(got, want.Filtered))
			}
			// getFallbackInstructions takes an already-resolved level, so only the
			// levels it actually receives are comparable.
			if mode == "lite" || mode == "full" || mode == "ultra" {
				if got := instructions.FallbackInstructions(mode); got != want.Fallback {
					t.Errorf("FallbackInstructions(%q) diverges from Node:\n%s", mode, firstDiff(got, want.Fallback))
				}
			}
		})
	}
}

// goBinary builds the port once per run so hook parity is tested through the
// real executable, stdin and stdout included.
func goBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ponytail")
	build := exec.Command("go", "build", "-o", path, ".")
	build.Env = os.Environ()
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return path
}

func run(t *testing.T, env []string, stdin string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Env = env
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, args, err, stderr.String())
	}
	return stdout.String()
}

// promptCases are the inputs whose hook output must match byte-for-byte. The
// mode-flag side effect is compared too — output alone would miss a hook that
// prints the right thing and writes the wrong state.
var promptCases = []struct {
	name   string
	prompt string
}{
	{"switch to ultra", "/ponytail ultra"},
	{"switch to lite", "/ponytail lite"},
	{"switch off", "/ponytail off"},
	{"bare report", "/ponytail"},
	{"unknown arg", "/ponytail banana"},
	{"at prefix", "@ponytail ultra"},
	{"dollar prefix", "$ponytail lite"},
	{"namespaced", "/ponytail:ponytail ultra"},
	{"review", "/ponytail-review"},
	{"persist default", "/ponytail default ultra"},
	{"persist review rejected", "/ponytail default review"},
	{"skill dispatch envelope", "<command-name>/ponytail</command-name><command-args>ultra</command-args>"},
	{"tags mid message", "see <command-name>/ponytail</command-name><command-args>ultra</command-args>"},
	{"deactivate", "stop ponytail"},
	{"deactivate punctuated", "Normal Mode."},
	{"ordinary request", "add a normal mode toggle"},
	{"unrelated work", "refactor the parser"},
}

func TestPromptHookMatchesNode(t *testing.T) {
	root := repoRoot(t)
	node := nodeBinary(t)
	binary := goBinary(t)
	jsHook := filepath.Join(root, "hooks", "ponytail-mode-tracker.js")

	for _, host := range []struct{ name, marker string }{
		{"claude", ""},
		{"codex", "PLUGIN_DATA="},
		{"copilot", "COPILOT_PLUGIN_DATA="},
		{"qoder", "QODER_SESSION_ID=session-1"},
	} {
		for _, tc := range promptCases {
			t.Run(host.name+"/"+tc.name, func(t *testing.T) {
				payload, err := json.Marshal(map[string]string{"prompt": tc.prompt})
				if err != nil {
					t.Fatal(err)
				}

				jsOut, jsState := runPromptImpl(t, host.marker, string(payload), node, jsHook)
				goOut, goState := runPromptImpl(t, host.marker, string(payload), binary, "prompt")

				if jsOut != goOut {
					t.Errorf("stdout diverges for %q:\n%s", tc.prompt, firstDiff(goOut, jsOut))
				}
				if !maps.Equal(jsState, goState) {
					t.Errorf("state diverges for %q: node=%v go=%v", tc.prompt, jsState, goState)
				}
			})
		}
	}
}

// runPromptImpl runs one implementation in a fresh home and returns its stdout
// plus the state it left behind (mode flag and persisted config).
func runPromptImpl(t *testing.T, marker, payload, name string, args ...string) (stdout string, state map[string]string) {
	t.Helper()
	env, home := parityEnv(t)
	if marker != "" {
		key, value, _ := strings.Cut(marker, "=")
		if value == "" {
			value = filepath.Join(home, "plugin-data")
			if err := os.MkdirAll(value, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		env = append(env, key+"="+value)
		// Codex and Copilot keep their flag under the plugin data dir.
		stdout = run(t, env, payload, name, args...)
		return stdout, collectState(t, home, value)
	}
	stdout = run(t, env, payload, name, args...)
	return stdout, collectState(t, home, "")
}

func collectState(t *testing.T, home, pluginData string) map[string]string {
	t.Helper()
	state := map[string]string{}
	candidates := []string{
		filepath.Join(home, ".claude", ".ponytail-active"),
		filepath.Join(home, ".qoder", ".ponytail-active"),
		filepath.Join(home, "xdg", "ponytail", "config.json"),
	}
	if pluginData != "" {
		candidates = append(candidates, filepath.Join(pluginData, ".ponytail-active"))
	}
	for _, path := range candidates {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		state[filepath.Base(filepath.Dir(path))+"/"+filepath.Base(path)] = strings.TrimSpace(string(raw))
	}
	return state
}

func TestSubagentHookMatchesNode(t *testing.T) {
	root := repoRoot(t)
	node := nodeBinary(t)
	binary := goBinary(t)
	jsHook := filepath.Join(root, "hooks", "ponytail-subagent.js")

	cases := []struct {
		name    string
		mode    string
		matcher string
		payload string
	}{
		{"inactive", "", "", `{"agent_type":"general-purpose"}`},
		{"active full", "full", "", `{"agent_type":"general-purpose"}`},
		{"active ultra", "ultra", "", `{"agent_type":"explore"}`},
		{"active review", "review", "", `{"agent_type":"explore"}`},
		{"off flag", "off", "", `{"agent_type":"explore"}`},
		{"matcher hit", "full", "explore|general", `{"agent_type":"General-Purpose"}`},
		{"matcher miss", "full", "explore|general", `{"agent_type":"code-reviewer"}`},
		{"matcher no agent type", "full", "^nope$", `{}`},
		{"matcher bad payload", "full", "^nope$", `not json`},
		{"matcher invalid regex", "full", "([unclosed", `{"agent_type":"anything"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			jsOut := runSubagentImpl(t, tc.mode, tc.matcher, tc.payload, node, jsHook)
			goOut := runSubagentImpl(t, tc.mode, tc.matcher, tc.payload, binary, "subagent")
			if jsOut != goOut {
				t.Errorf("stdout diverges:\n%s", firstDiff(goOut, jsOut))
			}
		})
	}
}

func runSubagentImpl(t *testing.T, mode, matcher, payload, name string, args ...string) string {
	t.Helper()
	env, home := parityEnv(t)
	if matcher != "" {
		env = append(env, "PONYTAIL_SUBAGENT_MATCHER="+matcher)
	}
	if mode != "" {
		claude := filepath.Join(home, ".claude")
		if err := os.MkdirAll(claude, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(claude, ".ponytail-active"), []byte(mode), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return run(t, env, payload, name, args...)
}

// The SessionStart payload must match too. The statusline nudge is excluded:
// the Go port registers itself as `ponytail statusline` where Node registered a
// shell script, so that one paragraph is intentionally different — every test
// here pre-configures a statusLine to suppress it.
func TestActivateHookMatchesNode(t *testing.T) {
	root := repoRoot(t)
	node := nodeBinary(t)
	binary := goBinary(t)
	jsHook := filepath.Join(root, "hooks", "ponytail-activate.js")

	for _, mode := range []string{"", "lite", "full", "ultra", "off"} {
		for _, host := range []string{"", "PLUGIN_DATA", "COPILOT_PLUGIN_DATA"} {
			name := "default"
			if mode != "" {
				name = mode
			}
			if host != "" {
				name += "/" + host
			}
			t.Run(name, func(t *testing.T) {
				jsOut := runActivateImpl(t, mode, host, node, jsHook)
				goOut := runActivateImpl(t, mode, host, binary, "activate")
				if jsOut != goOut {
					t.Errorf("stdout diverges:\n%s", firstDiff(goOut, jsOut))
				}
			})
		}
	}
}

func runActivateImpl(t *testing.T, mode, hostEnv, name string, args ...string) string {
	t.Helper()
	env, home := parityEnv(t)
	if mode != "" {
		env = append(env, "PONYTAIL_DEFAULT_MODE="+mode)
	}
	if hostEnv != "" {
		dir := filepath.Join(home, "plugin-data")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		env = append(env, hostEnv+"="+dir)
	}
	// Suppress the statusline nudge: it names the host implementation by design.
	claude := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claude, 0o755); err != nil {
		t.Fatal(err)
	}
	settings := `{"statusLine":{"type":"command","command":"already configured"}}`
	if err := os.WriteFile(filepath.Join(claude, "settings.json"), []byte(settings), 0o644); err != nil {
		t.Fatal(err)
	}
	return run(t, env, "", name, args...)
}

func TestStatuslineMatchesShellScript(t *testing.T) {
	root := repoRoot(t)
	binary := goBinary(t)
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not installed")
	}
	script := filepath.Join(root, "hooks", "ponytail-statusline.sh")

	for _, mode := range []string{"full", "lite", "ultra", "review", "", "  ", "ultra\nnoise"} {
		t.Run(strings.ReplaceAll(mode, "\n", "_"), func(t *testing.T) {
			env, home := parityEnv(t)
			claude := filepath.Join(home, ".claude")
			if err := os.MkdirAll(claude, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(claude, ".ponytail-active"), []byte(mode), 0o644); err != nil {
				t.Fatal(err)
			}
			shOut := run(t, env, "", bash, script)
			goOut := run(t, env, "", binary, "statusline")
			if shOut != goOut {
				t.Errorf("badge diverges for %q: shell=%q go=%q", mode, shOut, goOut)
			}
		})
	}

	// No flag file at all: both must print nothing.
	env, _ := parityEnv(t)
	if shOut, goOut := run(t, env, "", bash, script), run(t, env, "", binary, "statusline"); shOut != goOut || goOut != "" {
		t.Errorf("absent flag: shell=%q go=%q", shOut, goOut)
	}
}

func TestUninstallMatchesNode(t *testing.T) {
	root := repoRoot(t)
	node := nodeBinary(t)
	binary := goBinary(t)
	jsScript := filepath.Join(root, "scripts", "uninstall.js")

	cases := map[string]string{
		"own statusline":      `{"statusLine":{"type":"command","command":"bash /p/ponytail-statusline.sh"}}`,
		"foreign statusline":  `{"statusLine":{"type":"command","command":"bash ~/mine.sh"}}`,
		"combined statusline": `{"statusLine":{"type":"command","command":"bash ~/caveman.sh && bash /p/ponytail-statusline.sh"}}`,
		"no statusline":       `{"model":"opus"}`,
		"bom":                 "\ufeff" + `{"statusLine":{"type":"command","command":"bash /p/ponytail-statusline.sh"}}`,
	}

	for name, settings := range cases {
		t.Run(name, func(t *testing.T) {
			jsSettings := runUninstallImpl(t, settings, node, jsScript)
			goSettings := runUninstallImpl(t, settings, binary, "uninstall")
			if jsSettings != goSettings {
				t.Errorf("settings.json diverges:\n%s", firstDiff(goSettings, jsSettings))
			}
		})
	}
}

// runUninstallImpl seeds a home with state, runs one implementation, and returns
// the resulting settings.json.
func runUninstallImpl(t *testing.T, settings, name string, args ...string) string {
	t.Helper()
	env, home := parityEnv(t)
	claude := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claude, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(claude, ".ponytail-active"), []byte("ultra"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(claude, "settings.json"), []byte(settings), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, env, "", name, args...)

	if _, err := os.Stat(filepath.Join(claude, ".ponytail-active")); err == nil {
		t.Error("mode flag must be removed")
	}
	raw, err := os.ReadFile(filepath.Join(claude, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// firstDiff renders the first divergence with a little context, so a failure on
// a multi-kilobyte ruleset points at the byte that differs.
func firstDiff(got, want string) string {
	if got == want {
		return "(identical)"
	}
	i := 0
	for i < len(got) && i < len(want) && got[i] == want[i] {
		i++
	}
	start := i - 60
	if start < 0 {
		start = 0
	}
	clip := func(s string) string {
		end := i + 60
		if end > len(s) {
			end = len(s)
		}
		return s[start:end]
	}
	return "at byte " + itoa(i) + "\n go:  ..." + clip(got) + "...\n node: ..." + clip(want) + "..."
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
