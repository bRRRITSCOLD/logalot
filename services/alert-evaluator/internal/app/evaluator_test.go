package app

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const testTenant = "00000000-0000-0000-0000-00000000000a"

// ── In-memory fakes that faithfully model the load-bearing store semantics ────

// outboxRow mirrors an alert_notifications row: the notification + its delivery
// state (dispatched_at IS NULL until MarkDispatched).
type outboxRow struct {
	n          Notification
	dispatched bool
}

// fakeRuleStore models the BYPASSRLS scheduling metadata + the CAS transition +
// the append-only outbox + the relay's pending/dispatched bookkeeping, exactly as
// the Postgres adapter must. Transition is the compare-and-swap that guarantees
// exactly one outbox row per transition.
type fakeRuleStore struct {
	mu     sync.Mutex
	rules  map[string]*Rule
	outbox []*outboxRow
}

func newFakeRuleStore(rules ...Rule) *fakeRuleStore {
	s := &fakeRuleStore{rules: map[string]*Rule{}}
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
	s.outbox = append(s.outbox, &outboxRow{n: n})
	return n, true, nil
}

func (s *fakeRuleStore) MarkEvaluated(_ context.Context, _ string, _ time.Time) error { return nil }

func (s *fakeRuleStore) ListPending(_ context.Context, limit int) ([]Notification, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Notification
	for _, row := range s.outbox {
		if !row.dispatched {
			out = append(out, row.n)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (s *fakeRuleStore) MarkDispatched(_ context.Context, n Notification, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, row := range s.outbox {
		if row.n.ID == n.ID {
			row.dispatched = true
		}
	}
	return nil
}

func (s *fakeRuleStore) stateOf(id string) State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rules[id].State
}

func (s *fakeRuleStore) outboxCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.outbox)
}

func (s *fakeRuleStore) pendingCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := 0
	for _, row := range s.outbox {
		if !row.dispatched {
			c++
		}
	}
	return c
}

// fakeCounter returns a scripted count, advancing through the script on each call
// so a test can drive a rule through breach -> sustained breach -> clear.
type fakeCounter struct {
	mu     sync.Mutex
	script []int64
	i      int
}

