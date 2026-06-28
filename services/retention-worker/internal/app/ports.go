// Package app is the retention-worker application core. It is pure domain
// logic with no AWS SDK or Postgres types — those live in adapters.
package app

import (
	"context"
	"time"
)

// RetentionPolicy is the per-tenant retention configuration read from
// the retention_policies table.
type RetentionPolicy struct {
	TenantID string // UUID
	HotDays  int
	ColdDays int
}

// PolicyStore loads retention policies for all tenants. The adapter runs as
// the logalot_retention BYPASSRLS role so it sees every tenant's row.
type PolicyStore interface {
	// ListAll returns all retention policies across all tenants. The order is
	// unspecified; callers must not rely on it.
	ListAll(ctx context.Context) ([]RetentionPolicy, error)
}

// HotDropper executes the hot-tier partition drop.
// Implementation: calls SELECT app.drop_log_events_partitions_older_than($1).
type HotDropper interface {
	// DropOlderThan drops log_events_YYYYMMDD partitions strictly older than
	// retentionDays from today. Returns the number of partitions dropped.
	DropOlderThan(ctx context.Context, retentionDays int) (int, error)
}

// ColdPurger deletes expired cold-tier S3 objects for a single tenant.
// The implementation uses ListObjectsV2 + DeleteObjects so the prefix is
// always `logs/tenant_id=<tenantID>/` — the structural cold isolation boundary.
type ColdPurger interface {
	// PurgeExpiredPrefixes deletes all S3 objects under the tenant's cold
	// prefix whose dt partition is strictly before cutoffDate. Returns the
	// number of objects deleted.
	PurgeExpiredPrefixes(ctx context.Context, tenantID string, cutoffDate time.Time) (int, error)
}
