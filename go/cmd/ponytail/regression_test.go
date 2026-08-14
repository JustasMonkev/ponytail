package main

// Regressions for divergences the differential audit turned up. Each one is a
// case where the port disagreed with the Node original, or where the port could
// destroy state Node left alone.

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/DietrichGebert/ponytail/go/internal/instructions"
)

// slowReader delivers a payload and then never reaches EOF, the way the Windows
// PowerShell wrapper leaves the hook's stdin (#443).
type slowReader struct {
	data []byte
	sent bool
	stop chan struct{}
}

func (r *slowReader) Read(p []byte) (int, error) {
	if !r.sent {
		r.sent = true
		n := copy(p, r.data)
		return n, nil
	}
	<-r.stop // block forever, exactly like a pipe nobody closes
	return 0, nil
}

// The timeout path must process what already arrived. Discarding it defeats the
// only reason the timeout exists, and leaves the mode untracked on the host the
// recovery was written for.
func TestPromptRecoversPayloadWhenStdinNeverCloses(t *testing.T) {
	home := sandbox(t)
	reader := &slowReader{data: []byte(`{"prompt":"/ponytail ultra"}`), stop: make(chan struct{})}
	defer close(reader.stop)

	var out bytes.Buffer
	start := time.Now()
	runPrompt(reader, &out)
	elapsed := time.Since(start)

	if out.String() != "PONYTAIL MODE CHANGED — level: ultra" {
		t.Errorf("output = %q, want the mode change", out.String())
	}
	if got := readFlag(t, home); got != "ultra" {
		t.Errorf("flag = %q, want ultra", got)
	}
	if elapsed < stdinTimeout {
		t.Errorf("returned in %v, before the timeout — the wait was skipped", elapsed)
	}
	if elapsed > 5*time.Second {
		t.Errorf("took %v; the hook must never hang the session", elapsed)
	}
}

func TestSubagentScopingSurvivesStdinThatNeverCloses(t *testing.T) {
	sandbox(t)
	runPromptWith(t, "/ponytail full")
	t.Setenv("PONYTAIL_SUBAGENT_MATCHER", "^explore$")

	reader := &slowReader{data: []byte(`{"agent_type":"code-reviewer"}`), stop: make(chan struct{})}
	defer close(reader.stop)

	var out bytes.Buffer
	runSubagent(reader, &out)
	if out.Len() != 0 {
		t.Error("a definite mismatch must be honoured even without EOF")
	}
}

