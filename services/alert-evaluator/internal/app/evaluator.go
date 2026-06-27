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

// EvaluateDue runs ONE evaluation cycle: list the rules due as of now-interval and
// evaluate each. It returns the number of rules evaluated. Per-rule failures are
// logged and do not abort the batch (one bad tenant must not stall the rest).
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
	return len(due), nil
}

// evaluateRule is the per-rule pipeline: count under tenant RLS, decide the target
// state, and — only on a state CHANGE — transition + dispatch exactly once.
//
// THE TENANT BOUNDARY: the count runs through LogCounter under a TenantContext
// built from the rule's own tenant_id, so the log read is RLS-governed by
// logalot_app. The rule metadata came from RuleStore (BYPASSRLS) which cannot read
// log content at all. The two never cross.
func (e *Evaluator) evaluateRule(ctx context.Context, r Rule) error {
	now := e.now()
	to := now.UTC()
	from := to.Add(-r.Window())

	// Tenant context for the RLS-scoped log count. Only the tenant id matters at
	// the storage layer; it is the rule's authoritative tenant_id, never input.
	tc := kernel.TenantContext{TenantID: r.TenantID, Role: kernel.RolePlatformOperator}

	count, err := e.counter.Count(tc, ctx, r.Query, from, to)
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
		// Lost the race; the winner emitted the single notification. Idempotent.
		return nil
	}

	e.log.InfoContext(ctx, "alert-evaluator: state transition",
		"rule_id", r.ID, "tenant_id", r.TenantID, "from", r.State, "to", target,
		"count", count, "threshold", r.Threshold, "transition_seq", n.TransitionSeq)

	// Dispatch the single notification for this transition. The outbox row already
	// exists, so a delivery failure is recoverable by a future redispatch sweep
	// (idempotent via the UNIQUE (rule_id, transition_seq) ledger key).
	if err := e.notifier.Notify(ctx, n); err != nil {
		e.log.WarnContext(ctx, "alert-evaluator: notify failed (outbox row persisted, pending redispatch)",
			"rule_id", r.ID, "notification_id", n.ID, "err", err)
		return err
	}
	return e.rules.MarkDispatched(ctx, n.ID, now)
}
