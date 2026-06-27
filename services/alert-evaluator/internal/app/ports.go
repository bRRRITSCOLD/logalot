// Package app is the alert-evaluator application core (hexagonal centre). It owns
// the Alerting context's evaluation half (ADR-0001): on a schedule, find rules
// that are due, run each rule's query over its rolling window, compare the match
// count against the rule's threshold, transition the rule's state, and dispatch
// exactly one notification per transition.
//
// Tenant isolation is load-bearing and split across TWO ports on purpose
// (model.md §4.5):
//
//   - RuleStore is the SCHEDULING-metadata port. Its adapter connects as the
//     BYPASSRLS logalot_evaluator role so it can list due rules across ALL
//     tenants — but that role is granted NOTHING on log_events, so it can never
//     read log content.
//   - LogCounter is the LOG-CONTENT port. Its adapter connects as the NOSUPERUSER
//     logalot_app role and arms `SET LOCAL app.tenant_id` from the rule's
//     TenantContext before counting, so every log read is RLS-governed.
//
// The core depends only on these ports plus Notifier, so Postgres / floci SNS are
// swappable adapters around it.
package app

import (
	"context"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// State is an alert rule's lifecycle state. The values mirror the Postgres
// `alert_state` enum (migration 000002) exactly.
type State string

const (
	// StateOK means the rule's query is below threshold (not alerting). A
	// firing->ok transition is the "resolved" event.
	StateOK State = "ok"
	// StateFiring means the rule's query crossed its threshold within the window.
	StateFiring State = "firing"
	// StateNoData is reserved in the enum for "the query returned nothing to
	// evaluate"; v1 does not derive it automatically (YAGNI).
	StateNoData State = "no_data"
)

// Comparator mirrors the Postgres `alert_comparator` enum (migration 000002):
// how the observed count is compared against the threshold.
type Comparator string

const (
	ComparatorGt  Comparator = "gt"
	ComparatorGte Comparator = "gte"
	ComparatorLt  Comparator = "lt"
	ComparatorLte Comparator = "lte"
	ComparatorEq  Comparator = "eq"
)

// RuleQuery is the structured query a rule evaluates against the hot store over
// its rolling window. It is the SAME flat filter language the hot LogStore uses
// (model.md §5) — full-text + service/level equality + label containment — minus
// any time range, which the evaluator derives from the rule's window. Parsed from
// the rule's inline `query` jsonb (or a referenced saved query) by the adapter.
type RuleQuery struct {
	Text    string            `json:"text,omitempty"`
	Service string            `json:"service,omitempty"`
	Level   *kernel.Level     `json:"level,omitempty"`
	Labels  map[string]string `json:"labels,omitempty"`
}

// Rule is the scheduling + evaluation projection of an alert_rules row. It carries
// rule METADATA and the query DEFINITION only — never any log content (the count
// is computed separately, under tenant RLS, via LogCounter).
type Rule struct {
	ID            string
	TenantID      kernel.TenantID
	Name          string
	Comparator    Comparator
	Threshold     float64
	WindowSeconds int
	Severity      string
	State         State
	TransitionSeq int64
	Query         RuleQuery
	Channels      []Channel
}

// Window returns the rule's evaluation window duration.
func (r Rule) Window() time.Duration { return time.Duration(r.WindowSeconds) * time.Second }

// Channel is one notification target on a rule (alert_rules.notify_channels). v1
// supports webhook + email-stub; the Notifier adapter decides how each is routed
// (e.g. floci SNS fan-out).
type Channel struct {
	Type string `json:"type"`          // "webhook" | "email"
	URL  string `json:"url,omitempty"` // webhook target
	To   string `json:"to,omitempty"`  // email recipient
}

// Notification is the immutable record of one state transition, ready to dispatch.
// It is produced by RuleStore.Transition (and persisted to the alert_notifications
// outbox in the same transaction) so its identity is the proof that the transition
// happened exactly once.
type Notification struct {
	ID            string
	TenantID      kernel.TenantID
	RuleID        string
	RuleName      string
	TransitionSeq int64
	ToState       State
	Severity      string
	ObservedCount int64
	Threshold     float64
	Channels      []Channel
	OccurredAt    time.Time
}

// Resolved reports whether this notification is a clear (firing -> ok). The
// payload renders "resolved" vs "firing" from this.
func (n Notification) Resolved() bool { return n.ToState == StateOK }

// TransitionInput is the compare-and-swap request to move a rule's state. The
// store applies it ONLY when the rule's current state still equals ExpectedFrom
// (optimistic concurrency), bumps transition_seq, and writes the outbox row in one
// transaction.
type TransitionInput struct {
	Rule          Rule
	ExpectedFrom  State
	To            State
	ObservedCount int64
	Now           time.Time
}

// ── Driven ports (the core depends on these; adapters implement them) ─────────

// LogCounter counts a rule's matching events in the half-open window [from, to)
// UNDER THE TENANT'S RLS CONTEXT. The adapter MUST arm `SET LOCAL app.tenant_id`
// from tc (the NOSUPERUSER logalot_app role) before the count, so a missing
// context yields zero (fail-closed) and one tenant can never count another's logs.
type LogCounter interface {
	Count(tc kernel.TenantContext, ctx context.Context, q RuleQuery, from, to time.Time) (int64, error)
}

// RuleStore is the scheduling-metadata port, backed by the BYPASSRLS
// logalot_evaluator role. It NEVER touches log content.
type RuleStore interface {
	// ListDue returns enabled rules whose last evaluation is at or before
	// dueBefore (NULL = never evaluated), oldest first, capped at limit.
	ListDue(ctx context.Context, dueBefore time.Time, limit int) ([]Rule, error)
	// Transition atomically moves a rule's state when its current state still
	// equals in.ExpectedFrom: it bumps transition_seq, stamps timing, and inserts
	// the outbox notification row — all in ONE transaction. It returns the
	// recorded Notification and ok=true on success, or ok=false when the CAS lost
	// (another evaluator already moved the rule) so no duplicate notification is
	// emitted.
	Transition(ctx context.Context, in TransitionInput) (Notification, bool, error)
	// MarkEvaluated stamps last_evaluated_at without changing state (the rule was
	// due, evaluated, and did not transition).
	MarkEvaluated(ctx context.Context, ruleID string, now time.Time) error
	// MarkDispatched stamps the outbox row's dispatched_at after a successful send.
	MarkDispatched(ctx context.Context, notificationID string, now time.Time) error
}

// Notifier dispatches a notification to its channels. Implementations: a log-sink
// (default / test double) and a floci SNS/SQS adapter. Behind this port so the
// evaluator core never knows about AWS.
type Notifier interface {
	Notify(ctx context.Context, n Notification) error
}
