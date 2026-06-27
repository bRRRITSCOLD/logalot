package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const testTenant = "00000000-0000-0000-0000-00000000000a"

// ── In-memory fakes that faithfully model the load-bearing store semantics ────

// fakeRuleStore models the BYPASSRLS scheduling metadata + the CAS transition +
// the append-only outbox, exactly as the Postgres adapter must. Transition is the
// compare-and-swap that guarantees exactly-once-per-transition.
type fakeRuleStore struct {
	mu      sync.Mutex
	rules   map[string]*Rule
	outbox  []Notification
	seqByID map[string]int64
}

func newFakeRuleStore(rules ...Rule) *fakeRuleStore {
	s := &fakeRuleStore{rules: map[string]*Rule{}, seqByID: map[string]int64{}}
	for i := range rules {
		r := rules[i]
		s.rules[r.ID] = &r
	}
	return s
}

func (s *fakeRuleStore) ListDue(_ context.Context, _ time.Time, limit int) ([]Rule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Rule
	for _, r := range s.rules {
		out = append(out, *r)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (s *fakeRuleStore) Transition(_ context.Context, in TransitionInput) (Notification, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rules[in.Rule.ID]
	if !ok {
		return Notification{}, false, nil
	}
	// Compare-and-swap: only the evaluator that still sees ExpectedFrom wins.
	if r.State != in.ExpectedFrom {
		return Notification{}, false, nil
	}
	r.State = in.To
	r.TransitionSeq++
	n := Notification{
		ID:            in.Rule.ID + "-" + itoa(r.TransitionSeq),
		TenantID:      r.TenantID,
		RuleID:        r.ID,
		RuleName:      r.Name,
		TransitionSeq: r.TransitionSeq,
		ToState:       in.To,
		Severity:      r.Severity,
		ObservedCount: in.ObservedCount,
		Threshold:     r.Threshold,
		Channels:      r.Channels,
		OccurredAt:    in.Now,
	}
	s.outbox = append(s.outbox, n)
	return n, true, nil
}

func (s *fakeRuleStore) MarkEvaluated(_ context.Context, _ string, _ time.Time) error { return nil }

func (s *fakeRuleStore) MarkDispatched(_ context.Context, id string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.outbox {
		if s.outbox[i].ID == id {
			s.outbox[i].OccurredAt = s.outbox[i].OccurredAt // no-op; dispatched tracked by notifier
		}
	}
	return nil
}

func (s *fakeRuleStore) stateOf(id string) State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rules[id].State
}

// fakeCounter returns a scripted count, advancing through the script on each call
// so a test can drive a rule through breach -> sustained breach -> clear.
type fakeCounter struct {
	mu     sync.Mutex
	script []int64
	i      int
}

func (c *fakeCounter) Count(tc kernel.TenantContext, _ context.Context, _ RuleQuery, _, _ time.Time) (int64, error) {
	// Guard: the counter MUST be armed with a valid tenant — proves the evaluator
	// builds the RLS context from the rule's tenant, not an empty one.
	if err := tc.Valid(); err != nil {
		return 0, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	v := c.script[len(c.script)-1]
	if c.i < len(c.script) {
		v = c.script[c.i]
		c.i++
	}
	return v, nil
}

// fakeNotifier records every dispatched notification (the test double).
type fakeNotifier struct {
	mu   sync.Mutex
	sent []Notification
	err  error
}

func (n *fakeNotifier) Notify(_ context.Context, notif Notification) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.err != nil {
		return n.err
	}
	n.sent = append(n.sent, notif)
	return nil
}

func (n *fakeNotifier) countTo(state State) int {
	n.mu.Lock()
	defer n.mu.Unlock()
	c := 0
	for _, s := range n.sent {
		if s.ToState == state {
			c++
		}
	}
	return c
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func sampleRule() Rule {
	return Rule{
		ID:            "11111111-1111-1111-1111-111111111111",
		TenantID:      kernel.TenantID(testTenant),
		Name:          "too many errors",
		Comparator:    ComparatorGt,
		Threshold:     5,
		WindowSeconds: 300,
		Severity:      "critical",
		State:         StateOK,
		Channels:      []Channel{{Type: "webhook", URL: "https://hooks.example/x"}},
	}
}

// ── Acceptance criterion 1 ────────────────────────────────────────────────────

func TestEvaluateDue_CountCrossesThreshold_FiresExactlyOnce(t *testing.T) {
	store := newFakeRuleStore(sampleRule())
	counter := &fakeCounter{script: []int64{9}} // 9 > 5 => breach
	notifier := &fakeNotifier{}
	ev := New(store, counter, notifier, WithInterval(time.Second))

	if _, err := ev.EvaluateDue(context.Background()); err != nil {
		t.Fatalf("EvaluateDue: %v", err)
	}

	if got := store.stateOf(sampleRule().ID); got != StateFiring {
		t.Fatalf("rule state = %q, want firing", got)
	}
	if got := notifier.countTo(StateFiring); got != 1 {
		t.Fatalf("firing notifications = %d, want exactly 1", got)
	}
}

func TestEvaluateDue_SustainedBreach_NoDuplicateNotifications(t *testing.T) {
	store := newFakeRuleStore(sampleRule())
	// Breach on every cycle; the rule stays firing.
	counter := &fakeCounter{script: []int64{9, 12, 7, 8}}
	notifier := &fakeNotifier{}
	ev := New(store, counter, notifier, WithInterval(time.Second))

	for i := 0; i < 4; i++ {
		if _, err := ev.EvaluateDue(context.Background()); err != nil {
			t.Fatalf("cycle %d: %v", i, err)
		}
	}

	if got := notifier.countTo(StateFiring); got != 1 {
		t.Fatalf("firing notifications across 4 sustained-breach cycles = %d, want exactly 1 (no spam)", got)
	}
	if got := store.stateOf(sampleRule().ID); got != StateFiring {
		t.Fatalf("rule state = %q, want firing", got)
	}
}

func TestEvaluateDue_BreachThenClear_ResolvesExactlyOnce(t *testing.T) {
	store := newFakeRuleStore(sampleRule())
	// breach, breach, clear, clear.
	counter := &fakeCounter{script: []int64{9, 10, 0, 1}}
	notifier := &fakeNotifier{}
	ev := New(store, counter, notifier, WithInterval(time.Second))

	for i := 0; i < 4; i++ {
		if _, err := ev.EvaluateDue(context.Background()); err != nil {
			t.Fatalf("cycle %d: %v", i, err)
		}
	}

	if got := notifier.countTo(StateFiring); got != 1 {
		t.Fatalf("firing notifications = %d, want exactly 1", got)
	}
	if got := notifier.countTo(StateOK); got != 1 {
		t.Fatalf("resolved notifications = %d, want exactly 1", got)
	}
	if got := store.stateOf(sampleRule().ID); got != StateOK {
		t.Fatalf("final rule state = %q, want ok (resolved)", got)
	}
}

// ── Idempotency under concurrency: two evaluators, one transition, one notice ──

func TestEvaluateDue_ConcurrentEvaluators_SingleNotificationPerTransition(t *testing.T) {
	store := newFakeRuleStore(sampleRule())
	counterA := &fakeCounter{script: []int64{9}}
	counterB := &fakeCounter{script: []int64{9}}
	notifier := &fakeNotifier{}
	evA := New(store, counterA, notifier, WithInterval(time.Second))
	evB := New(store, counterB, notifier, WithInterval(time.Second))

	var wg sync.WaitGroup
	wg.Add(2)
	for _, ev := range []*Evaluator{evA, evB} {
		ev := ev
		go func() { defer wg.Done(); _, _ = ev.EvaluateDue(context.Background()) }()
	}
	wg.Wait()

	if got := notifier.countTo(StateFiring); got != 1 {
		t.Fatalf("firing notifications from 2 racing evaluators = %d, want exactly 1 (CAS serialized)", got)
	}
}

func TestEvaluateRule_CountIsArmedWithRuleTenantContext(t *testing.T) {
	// A rule with a BLANK tenant must make the counter fail closed — proving the
	// evaluator passes the rule's tenant into the RLS-scoped count, not nothing.
	r := sampleRule()
	r.TenantID = ""
	store := newFakeRuleStore(r)
	counter := &fakeCounter{script: []int64{9}}
	notifier := &fakeNotifier{}
	ev := New(store, counter, notifier)

	if _, err := ev.EvaluateDue(context.Background()); err != nil {
		t.Fatalf("EvaluateDue should not surface per-rule errors: %v", err)
	}
	// Fail-closed: no transition, no notification (the count errored on bad tenant).
	if got := notifier.countTo(StateFiring); got != 0 {
		t.Fatalf("notifications for blank-tenant rule = %d, want 0 (fail closed)", got)
	}
}
