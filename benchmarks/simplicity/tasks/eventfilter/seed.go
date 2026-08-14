package task

// Event is one line of an ingest stream.
type Event struct {
	Kind   string
	Level  string
	Source string
	Body   string
}

// Keep reports whether an event survives the ingest filters.
func Keep(e Event, minLevel string, blockedSources []string) bool {
	if e.Kind == "metric" {
		if e.Level == "debug" && minLevel != "debug" {
			return false
		}
		for _, s := range blockedSources {
			if s == e.Source {
				return false
			}
		}
		return true
	}
	if e.Kind == "log" {
		if e.Level == "debug" && minLevel != "debug" {
			return false
		}
		for _, s := range blockedSources {
			if s == e.Source {
				return false
			}
		}
		if e.Body == "" {
			return false
		}
		return true
	}
	return false
}
