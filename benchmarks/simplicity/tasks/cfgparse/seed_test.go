package task

import "testing"

func TestParse(t *testing.T) {
	got, err := Parse([]string{"a:int=3", "", "b:bool=true", "c:float=1.5", "d:duration=90"})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("got %d settings, want 4", len(got))
	}
	if got[0].Value != 3 || got[1].Value != true {
		t.Errorf("existing kinds broke: %v", got[:2])
	}
	if got[2].Value != 1.5 {
		t.Errorf("float: got %v, want 1.5", got[2].Value)
	}
	if got[3].Value != 90 {
		t.Errorf("duration: got %v, want 90 (seconds as int)", got[3].Value)
	}
	if _, err := Parse([]string{"x:float=nope"}); err == nil {
		t.Error("bad float must error")
	}
	if _, err := Parse([]string{"x:duration=nope"}); err == nil {
		t.Error("bad duration must error")
	}
	if _, err := Parse([]string{"x:wat=1"}); err == nil {
		t.Error("unknown kind must still error")
	}
}
