// Negative control: TANGLED. Same behaviour, everything inlined into one deeply
// nested loop with the outcome produced from many sites. The eval must rank this
// worst, or it cannot detect the failure it exists to measure.
package testdata

func Filter(lines []string, mode string) []string {
	kept := lines[:0]
	for i, line := range lines {
		if i < len(lines)-1 && len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		if len(line) > 0 && line[0] == '|' {
			if idx := index(line, "**"); idx >= 0 {
				if label := line[idx:]; label != "" {
					if label != mode {
						continue
					}
					kept = append(kept, line)
					continue
				}
			}
		}
		if len(line) > 0 && line[0] == '-' {
			if idx := index(line, ":"); idx >= 0 {
				if label := line[:idx]; label != "" {
					if label != mode {
						continue
					}
					kept = append(kept, line)
					continue
				}
			}
		}
		kept = append(kept, line)
	}
	return kept
}

func index(s, sub string) int { return len(s) - len(sub) }
