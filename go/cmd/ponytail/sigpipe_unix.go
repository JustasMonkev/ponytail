//go:build unix

package main

import (
	"os/signal"
	"syscall"
)

// ignoreSIGPIPE keeps a closed stdout from killing the hook.
//
// Go's runtime raises SIGPIPE with the default (fatal) handler when a write to
// fd 1 or 2 hits EPIPE, so the best-effort `_, _ = w.Write(...)` in the hook
// output path does not silently fail — it terminates the process with status
// 141. The Node hooks exit 0 there, and a host reads a non-zero hook exit as a
// hook failure, on every subagent spawn. Ignoring the signal turns the write
// back into the ordinary error the callers already discard.
func ignoreSIGPIPE() {
	signal.Ignore(syscall.SIGPIPE)
}
