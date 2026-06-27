package app

import "testing"

func TestDecide_CountCrossesGtThreshold_Firing(t *testing.T) {
	if got := Decide(6, ComparatorGt, 5); got != StateFiring {
		t.Fatalf("Decide(6, gt, 5) = %q, want firing", got)
	}
}

func TestDecide_CountBelowGtThreshold_OK(t *testing.T) {
	if got := Decide(5, ComparatorGt, 5); got != StateOK {
		t.Fatalf("Decide(5, gt, 5) = %q, want ok (gt is strict)", got)
	}
}

func TestDecide_AllComparators_Expected(t *testing.T) {
	cases := []struct {
		name      string
		count     int64
		cmp       Comparator
		threshold float64
		want      State
	}{
		{"gt above", 11, ComparatorGt, 10, StateFiring},
		{"gt equal", 10, ComparatorGt, 10, StateOK},
		{"gte equal", 10, ComparatorGte, 10, StateFiring},
		{"gte below", 9, ComparatorGte, 10, StateOK},
		{"lt below", 2, ComparatorLt, 3, StateFiring},
		{"lt equal", 3, ComparatorLt, 3, StateOK},
		{"lte equal", 3, ComparatorLte, 3, StateFiring},
		{"lte above", 4, ComparatorLte, 3, StateOK},
		{"eq match", 7, ComparatorEq, 7, StateFiring},
		{"eq miss", 8, ComparatorEq, 7, StateOK},
		{"unknown comparator fails closed", 1000, Comparator("bogus"), 0, StateOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Decide(tc.count, tc.cmp, tc.threshold); got != tc.want {
				t.Fatalf("Decide(%d, %q, %v) = %q, want %q", tc.count, tc.cmp, tc.threshold, got, tc.want)
			}
		})
	}
}

func TestNotification_Resolved_TrueOnlyForOKTarget(t *testing.T) {
	if !(Notification{ToState: StateOK}).Resolved() {
		t.Fatal("firing->ok notification should report Resolved()=true")
	}
	if (Notification{ToState: StateFiring}).Resolved() {
		t.Fatal("ok->firing notification should report Resolved()=false")
	}
}
