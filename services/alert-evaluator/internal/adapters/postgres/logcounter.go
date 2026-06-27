package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LogCounter is the RLS-governed log-content adapter (app.LogCounter). Its pool
// MUST connect as the NOSUPERUSER logalot_app role (migration 000011) so FORCE ROW
// LEVEL SECURITY actually bites: it arms `SET LOCAL app.tenant_id` from the rule's
// TenantContext before the COUNT, so a missing context yields zero (fail-closed)
// and one tenant can never count another tenant's logs.
//
// This is the mirror of pkg/logstore's read path, narrowed to a COUNT(*) over the
// rule's window. It is a SEPARATE adapter (own pool, own role) from RuleStore by
// design — the BYPASSRLS scheduler and the RLS-scoped reader never share a handle.
type LogCounter struct {
	pool *pgxpool.Pool
}

var _ app.LogCounter = (*LogCounter)(nil)

// NewLogCounter wraps the logalot_app (RLS) pool.
func NewLogCounter(pool *pgxpool.Pool) *LogCounter { return &LogCounter{pool: pool} }

// Count returns the number of the tenant's log_events matching q in the half-open
// window [from, to). It runs inside ONE RLS-armed transaction (SET LOCAL
// app.tenant_id from tc, then the COUNT on the same tx). The tenant predicate is
// ALSO bound from tc into the WHERE for defense-in-depth + partition pruning — but
// RLS is the backstop: even without the predicate, an unarmed/foreign context
// returns zero.
func (c *LogCounter) Count(ctx context.Context, tc kernel.TenantContext, q app.RuleQuery, from, to time.Time) (int64, error) {
	if err := tc.Valid(); err != nil {
		return 0, err
	}

	sql, args, err := buildCount(tc.TenantID, q, from, to)
	if err != nil {
		return 0, err
	}

	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("logcounter: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var count int64
	err = kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
		return tx.QueryRow(ctx, sql, args...).Scan(&count)
	})
	if err != nil {
		return 0, fmt.Errorf("logcounter: count: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("logcounter: commit: %w", err)
	}
	return count, nil
}

// buildCount renders the tenant-scoped COUNT(*) and its bound args. Pure and
// side-effect free so the filter->SQL mapping is unit-testable without a database.
// $1 is always the tenant predicate (bound from tc, never from q); every other
// clause is appended only when set, each value a fresh placeholder (no injection
// surface). The window is the rule's [from, to).
func buildCount(tenantID kernel.TenantID, q app.RuleQuery, from, to time.Time) (string, []any, error) {
	var b strings.Builder
	args := make([]any, 0, 8)

	args = append(args, string(tenantID))
	b.WriteString("SELECT count(*) FROM log_events WHERE tenant_id = $1::uuid")

	ph := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}

	b.WriteString(" AND ts >= ")
	b.WriteString(ph(from.UTC()))
	b.WriteString(" AND ts < ")
	b.WriteString(ph(to.UTC()))

	if text := strings.TrimSpace(q.Text); text != "" {
		b.WriteString(" AND search @@ websearch_to_tsquery('english', ")
		b.WriteString(ph(text))
		b.WriteString(")")
	}
	if len(q.Labels) > 0 {
		labels, err := json.Marshal(q.Labels)
		if err != nil {
			return "", nil, fmt.Errorf("logcounter: marshal labels: %w", err)
		}
		b.WriteString(" AND labels @> ")
		b.WriteString(ph(labels))
		b.WriteString("::jsonb")
	}
	if svc := strings.TrimSpace(q.Service); svc != "" {
		b.WriteString(" AND service = ")
		b.WriteString(ph(svc))
	}
	if q.Level != nil {
		b.WriteString(" AND level = ")
		b.WriteString(ph(string(*q.Level)))
		b.WriteString("::log_level")
	}
	return b.String(), args, nil
}

// execOf adapts a pgx.Tx to the kernel.ExecFunc the RLS-arming convention needs.
func execOf(tx pgx.Tx) kernel.ExecFunc {
	return func(ctx context.Context, sql string, args ...any) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}
}
