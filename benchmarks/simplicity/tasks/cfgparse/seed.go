package task

import (
	"fmt"
	"strconv"
	"strings"
)

type Setting struct {
	Name  string
	Kind  string
	Value any
}

// Parse turns "name:kind=raw" lines into settings.
func Parse(lines []string) ([]Setting, error) {
	var out []Setting
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		head, raw, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("missing = in %q", line)
		}
		name, kind, ok := strings.Cut(head, ":")
		if !ok {
			return nil, fmt.Errorf("missing : in %q", line)
		}
		if kind == "int" {
			n, err := strconv.Atoi(strings.TrimSpace(raw))
			if err != nil {
				return nil, fmt.Errorf("setting %s: %w", name, err)
			}
			out = append(out, Setting{Name: name, Kind: kind, Value: n})
		} else if kind == "bool" {
			b, err := strconv.ParseBool(strings.TrimSpace(raw))
			if err != nil {
				return nil, fmt.Errorf("setting %s: %w", name, err)
			}
			out = append(out, Setting{Name: name, Kind: kind, Value: b})
		} else {
			return nil, fmt.Errorf("setting %s: unknown kind %q", name, kind)
		}
	}
	return out, nil
}
