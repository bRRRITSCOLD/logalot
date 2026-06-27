package app

// state.go is the pure alert state-machine: it maps an observed match count and a
// rule's comparator/threshold to the target state, with no I/O. Keeping it pure
// makes the firing/resolved boundary exhaustively unit-testable (no DB, no clock).

// Decide returns the state a rule SHOULD be in given the observed match count over
// its window. A count that satisfies the comparator-vs-threshold predicate is a
// breach => StateFiring; otherwise StateOK. The ok<->firing edges are exactly the
// transitions the evaluator notifies on (firing on breach, "resolved" on clear).
func Decide(count int64, cmp Comparator, threshold float64) State {
	if crosses(float64(count), cmp, threshold) {
		return StateFiring
	}
	return StateOK
}

// crosses evaluates the threshold predicate. An unknown comparator fails closed to
// false (no spurious firing).
func crosses(v float64, cmp Comparator, threshold float64) bool {
	switch cmp {
	case ComparatorGt:
		return v > threshold
	case ComparatorGte:
		return v >= threshold
	case ComparatorLt:
		return v < threshold
	case ComparatorLte:
		return v <= threshold
	case ComparatorEq:
		return v == threshold
	default:
		return false
	}
}
