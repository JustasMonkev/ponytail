//go:build !unix

package main

// Only Unix turns a write to a closed stdout into a fatal signal.
func ignoreSIGPIPE() {}
