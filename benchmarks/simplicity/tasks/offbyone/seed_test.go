package task

import "testing"

func TestWindow(t *testing.T) {
	xs := []int{1, 2, 3, 4, 5}
	if got := Window(xs, 2); len(got) != 2 || got[0] != 4 || got[1] != 5 {
		t.Errorf("Window(xs,2) = %v, want [4 5]", got)
	}
	if got := Window(xs, 5); len(got) != 5 {
		t.Errorf("Window(xs,5) = %v, want all", got)
	}
	if got := Window(xs, 9); len(got) != 5 {
		t.Errorf("Window(xs,9) = %v, want all", got)
	}
	if got := Window(xs, 0); got != nil {
		t.Errorf("Window(xs,0) = %v, want nil", got)
	}
}
