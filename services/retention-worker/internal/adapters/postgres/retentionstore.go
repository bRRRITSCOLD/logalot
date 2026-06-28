// Package postgres holds the retention-worker's two Postgres adapters:
//
//   - PolicyStore: reads retention_policies across all tenants via the
//     BYPASSRLS logalot_retention role (migration 000016). Never touches
//     log_events or any tenant content.
//   - HotDropper: calls app.drop_log_events_partitions_older_than (now
//     SECURITY DEFINER in migration 000016) through the same pool.
package postgres

import (
	"context"
	"fmt"

	"github.com/bRRRITSCOLD/logalot/services/retention-worker/internal/app"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RetentionStore satisfies both app.PolicyStore and app.HotDropper. It
// connects as logalot_retention (BYPASSRLS, migration 000016).
//
// A single pool is used for both reads (retention_policies) and the DDL
// function call — they are sequential within a cycle and share no
// transaction, so pooling is safe and simple.
type RetentionStore struct {
	pool *pgxpool.Pool
}

// compile-time interface checks.
var _ app.PolicyStore = (*RetentionStore)(nil)
var _ app.HotDropper = (*RetentionStore)(nil)

// New builds a RetentionStore over pool. pool MUST connect as the
// logalot_retention role (BYPASSRLS — see migration 000016).
func New(pool *pgxpool.Pool) *RetentionStore {
	return &RetentionStore{pool: pool}
}

// ListAll reads every row from retention_policies. Runs as BYPASSRLS so it
// sees all tenants without arming a per-tenant RLS context.
func (s *RetentionStore) ListAll(ctx context.Context) ([]app.RetentionPolicy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT tenant_id::text, hot_days, cold_days
		FROM   retention_policies
		ORDER  BY tenant_id
	`)
	if err != nil {
		return nil, fmt.Errorf("retentionstore: list policies: %w", err)
	}
	defer rows.Close()

	var out []app.RetentionPolicy
	for rows.Next() {
		var p app.RetentionPolicy
		if err := rows.Scan(&p.TenantID, &p.HotDays, &p.ColdDays); err != nil {
			return nil, fmt.Errorf("retentionstore: scan policy: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DropOlderThan calls app.drop_log_events_partitions_older_than(retentionDays)
// which is SECURITY DEFINER (migration 000016) so it can DROP the partition
// tables despite the retention worker's NOSUPERUSER attribute.
// Returns the number of partitions dropped.
func (s *RetentionStore) DropOlderThan(ctx context.Context, retentionDays int) (int, error) {
	var dropped int
	err := s.pool.QueryRow(ctx,
		`SELECT app.drop_log_events_partitions_older_than($1)`,
		retentionDays,
	).Scan(&dropped)
	if err != nil {
		return 0, fmt.Errorf("retentionstore: hot partition drop: %w", err)
	}
	return dropped, nil
}