// SKILL.md becomes system instructions, and the working directory is the
// repository under edit — untrusted. A checked-in skills/ponytail/SKILL.md must
// never be picked up.
func TestRulesetIsNeverLoadedFromTheWorkingDirectory(t *testing.T) {
	sandbox(t)
	os.Unsetenv("PONYTAIL_SKILL_PATH")

	rogue := t.TempDir()
	skillDir := filepath.Join(rogue, "skills", "ponytail")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("ROGUE RULESET\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(rogue, "project", "sub")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	original, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(original)
	if err := os.Chdir(nested); err != nil {
		t.Fatal(err)
	}

	if root := instructions.Root(); root == rogue {
		t.Fatalf("Root() resolved to the working directory tree: %s", root)
	}
	if got := instructions.GetPonytailInstructions("full"); strings.Contains(got, "ROGUE RULESET") {
		t.Error("a SKILL.md in the working directory must never become the ruleset")
	}
}

// A closed stdout must not kill the hook. Go raises SIGPIPE fatally on writes to
// fd 1, so without an explicit ignore the process dies with 141 where Node's
// SubagentStart hook exits 0 — and the host reads that as a hook failure on
// every Task spawn.
func TestSubagentExitsCleanlyWhenStdoutIsClosed(t *testing.T) {
	binary := goBinary(t)
	env, home := parityEnv(t)
	claude := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claude, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(claude, ".ponytail-active"), []byte("full"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, subcommand := range []string{"subagent", "activate", "statusline"} {
		t.Run(subcommand, func(t *testing.T) {
			// `head -c 0` exits before reading a byte, so our write hits EPIPE.
			cmd := exec.Command("sh", "-c", `"$1" `+subcommand+` | head -c 0`, "sh", binary)
			cmd.Env = env
			cmd.Stdin = strings.NewReader("{}")
			if err := cmd.Run(); err != nil {
				t.Errorf("exited %v on a closed stdout; must exit 0", err)
			}
			if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				t.Errorf("killed by %v", status.Signal())
			}
		})
	}
}

// The badge runs on every prompt render, so a non-regular flag file must not
// block it. The shell script guards with `[ -f ]`.
func TestStatuslineDoesNotBlockOnAFIFO(t *testing.T) {
	home := sandbox(t)
	if err := os.MkdirAll(claudeDir(home), 0o755); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(claudeDir(home), ".ponytail-active")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skipf("cannot create a FIFO here: %v", err)
	}

	done := make(chan string, 1)
	go func() {
		var out bytes.Buffer
		runStatusline(&out)
		done <- out.String()
	}()
	select {
	case got := <-done:
		if got != "" {
			t.Errorf("a FIFO is not a mode flag; got %q", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("statusline blocked on a FIFO — it would hang the host's status bar")
	}
}

// A user's own statusline whose command merely contains the words must survive.
func TestUninstallKeepsLookalikeStatuslineCommands(t *testing.T) {
	for name, command := range map[string]string{
		"hyphenated lookalike":  "bash ~/my-ponytail statusline-widget.sh",
		"underscored lookalike": "/usr/bin/env my_ponytail statusline_v2",
	} {
		t.Run(name, func(t *testing.T) {
			home := sandbox(t)
			original := `{"statusLine":{"type":"command","command":"` + command + `"}}`
			writeSettings(t, home, original)

			if stdout, _ := uninstall(t); stdout != "" {
				t.Errorf("nothing of ours here, got %q", stdout)
			}
			raw, err := os.ReadFile(settingsPath(home))
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != original {
				t.Errorf("a lookalike command must be left untouched:\n%s", raw)
			}
		})
	}

	// Our own registrations are still recognised.
	for name, command := range map[string]string{
		"go binary quoted":   `"/opt/ponytail/bin/ponytail" statusline`,
		"go binary unquoted": `/opt/ponytail/bin/ponytail statusline`,
		"on PATH":            `ponytail statusline`,
		"legacy script":      `bash /p/hooks/ponytail-statusline.sh`,
	} {
		t.Run(name, func(t *testing.T) {
			home := sandbox(t)
			writeSettings(t, home, `{"statusLine":{"type":"command","command":`+mustJSON(t, command)+`}}`)
			uninstall(t)

			raw, _ := os.ReadFile(settingsPath(home))
			var parsed map[string]any
			if err := json.Unmarshal(raw, &parsed); err != nil {
				t.Fatal(err)
			}
			if _, ok := parsed["statusLine"]; ok {
				t.Errorf("our own registration must be removed: %s", raw)
			}
		})
	}
}

// JSON's last-wins duplicate semantics decide which statusLine the host honours.
func TestUninstallHonoursDuplicateKeySemantics(t *testing.T) {
	t.Run("ponytail is the effective value", func(t *testing.T) {
		home := sandbox(t)
		writeSettings(t, home,
			`{"statusLine":{"command":"bash /a/other.sh"},"statusLine":{"command":"bash /x/ponytail-statusline.sh"}}`)
		uninstall(t)

		raw, _ := os.ReadFile(settingsPath(home))
		var parsed map[string]any
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatal(err)
		}
		if _, ok := parsed["statusLine"]; ok {
			t.Errorf("the live ponytail statusLine must be removed: %s", raw)
		}
	})

	t.Run("a foreign value shadows ours", func(t *testing.T) {
		home := sandbox(t)
		original := `{"statusLine":{"command":"bash /x/ponytail-statusline.sh"},"statusLine":{"command":"zzz"}}`
		writeSettings(t, home, original)
		uninstall(t)

		raw, _ := os.ReadFile(settingsPath(home))
		if string(raw) != original {
			t.Errorf("the effective statusLine isn't ours, so nothing should change:\n%s", raw)
		}
	})
}

// A directory where ponytail expects its own file belongs to the user.
func TestUninstallRefusesToDeleteADirectory(t *testing.T) {
	home := sandbox(t)
	flagPath := filepath.Join(claudeDir(home), ".ponytail-active")
	if err := os.MkdirAll(flagPath, 0o755); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	if err := runUninstall(&out, &errOut); err == nil {
		t.Error("expected an error rather than a silent delete")
	}
	if _, err := os.Stat(flagPath); err != nil {
		t.Error("the directory must still exist")
	}
}

// State must never land in the working directory when HOME is unresolvable.
func TestStatePathsAreAbsoluteWithoutHOME(t *testing.T) {
	binary := goBinary(t)
	work := t.TempDir()

	cmd := exec.Command(binary, "prompt")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "XDG_CONFIG_HOME=" + filepath.Join(work, "xdg")}
	cmd.Dir = work
	cmd.Stdin = strings.NewReader(`{"prompt":"/ponytail ultra"}`)
	if err := cmd.Run(); err != nil {
		t.Fatalf("prompt failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(work, ".claude")); err == nil {
		t.Error("with HOME unset, state was written relative to the working directory")
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
