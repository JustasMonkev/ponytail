package jsonorder

import (
	"strings"
	"testing"
)

func roundTrip(t *testing.T, input string) string {
	t.Helper()
	parsed, err := Unmarshal([]byte(input))
	if err != nil {
		t.Fatalf("Unmarshal(%q): %v", input, err)
	}
	out, err := Marshal(parsed)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(out)
}

// The whole reason this package exists: editing one key must not reshuffle a
// user's settings.json the way a map round-trip would.
func TestRoundTripPreservesKeyOrder(t *testing.T) {
	input := `{"zeta":1,"alpha":2,"model":"opus","beta":3}`
	got := roundTrip(t, input)
	want := "{\n  \"zeta\": 1,\n  \"alpha\": 2,\n  \"model\": \"opus\",\n  \"beta\": 3\n}"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestRoundTripMatchesJSONStringifyShape(t *testing.T) {
	cases := map[string]string{
		`{}`:                     `{}`,
		`[]`:                     `[]`,
		`{"a":{}}`:               "{\n  \"a\": {}\n}",
		`{"a":[]}`:               "{\n  \"a\": []\n}",
		`{"a":[1,2]}`:            "{\n  \"a\": [\n    1,\n    2\n  ]\n}",
		`{"a":{"b":{"c":true}}}`: "{\n  \"a\": {\n    \"b\": {\n      \"c\": true\n    }\n  }\n}",
		`{"a":null}`:             "{\n  \"a\": null\n}",
	}
	for input, want := range cases {
		if got := roundTrip(t, input); got != want {
			t.Errorf("%s\ngot:\n%s\nwant:\n%s", input, got, want)
		}
	}
}

// Numbers keep their source text: a re-encode must not turn 1.50 into 1.5 or
// a large integer into scientific notation.
func TestNumbersKeepTheirLiteralForm(t *testing.T) {
	input := `{"a":1.50,"b":10000000000000000001,"c":1e3,"d":-0.0}`
	got := roundTrip(t, input)
	for _, literal := range []string{"1.50", "10000000000000000001", "1e3", "-0.0"} {
		if !strings.Contains(got, literal) {
			t.Errorf("number %q was rewritten:\n%s", literal, got)
		}
	}
}

func TestStringsAreNotHTMLEscaped(t *testing.T) {
	got := roundTrip(t, `{"command":"a && b <c> 'd'"}`)
	if !strings.Contains(got, `"a && b <c> 'd'"`) {
		t.Errorf("HTML must not be escaped:\n%s", got)
	}
}

func TestUnmarshalRejectsMalformedInput(t *testing.T) {
	bad := []string{
		`{ "statusLine": { "command": "x", broken`,
		``,
		`{"a":1} trailing`,
		`{"a":}`,
	}
	for _, input := range bad {
		if _, err := Unmarshal([]byte(input)); err == nil {
			t.Errorf("Unmarshal(%q) must fail", input)
		}
	}
}

func TestObjectGetSetDelete(t *testing.T) {
	parsed, err := Unmarshal([]byte(`{"a":1,"b":2,"c":3}`))
	if err != nil {
		t.Fatal(err)
	}
	obj := parsed.(*Object)

	if _, ok := obj.Get("missing"); ok {
		t.Error("Get on a missing key must report false")
	}

	// Set replaces in place, keeping position.
	obj.Set("b", "replaced")
	out, err := Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "\"a\": 1,\n  \"b\": \"replaced\",\n  \"c\": 3") {
		t.Errorf("Set must replace in place:\n%s", out)
	}

	// A new key appends at the end.
	obj.Set("d", true)
	obj.Delete("a")
	obj.Delete("missing") // must be a no-op
	out, _ = Marshal(obj)
	want := "{\n  \"b\": \"replaced\",\n  \"c\": 3,\n  \"d\": true\n}"
	if string(out) != want {
		t.Errorf("got:\n%s\nwant:\n%s", out, want)
	}
}

func TestDuplicateKeysKeepBothEntries(t *testing.T) {
	// ponytail: duplicate keys are pathological JSON; the contract here is only
	// that parsing does not lose data or panic.
	parsed, err := Unmarshal([]byte(`{"a":1,"a":2}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := len(parsed.(*Object).Members); got != 2 {
		t.Errorf("expected both members retained, got %d", got)
	}
}
