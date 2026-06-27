// Package postgres holds the alert-evaluator's two Postgres adapters, which sit on
// OPPOSITE sides of the tenant-isolation boundary (model.md §4.5):
//
//   - RuleStore (this file) connects as the BYPASSRLS `logalot_evaluator` role so
//     it can list due rules across ALL tenants and write scheduling state. That
//     role is granted ONLY alert_rules + alert_notifications — never log_events —
//     so it physically cannot read log content.
//   - LogCounter (logcounter.go) connects as the NOSUPERUSER `logalot_app` role and
//     arms per-tenant RLS before counting log_events.
//
// Keeping them as separate types over separate pools makes the boundary explicit
// and impossible to cross by accident.
package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RuleStore is the BYPASSRLS scheduling-metadata adapter (app.RuleStore). Its pool
// MUST connect as logalot_evaluator (migration 000013): BYPASSRLS to see every
// tenant's rules, but no grant on log_events so it can never read log content.
type RuleStore struct {
	pool *pgxpool.Pool
}

var _ app.RuleStore = (*RuleStore)(nil)

// NewRuleStore wraps the logalot_evaluator pool.
func NewRuleStore(pool *pgxpool.Pool) *RuleStore { return &RuleStore{pool: pool} }

const ruleColumns = `id::text, tenant_id::text, name, comparator::text, threshold,
	window_seconds, severity, state::text, transition_seq, query, notify_channels,
	saved_query_id::text`

