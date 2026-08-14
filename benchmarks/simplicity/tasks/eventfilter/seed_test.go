package task

import "testing"

func TestKeep(t *testing.T) {
	blocked := []string{"noisy"}
	cases := []struct {
		name string
		e    Event
		want bool
	}{
		{"metric passes", Event{"metric", "info", "api", ""}, true},
		{"log passes", Event{"log", "info", "api", "hi"}, true},
		{"log needs body", Event{"log", "info", "api", ""}, false},
		{"debug dropped", Event{"log", "debug", "api", "hi"}, false},
		{"blocked source", Event{"metric", "info", "noisy", ""}, false},
		{"unknown kind", Event{"trace", "info", "api", "hi"}, false},
		// New requirement: traces behave like logs but additionally require a source.
		{"trace passes", Event{"trace", "info", "api", "hi"}, true},
		{"trace needs body", Event{"trace", "info", "api", ""}, false},
		{"trace needs source", Event{"trace", "info", "", "hi"}, false},
		{"trace debug dropped", Event{"trace", "debug", "api", "hi"}, false},
		{"trace blocked source", Event{"trace", "info", "noisy", "hi"}, false},
	}
	for _, c := range cases {
		if got := Keep(c.e, "info", blocked); got != c.want {
			t.Errorf("%s: Keep = %v, want %v", c.name, got, c.want)
		}
	}
}
