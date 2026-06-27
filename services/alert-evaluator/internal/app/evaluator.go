package app

import (
	"context"
	"io"
	"log/slog"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// Defaults for the evaluation loop. The cadence is well under the 30s NFR target
// (acceptance criterion 3) so a breach is observed and notified within one cycle.
const (
	DefaultInterval  = 10 * time.Second
	DefaultBatchSize = 200
)

// Evaluator is the alert-evaluator application service. It depends only on the
// three ports (RuleStore scheduling-metadata, LogCounter RLS-scoped log reads,
// Notifier dispatch); the tenant-isolation boundary lives in those adapters.
type Evaluator struct {
	rules    RuleStore
	counter  LogCounter
	notifier Notifier

	interval  time.Duration
	batchSize int
	now       func() time.Time
	log       *slog.Logger
}

// Option configures an Evaluator.
type Option func(*Evaluator)

// WithClock injects a clock (deterministic windows in tests).
func WithClock(now func() time.Time) Option { return func(e *Evaluator) { e.now = now } }

// WithLogger sets the structured logger (defaults to discard).
func WithLogger(l *slog.Logger) Option { return func(e *Evaluator) { e.log = l } }

// WithInterval sets the evaluation cadence (also the due-cutoff). Must stay below
// the 30s eval-latency NFR.
func WithInterval(d time.Duration) Option { return func(e *Evaluator) { e.interval = d } }

// WithBatchSize caps how many due rules one cycle drains.
func WithBatchSize(n int) Option { return func(e *Evaluator) { e.batchSize = n } }

// New builds an Evaluator over its ports.
func New(rules RuleStore, counter LogCounter, notifier Notifier, opts ...Option) *Evaluator {
	e := &Evaluator{
		rules:     rules,
		counter:   counter,
		notifier:  notifier,
		interval:  DefaultInterval,
		batchSize: DefaultBatchSize,
		now:       time.Now,
		log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, o := range opts {
		o(e)
	}
	if e.now == nil {
		e.now = time.Now
	}
	if e.log == nil {
		e.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if e.interval <= 0 {
		e.interval = DefaultInterval
	}
	if e.batchSize <= 0 {
		e.batchSize = DefaultBatchSize
	}
	return e
}

// Run drives the evaluation loop on the configured cadence until ctx is cancelled.
// It evaluates once immediately, then on every tick. A cycle error is logged and
// the loop continues (a transient DB blip must not kill the evaluator).
func (e *Evaluator) Run(ctx context.Context) error {
	ticker := time.NewTicker(e.interval)
	defer ticker.Stop()
	for {
		if _, err := e.EvaluateDue(ctx); err != nil {
			e.log.ErrorContext(ctx, "alert-evaluator: cycle failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// EvaluateDue runs ONE evaluation cycle: evaluate every due rule (which may write
// outbox notification rows on a state change), then run the relay to DELIVER any
// pending outbox rows. It returns the number of rules evaluated. Per-rule failures
// are logged and do not abort the batch (one bad tenant must not stall the rest).
//
// Dispatch is the relay's job ONLY (the single dispatch path): evaluateRule never
// notifies, so there is no inline-vs-relay double-send, and a delivery failure
// simply leaves the row pending for the next cycle's relay (at-least-once).
func (e *Evaluator) EvaluateDue(ctx context.Context) (int, error) {
	now := e.now()
	due, err := e.rules.ListDue(ctx, now.Add(-e.interval), e.batchSize)
	if err != nil {
		return 0, err
	}
	for _, r := range due {
		if err := e.evaluateRule(ctx, r); err != nil {
			e.log.ErrorContext(ctx, "alert-evaluator: rule evaluation failed",
				"rule_id", r.ID, "tenant_id", r.TenantID, "err", err)
		}
	}
	// Relay: deliver this cycle's new transitions AND retry anything left pending
	// from a prior cycle (a crash or a transient Notify failure).
	e.dispatchPending(ctx)
	return len(due), nil
}

// dispatchPending is the transactional-outbox relay — the SINGLE place a
// notification is delivered. It reads undelivered outbox rows and, for each,
// Notify -> MarkDispatched. A Notify failure leaves dispatched_at NULL so the next
// cycle retries (no drop); MarkDispatched after a successful send stops redelivery
// (no duplicate on the happy path). The UNIQUE (rule_id, transition_seq) outbox key
// makes the rare crash-after-send-before-mark redelivery idempotent for a deduping
// consumer.
func (e *Evaluator) dispatchPending(ctx context.Context) {
	pending, err := e.rules.ListPending(ctx, e.batchSize)
	if err != nil {
		e.log.ErrorContext(ctx, "alert-evaluator: list pending notifications failed", "err", err)
		return
	}
	for _, n := range pending {
		if err := e.notifier.Notify(ctx, n); err != nil {
			// Stays pending; retried next cycle. No drop.
			e.log.WarnContext(ctx, "alert-evaluator: notify failed (outbox row stays pending for retry)",
				"rule_id", n.RuleID, "notification_id", n.ID, "err", err)
			continue
		}
		if err := e.rules.MarkDispatched(ctx, n, e.now()); err != nil {
			// Delivered but not marked: a future cycle may redeliver (idempotent via
			// the unique key). Logged so the rare case is observable.
			e.log.WarnContext(ctx, "alert-evaluator: mark dispatched failed (may redeliver)",
				"rule_id", n.RuleID, "notification_id", n.ID, "err", err)
		}
	}
}

// evaluateRule is the per-rule pipeline: count under tenant RLS, decide the target
// state, and — only on a state CHANGE — write the outbox row (the relay delivers
// it). It does NOT notify; delivery is the relay's single responsibility.
//
// THE TENANT BOUNDARY: the count runs through LogCounter under a TenantContext
// built from the rule's own tenant_id, so the log read is RLS-governed by
// logalot_app. The rule metadata came from RuleStore (BYPASSRLS) which cannot read
// log content at all. The two never cross.
func (e *Evaluator) evaluateRule(ctx context.Context, r Rule) error {
	now := e.now()

	// Refuse to evaluate a rule with no effective query: an empty query would count
	// EVERY event in the window and spuriously fire. The RuleStore adapter resolves
	// saved_query_id into Query before returning; if the query is still empty after
	// that (saved query deleted, invisible, or rule has neither source), skip the
	// rule rather than fail it — it will stay pending evaluation and the operator can
	// fix it. The control-plane rejects empty-query rules at create/update; this is
	// the evaluator-side backstop.
	if r.Query.IsEmpty() {
		e.log.WarnContext(ctx, "alert-evaluator: skipping rule with empty effective query (no inline query and no resolvable saved query)",
			"rule_id", r.ID, "tenant_id", r.TenantID, "saved_query_id", r.SavedQueryID)
		return e.rules.MarkEvaluated(ctx, r.ID, now)
	}

	to := now.UTC()
	from := to.Add(-r.Window())

	// Tenant context for the RLS-scoped log count. Only the tenant id matters at the
	// storage layer; it is the rule's authoritative tenant_id, never input. A
	// per-tenant log read is NOT a platform-operator action, so no role is set.
	tc := kernel.TenantContext{TenantID: r.TenantID}

	count, err := e.counter.Count(ctx, tc, r.Query, from, to)
	if err != nil {
		return err
	}

	target := Decide(count, r.Comparator, r.Threshold)

	// No state change: record the evaluation timestamp and stop. A rule that stays
	// `firing` across many cycles therefore never re-notifies (no duplicate spam).
	if target == r.State {
		return e.rules.MarkEvaluated(ctx, r.ID, now)
	}

	// State change. The CAS transition + outbox insert is one transaction; it
	// succeeds for exactly ONE evaluator per transition (ok=false => another won).
	// The relay (dispatchPending) delivers the resulting outbox row.
	n, ok, err := e.rules.Transition(ctx, TransitionInput{
		Rule:          r,
		ExpectedFrom:  r.State,
		To:            target,
		ObservedCount: count,
		Now:           now,
	})
	if err != nil {
		return err
	}
	if !ok {
		// Lost the race; the winner wrote the single outbox row. Idempotent.
		return nil
	}

	e.log.InfoContext(ctx, "alert-evaluator: state transition",
		"rule_id", r.ID, "tenant_id", r.TenantID, "from", r.State, "to", target,
		"count", count, "threshold", r.Threshold, "transition_seq", n.TransitionSeq)
	return nil
}
