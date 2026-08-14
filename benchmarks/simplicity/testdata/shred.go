// Negative control: OVER-DECOMPOSED. Same behaviour as the good version, shredded
// into trivial one-line wrappers to drive peak-per-function complexity toward zero.
// The complexity metrics alone would rate this best; the guards must veto it.
package testdata

func isPipe(line string) bool   { return len(line) > 0 && line[0] == '|' }
func isDash(line string) bool   { return len(line) > 0 && line[0] == '-' }
func isEmpty(line string) bool  { return line == "" }
func notEmpty(line string) bool { return !isEmpty(line) }
func pickTable(line string) string {
	if isPipe(line) {
		return tableOf(line)
	}
	return ""
}
func pickExample(line string) string {
	if isDash(line) {
		return exampleOf(line)
	}
	return ""
}
func tableOf(line string) string   { return lookup(line) }
func exampleOf(line string) string { return lookup(line) }
func lookup(line string) string    { return line[:0] }
func labelOf(line string) string {
	if l := pickTable(line); l != "" {
		return l
	}
	return pickExample(line)
}
func keep(line, mode string) bool {
	l := labelOf(line)
	return l == "" || l == mode
}
func Filter(lines []string, mode string) []string {
	kept := lines[:0]
	for _, line := range lines {
		if keep(line, mode) {
			kept = append(kept, line)
		}
	}
	return kept
}
