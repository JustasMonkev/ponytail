package task

// Window returns the last n items of xs, or all of them when there are fewer.
func Window(xs []int, n int) []int {
	if n <= 0 {
		return nil
	}
	if len(xs) <= n {
		return xs
	}
	return xs[len(xs)-n-1:]
}
