// Package postgres provides query-service postgres adapters. This file holds the
// PanelStore adapter that drives panel-data: saved_query resolution + log
// aggregation (count, time-series, recent events), all under tenant RLS.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PanelStore implements app.PanelStore using the NOSUPERUSER logalot_app pool.
// Every query runs inside a transaction with SET LOCAL app.tenant_id armed via
// kernel.WithTenantScope, so RLS is enforced on every access.
// saved_queries is covered by migration 000011's blanket DML grant.
// log_events is covered by the same grant; the partition parent is queried.
type PanelStore struct {
	pool *pgxpool.Pool
}

var _ app.PanelStore = (*PanelStore)(nil)

// NewPanelStore wraps the logalot_app pool.
func NewPanelStore(pool *pgxpool.Pool) *PanelStore { return &PanelStore{pool: pool} }

// Resolve reads the saved_query definition for savedQueryID within the tenant.
// Returns nil, nil when the row is not found or is invisible under RLS.
func (s *PanelStore) Resolve(ctx context.Context, tc kernel.TenantContext, savedQueryID string) (*app.SavedQueryDef, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("panelstore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var def *app.SavedQueryDef
	err = kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
		row := tx.QueryRow(ctx,
			`SELECT query_text, filters FROM saved_queries WHERE id = $1`,
			savedQueryID)
		var (
			queryText  string
			filtersRaw []byte
		)
		if scanErr := row.Scan(&queryText, &filtersRaw); scanErr != nil {
			// pgx uses pgx.ErrNoRows; treat as "not found" (invisible under RLS or
			// missing). Using errors.Is correctly handles wrapped sentinel values
			// and avoids false-positive matches on unrelated errors that contain
			// the substring "no rows" (e.g. "invalid input syntax for type uuid").
			if errors.Is(scanErr, pgx.ErrNoRows) {
				return nil
			}
			return fmt.Errorf("panelstore: scan saved_query: %w", scanErr)
		}
		d := &app.SavedQueryDef{QueryText: queryText}
		if len(filtersRaw) > 0 && string(filtersRaw) != `{}` {
			var filters struct {
				Service string            `json:"service"`
				Level   string            `json:"level"`
				Labels  map[string]string `json:"labels"`
			}
			if jerr := json.Unmarshal(filtersRaw, &filters); jerr == nil {
				d.Service = filters.Service
				if filters.Level != "" {
					lvl := kernel.Level(filters.Level)
					d.Level = &lvl
				}
				d.Labels = filters.Labels
			}
		}
		def = d
		return nil
	})
	if err != nil {
		return nil, err
	}
	_ = tx.Commit(ctx)
	return def, nil
}

// Count returns the total event count in [from, to) matching the filter.
func (s *PanelStore) Count(ctx context.Context, tc kernel.TenantContext, def app.SavedQueryDef, from, to time.Time) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("panelstore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var total int64
	err = kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
		sql, args := buildCountQuery(tc.TenantID, def, from, to)
		return tx.QueryRow(ctx, sql, args...).Scan(&total)
	})
	if err != nil {
		return 0, fmt.Errorf("panelstore: count: %w", err)
	}
	_ = tx.Commit(ctx)
	return total, nil
}