func (c *fakeCounter) Count(_ context.Context, tc kernel.TenantContext, _ RuleQuery, _, _ time.Time) (int64, error) {
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

// fakeNotifier records successful deliveries and counts attempts. failUntil makes
// the first N Notify calls fail (to exercise the relay's retry path).
type fakeNotifier struct {
	mu        sync.Mutex
	sent      []Notification
	attempts  int
	failUntil int
}

func (n *fakeNotifier) Notify(_ context.Context, notif Notification) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.attempts++
	if n.attempts <= n.failUntil {
		return errors.New("notify: transient failure")
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

func (n *fakeNotifier) total() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.sent)
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
	lvl := kernel.LevelError
	return Rule{
		ID:            "11111111-1111-1111-1111-111111111111",
		TenantID:      kernel.TenantID(testTenant),
		Name:          "too many errors",
		Comparator:    ComparatorGt,
		Threshold:     5,
		WindowSeconds: 300,
		Severity:      "critical",
		State:         StateOK,
		Query:         RuleQuery{Level: &lvl}, // non-empty: the evaluator won't skip it
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
	if got := store.outboxCount(); got != 1 {
		t.Fatalf("outbox rows = %d, want exactly 1", got)
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

	if got := store.outboxCount(); got != 1 {
		t.Fatalf("outbox rows across 4 sustained-breach cycles = %d, want exactly 1", got)
	}
	if got := notifier.countTo(StateFiring); got != 1 {
		t.Fatalf("firing notifications = %d, want exactly 1 (no spam)", got)
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

	if got := store.outboxCount(); got != 2 {
		t.Fatalf("outbox rows = %d, want 2 (1 firing + 1 resolved)", got)
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

// ── I1: transactional-outbox relay — no drop on failure, no duplicate on success ─

func TestEvaluateDue_NotifyFailsThenSucceeds_RelayRedeliversWithoutDrop(t *testing.T) {
	store := newFakeRuleStore(sampleRule())
	// Breach both cycles; the first Notify FAILS, the second succeeds.
	counter := &fakeCounter{script: []int64{9, 9}}
	notifier := &fakeNotifier{failUntil: 1}
	ev := New(store, counter, notifier, WithInterval(time.Second))

	// Cycle 1: transition writes the outbox row; the relay's Notify fails, so the
	// row stays pending (no drop) and nothing was delivered.
	if _, err := ev.EvaluateDue(context.Background()); err != nil {
		t.Fatalf("cycle 1: %v", err)
	}
	if got := store.outboxCount(); got != 1 {
		t.Fatalf("outbox rows after cycle 1 = %d, want 1", got)
	}
	if got := store.pendingCount(); got != 1 {
		t.Fatalf("pending rows after failed delivery = %d, want 1 (no drop)", got)
	}
	if got := notifier.total(); got != 0 {
		t.Fatalf("successful deliveries after cycle 1 = %d, want 0", got)
	}

	// Cycle 2: still firing (no new transition, no new outbox row), and the relay
	// redelivers the pending row and marks it dispatched.
	if _, err := ev.EvaluateDue(context.Background()); err != nil {
		t.Fatalf("cycle 2: %v", err)
	}
	if got := store.outboxCount(); got != 1 {
		t.Fatalf("outbox rows after cycle 2 = %d, want still 1 (no new transition)", got)
	}
	if got := store.pendingCount(); got != 0 {
		t.Fatalf("pending rows after redelivery = %d, want 0 (delivered + marked)", got)
	}
	if got := notifier.countTo(StateFiring); got != 1 {
		t.Fatalf("firing deliveries = %d, want exactly 1 (no drop, no duplicate)", got)
	}
}

func TestEvaluateDue_HappyPath_RelayDeliversOnceNoRedelivery(t *testing.T) {
	store := newFakeRuleStore(sampleRule())
	counter := &fakeCounter{script: []int64{9, 9, 9}}
	notifier := &fakeNotifier{}
	ev := New(store, counter, notifier, WithInterval(time.Second))

	// Three cycles, all breaching. One transition, one delivery, then the relay
	// finds nothing pending — so it never re-delivers a dispatched row.
	for i := 0; i < 3; i++ {
		if _, err := ev.EvaluateDue(context.Background()); err != nil {
			t.Fatalf("cycle %d: %v", i, err)
		}
	}
	if got := notifier.total(); got != 1 {
		t.Fatalf("total deliveries across 3 cycles = %d, want exactly 1 (no duplicate)", got)
	}
	if got := store.pendingCount(); got != 0 {
		t.Fatalf("pending rows = %d, want 0", got)
	}
}

// ── M1: the CAS guarantee — concurrent evaluators write exactly one outbox row ──

func TestEvaluateDue_ConcurrentEvaluators_ExactlyOneOutboxRowPerTransition(t *testing.T) {
	store := newFakeRuleStore(sampleRule())
	const n = 8
	evs := make([]*Evaluator, n)
	for i := range evs {
		evs[i] = New(store, &fakeCounter{script: []int64{9}}, &fakeNotifier{}, WithInterval(time.Second))
	}

	var wg sync.WaitGroup
	wg.Add(n)
	for _, ev := range evs {
		ev := ev
		go func() { defer wg.Done(); _, _ = ev.EvaluateDue(context.Background()) }()
	}
	wg.Wait()

	if got := store.outboxCount(); got != 1 {
		t.Fatalf("outbox rows from %d racing evaluators = %d, want exactly 1 (CAS serialized)", n, got)
	}
}

// ── I2: empty-query rules are skipped (never spuriously fire) ──────────────────

func TestEvaluateRule_EmptyInlineQuery_SkippedNeverFires(t *testing.T) {
	r := sampleRule()
	r.Query = RuleQuery{} // empty: would otherwise count ALL events and fire
	store := newFakeRuleStore(r)
	counter := &fakeCounter{script: []int64{9999}} // huge count — must be ignored
	notifier := &fakeNotifier{}
	ev := New(store, counter, notifier)

	if _, err := ev.EvaluateDue(context.Background()); err != nil {
		t.Fatalf("EvaluateDue: %v", err)
	}
	if got := store.stateOf(r.ID); got != StateOK {
		t.Fatalf("empty-query rule state = %q, want ok (skipped, never evaluated)", got)
	}
	if got := store.outboxCount(); got != 0 {
		t.Fatalf("outbox rows for empty-query rule = %d, want 0 (no spurious fire)", got)
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
	if got := store.outboxCount(); got != 0 {
		t.Fatalf("outbox rows for blank-tenant rule = %d, want 0 (fail closed)", got)
	}
}