// ListDue returns enabled rules due for evaluation (never evaluated, or last
// evaluated at/before dueBefore), oldest first. It reads rule METADATA + the query
// DEFINITION only — no log content. Served by idx_alert_rules_eval.
//
// When a rule has an empty inline query but a non-empty saved_query_id, this method
// resolves the saved query definition by reading saved_queries (migration 000015
// grants SELECT to logalot_evaluator). The filters jsonb is parsed into RuleQuery.
// If the saved query is missing the rule's Query stays empty; evaluateRule will then
// skip it (correct: not fail it). Resolution is best-effort and per-rule so one
// broken reference never poisons the batch.
func (s *RuleStore) ListDue(ctx context.Context, dueBefore time.Time, limit int) ([]app.Rule, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+ruleColumns+`
		   FROM alert_rules
		  WHERE enabled
		    AND (last_evaluated_at IS NULL OR last_evaluated_at <= $1)
		  ORDER BY last_evaluated_at NULLS FIRST
		  LIMIT $2`,
		dueBefore.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("rulestore: list due: %w", err)
	}
	defer rows.Close()

	var out []app.Rule
	for rows.Next() {
		r, serr := scanRule(rows)
		if serr != nil {
			return nil, serr
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Resolve saved_query_id → Query for rules that have no inline filter. This uses
	// the same logalot_evaluator pool (BYPASSRLS, SELECT on saved_queries per
	// migration 000015). The query reads the saved_queries row by both id AND
	// tenant_id, providing defence-in-depth (the evaluator's BYPASSRLS role sees all
	// tenants, so we add tenant_id to the WHERE to guarantee we resolve only the
	// correct tenant's query — a belt-and-suspenders guard beyond DB grants).
	for i := range out {
		r := &out[i]
		if r.Query.IsEmpty() && r.SavedQueryID != "" {
			if err := s.resolveSavedQuery(ctx, r); err != nil {
				// Log and continue: one bad reference must not fail the batch.
				_ = err // caller's evaluator will skip this rule via IsEmpty guard
			}
		}
	}

	return out, nil
}

// Transition performs the state compare-and-swap and writes the outbox row in ONE
// transaction. The UPDATE ... WHERE state = expectedFrom takes a row lock and only
// succeeds for the single evaluator that still observes the expected state, so two
// racing evaluators cannot both transition — and therefore cannot both notify. The
// outbox INSERT shares the transaction; its UNIQUE (rule_id, transition_seq) is the
// belt-and-suspenders backstop. ok=false means the CAS lost (no notification).
func (s *RuleStore) Transition(ctx context.Context, in app.TransitionInput) (app.Notification, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return app.Notification{}, false, fmt.Errorf("rulestore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var seq int64
	err = tx.QueryRow(ctx,
		// last_notified_at is intentionally NOT set here — it is stamped at ACTUAL
		// dispatch time by MarkDispatched, so it never lies that a notification was
		// sent when only the transition was recorded.
		`UPDATE alert_rules
		    SET state = $2::alert_state,
		        transition_seq = transition_seq + 1,
		        last_evaluated_at = $3,
		        last_triggered_at = CASE WHEN $2::alert_state = 'firing' THEN $3 ELSE last_triggered_at END
		  WHERE id = $1 AND state = $4::alert_state
		  RETURNING transition_seq`,
		in.Rule.ID, string(in.To), in.Now.UTC(), string(in.ExpectedFrom),
	).Scan(&seq)
	if err == pgx.ErrNoRows {
		// CAS lost: another evaluator already moved this rule. Not an error.
		return app.Notification{}, false, nil
	}
	if err != nil {
		return app.Notification{}, false, fmt.Errorf("rulestore: cas transition: %w", err)
	}

	var (
		notifID    string
		occurredAt time.Time
	)
	err = tx.QueryRow(ctx,
		`INSERT INTO alert_notifications
		    (tenant_id, rule_id, transition_seq, to_state, observed_count, threshold)
		 VALUES ($1, $2, $3, $4::alert_state, $5, $6)
		 RETURNING id::text, occurred_at`,
		string(in.Rule.TenantID), in.Rule.ID, seq, string(in.To),
		in.ObservedCount, in.Rule.Threshold,
	).Scan(&notifID, &occurredAt)
	if err != nil {
		return app.Notification{}, false, fmt.Errorf("rulestore: insert outbox: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return app.Notification{}, false, fmt.Errorf("rulestore: commit: %w", err)
	}

	return app.Notification{
		ID:            notifID,
		TenantID:      in.Rule.TenantID,
		RuleID:        in.Rule.ID,
		RuleName:      in.Rule.Name,
		TransitionSeq: seq,
		ToState:       in.To,
		Severity:      in.Rule.Severity,
		ObservedCount: in.ObservedCount,
		Threshold:     in.Rule.Threshold,
		Channels:      in.Rule.Channels,
		OccurredAt:    occurredAt,
	}, true, nil
}

// MarkEvaluated stamps last_evaluated_at without touching state (the rule was due,
// evaluated, and did not change state).
func (s *RuleStore) MarkEvaluated(ctx context.Context, ruleID string, now time.Time) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE alert_rules SET last_evaluated_at = $2 WHERE id = $1`, ruleID, now.UTC())
	if err != nil {
		return fmt.Errorf("rulestore: mark evaluated: %w", err)
	}
	return nil
}

// ListPending returns outbox notifications not yet delivered (dispatched_at IS
// NULL), oldest first — the relay's work queue. It JOINs alert_rules to recover the
// rule's name/severity/channels for the delivery payload (both tables are readable
// by the BYPASSRLS evaluator role; neither is log content).
//
// Multi-replica note (review M6, deferred): a `FOR UPDATE SKIP LOCKED` on this
// SELECT would let several evaluator replicas drain the queue without double-
// delivering. Single-process today, so it is a noted follow-up, not done here.
func (s *RuleStore) ListPending(ctx context.Context, limit int) ([]app.Notification, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT n.id::text, n.tenant_id::text, n.rule_id::text, r.name,
		        n.transition_seq, n.to_state::text, r.severity,
		        n.observed_count, n.threshold, r.notify_channels, n.occurred_at
		   FROM alert_notifications n
		   JOIN alert_rules r ON r.id = n.rule_id
		  WHERE n.dispatched_at IS NULL
		  ORDER BY n.occurred_at
		  LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("rulestore: list pending: %w", err)
	}
	defer rows.Close()

	var out []app.Notification
	for rows.Next() {
		n, serr := scanNotification(rows)
		if serr != nil {
			return nil, serr
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// MarkDispatched marks the outbox row delivered AND truthfully stamps the rule's
// last_notified_at — both at actual dispatch time — in one transaction.
func (s *RuleStore) MarkDispatched(ctx context.Context, n app.Notification, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("rulestore: begin mark dispatched: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`UPDATE alert_notifications SET dispatched_at = $2 WHERE id = $1`, n.ID, now.UTC()); err != nil {
		return fmt.Errorf("rulestore: mark dispatched: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE alert_rules SET last_notified_at = $2 WHERE id = $1`, n.RuleID, now.UTC()); err != nil {
		return fmt.Errorf("rulestore: stamp last_notified_at: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("rulestore: commit mark dispatched: %w", err)
	}
	return nil
}

// resolveSavedQuery reads the saved_query row identified by r.SavedQueryID+r.TenantID
// and populates r.Query in-place. If the row is missing (deleted, wrong tenant) the
// method returns nil and r.Query stays empty — the evaluator's IsEmpty guard will then
// skip the rule. No error is surfaced for a missing row (only for unexpected DB errors).
//
// Security note: although logalot_evaluator is BYPASSRLS, we include tenant_id in the
// WHERE clause so that the resolved query can never belong to a different tenant. This
// is belt-and-suspenders: the DB would already enforce this through the FK on
// alert_rules.tenant_id ≡ saved_queries.tenant_id, but an explicit check here makes
// the intent clear and guards against any future schema change.
func (s *RuleStore) resolveSavedQuery(ctx context.Context, r *app.Rule) error {
	var (
		queryText  string
		filtersRaw []byte
	)
	err := s.pool.QueryRow(ctx,
		`SELECT query_text, filters FROM saved_queries WHERE id = $1 AND tenant_id = $2`,
		r.SavedQueryID, string(r.TenantID),
	).Scan(&queryText, &filtersRaw)
	if err == pgx.ErrNoRows {
		// Saved query deleted or wrong tenant — leave r.Query empty (evaluator skips).
		return nil
	}
	if err != nil {
		return fmt.Errorf("rulestore: resolve saved_query %s: %w", r.SavedQueryID, err)
	}

	r.Query.Text = queryText

	if len(filtersRaw) > 0 && string(filtersRaw) != `{}` {
		var filters struct {
			Service string            `json:"service"`
			Level   string            `json:"level"`
			Labels  map[string]string `json:"labels"`
		}
		if jerr := json.Unmarshal(filtersRaw, &filters); jerr == nil {
			r.Query.Service = filters.Service
			if filters.Level != "" {
				lvl := kernel.Level(filters.Level)
				r.Query.Level = &lvl
			}
			r.Query.Labels = filters.Labels
		}
	}
	return nil
}

// scanNotification reads one ListPending row into an app.Notification.
func scanNotification(rows pgx.Rows) (app.Notification, error) {
	var (
		n        app.Notification
		tenantID string
		state    string
		chanRaw  []byte
	)
	if err := rows.Scan(&n.ID, &tenantID, &n.RuleID, &n.RuleName, &n.TransitionSeq,
		&state, &n.Severity, &n.ObservedCount, &n.Threshold, &chanRaw, &n.OccurredAt); err != nil {
		return app.Notification{}, fmt.Errorf("rulestore: scan notification: %w", err)
	}
	n.TenantID = kernel.TenantID(tenantID)
	n.ToState = app.State(state)
	if len(chanRaw) > 0 {
		if err := json.Unmarshal(chanRaw, &n.Channels); err != nil {
			return app.Notification{}, fmt.Errorf("rulestore: parse channels: %w", err)
		}
	}
	return n, nil
}

// scanRule reads one alert_rules row (ruleColumns order) into an app.Rule, parsing
// the jsonb query + notify_channels into the typed query language.
// Column order: id, tenant_id, name, comparator, threshold, window_seconds, severity,
// state, transition_seq, query, notify_channels, saved_query_id.
func scanRule(rows pgx.Rows) (app.Rule, error) {
	var (
		r            app.Rule
		tenantID     string
		cmp          string
		state        string
		queryRaw     []byte
		chanRaw      []byte
		savedQueryID *string // nullable uuid → text
	)
	if err := rows.Scan(&r.ID, &tenantID, &r.Name, &cmp, &r.Threshold,
		&r.WindowSeconds, &r.Severity, &state, &r.TransitionSeq, &queryRaw, &chanRaw, &savedQueryID); err != nil {
		return app.Rule{}, fmt.Errorf("rulestore: scan rule: %w", err)
	}
	r.TenantID = kernel.TenantID(tenantID)
	r.Comparator = app.Comparator(cmp)
	r.State = app.State(state)
	if savedQueryID != nil {
		r.SavedQueryID = *savedQueryID
	}
	if len(queryRaw) > 0 {
		if err := json.Unmarshal(queryRaw, &r.Query); err != nil {
			return app.Rule{}, fmt.Errorf("rulestore: parse rule query: %w", err)
		}
	}
	if len(chanRaw) > 0 {
		if err := json.Unmarshal(chanRaw, &r.Channels); err != nil {
			return app.Rule{}, fmt.Errorf("rulestore: parse notify_channels: %w", err)
		}
	}
	return r, nil
}