// TimeSeries returns nBuckets time-bucketed event counts over [from, to).
// The bucket granularity is derived from the range / nBuckets. Buckets with
// zero events are omitted (sparse/gap representation) — the response contains
// only buckets where at least one event matched the filter. Callers (UI panels)
// MUST gap-fill missing buckets with a zero count when rendering a continuous
// time-series chart. This is intentional: returning dense buckets for a wide
// time range with many empty slots wastes bandwidth and query time.
func (s *PanelStore) TimeSeries(ctx context.Context, tc kernel.TenantContext, def app.SavedQueryDef, from, to time.Time, nBuckets int) ([]app.Bucket, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("panelstore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	bucketSeconds := bucketSize(from, to, nBuckets)

	var buckets []app.Bucket
	err = kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
		sql, args := buildTimeSeriesQuery(tc.TenantID, def, from, to, bucketSeconds)
		rows, qerr := tx.Query(ctx, sql, args...)
		if qerr != nil {
			return fmt.Errorf("panelstore: timeseries query: %w", qerr)
		}
		defer rows.Close()
		for rows.Next() {
			var b app.Bucket
			if serr := rows.Scan(&b.BucketStart, &b.Count); serr != nil {
				return fmt.Errorf("panelstore: scan bucket: %w", serr)
			}
			buckets = append(buckets, b)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	_ = tx.Commit(ctx)
	if buckets == nil {
		buckets = []app.Bucket{}
	}
	return buckets, nil
}

// RecentLogs returns the most recent matching events, newest-first.
func (s *PanelStore) RecentLogs(ctx context.Context, tc kernel.TenantContext, def app.SavedQueryDef, from, to time.Time, limit int) ([]kernel.LogEvent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("panelstore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var events []kernel.LogEvent
	err = kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
		sql, args := buildRecentQuery(tc.TenantID, def, from, to, limit)
		rows, qerr := tx.Query(ctx, sql, args...)
		if qerr != nil {
			return fmt.Errorf("panelstore: recent query: %w", qerr)
		}
		defer rows.Close()
		loaded, serr := scanEvents(rows)
		if serr != nil {
			return serr
		}
		events = loaded
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	if events == nil {
		events = []kernel.LogEvent{}
	}
	return events, tx.Commit(ctx)
}

// ── query builders ─────────────────────────────────────────────────────────────

func buildCountQuery(tenantID kernel.TenantID, def app.SavedQueryDef, from, to time.Time) (string, []any) {
	var b strings.Builder
	args := []any{string(tenantID)}
	b.WriteString(`SELECT COUNT(*) FROM log_events WHERE tenant_id = $1::uuid`)
	appendTimeRange(&b, &args, from, to)
	appendFilters(&b, &args, def)
	return b.String(), args
}

func buildTimeSeriesQuery(tenantID kernel.TenantID, def app.SavedQueryDef, from, to time.Time, bucketSecs int64) (string, []any) {
	var b strings.Builder
	args := []any{string(tenantID)}
	b.WriteString(`
SELECT
  to_timestamp(floor(EXTRACT(EPOCH FROM ts - $2) / $3) * $3 + EXTRACT(EPOCH FROM $2)) AS bucket_start,
  COUNT(*) AS count
FROM log_events
WHERE tenant_id = $1::uuid`)
	args = append(args, from.UTC())
	args = append(args, float64(bucketSecs))
	appendTimeRange(&b, &args, from, to)
	appendFilters(&b, &args, def)
	b.WriteString(` GROUP BY 1 ORDER BY 1`)
	return b.String(), args
}

func buildRecentQuery(tenantID kernel.TenantID, def app.SavedQueryDef, from, to time.Time, limit int) (string, []any) {
	var b strings.Builder
	args := []any{string(tenantID)}
	b.WriteString(`SELECT ` + selectCols + ` FROM log_events WHERE tenant_id = $1::uuid`)
	appendTimeRange(&b, &args, from, to)
	appendFilters(&b, &args, def)
	b.WriteString(` ORDER BY ts DESC, id DESC`)
	args = append(args, limit)
	b.WriteString(` LIMIT $` + strconv.Itoa(len(args)))
	return b.String(), args
}

func appendTimeRange(b *strings.Builder, args *[]any, from, to time.Time) {
	ph := func(v any) string {
		*args = append(*args, v)
		return "$" + strconv.Itoa(len(*args))
	}
	if !from.IsZero() {
		b.WriteString(" AND ts >= ")
		b.WriteString(ph(from.UTC()))
	}
	if !to.IsZero() {
		b.WriteString(" AND ts < ")
		b.WriteString(ph(to.UTC()))
	}
}

func appendFilters(b *strings.Builder, args *[]any, def app.SavedQueryDef) {
	ph := func(v any) string {
		*args = append(*args, v)
		return "$" + strconv.Itoa(len(*args))
	}
	if text := strings.TrimSpace(def.QueryText); text != "" {
		b.WriteString(" AND search @@ websearch_to_tsquery('english', ")
		b.WriteString(ph(text))
		b.WriteString(")")
	}
	if svc := strings.TrimSpace(def.Service); svc != "" {
		b.WriteString(" AND service = ")
		b.WriteString(ph(svc))
	}
	if def.Level != nil {
		b.WriteString(" AND level = ")
		b.WriteString(ph(string(*def.Level)))
		b.WriteString("::log_level")
	}
	if len(def.Labels) > 0 {
		lb, err := json.Marshal(def.Labels)
		if err == nil {
			b.WriteString(" AND labels @> ")
			b.WriteString(ph(lb))
			b.WriteString("::jsonb")
		}
	}
}

// bucketSize returns the duration in seconds of each bucket given the range and
// desired bucket count. Minimum 1 second; avoids division by zero.
func bucketSize(from, to time.Time, n int) int64 {
	if n <= 0 {
		n = app.DefaultPanelBuckets
	}
	dur := to.Sub(from)
	if dur <= 0 {
		return 60
	}
	secs := int64(math.Ceil(dur.Seconds() / float64(n)))
	if secs < 1 {
		return 1
	}
	return secs
}

// selectCols mirrors logstore's selectColumns for scanEvents.
const selectCols = `tenant_id::text, ts, id::text, service, level::text, message, labels, trace_id, span_id, raw`

// scanEvents reads one page of log event rows into LogEvent values.
func scanEvents(rows pgx.Rows) ([]kernel.LogEvent, error) {
	var out []kernel.LogEvent
	for rows.Next() {
		var (
			ev       kernel.LogEvent
			tenantID string
			id       string
			level    string
			labels   []byte
			traceID  *string
			spanID   *string
			raw      []byte
		)
		if err := rows.Scan(&tenantID, &ev.TS, &id, &ev.Service, &level, &ev.Message, &labels, &traceID, &spanID, &raw); err != nil {
			return nil, fmt.Errorf("panelstore: scan event: %w", err)
		}
		ev.TenantID = kernel.TenantID(tenantID)
		ev.ID = id
		ev.Level = kernel.Level(level)
		if len(labels) > 0 {
			if err := json.Unmarshal(labels, &ev.Labels); err != nil {
				return nil, fmt.Errorf("panelstore: unmarshal labels: %w", err)
			}
		}
		if traceID != nil {
			ev.TraceID = *traceID
		}
		if spanID != nil {
			ev.SpanID = *spanID
		}
		if len(raw) > 0 {
			ev.Raw = json.RawMessage(raw)
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

// execOf adapts pgx.Tx to the kernel.ExecFunc RLS-arming convention.
func execOf(tx pgx.Tx) kernel.ExecFunc {
	return func(ctx context.Context, sql string, args ...any) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}
}
