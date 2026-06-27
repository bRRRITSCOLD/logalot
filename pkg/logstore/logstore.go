package logstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/jackc/pgx/v5"
)

// ErrSearchNotImplemented marks the hot Search path as not yet wired. Search
// lands with the query API (#10); the write-path issue (#7) only needs Append.
var ErrSearchNotImplemented = errors.New("logstore: Search not implemented (tracked by #10)")

// beginner is the minimal transaction-opening seam the adapter depends on. It is
// satisfied by *pgxpool.Pool, and lets the unit tests substitute a fake tx to
// assert the exact SET LOCAL + INSERT sequence without a live database.
type beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Store is the Postgres-backed kernel.LogStore. It holds a pool that MUST connect
// as the NOSUPERUSER logalot_app role so RLS is enforced.
type Store struct {
	db  beginner
	now func() time.Time
}

// compile-time proof the adapter satisfies the kernel port.
var _ kernel.LogStore = (*Store)(nil)

// Option configures a Store.
type Option func(*Store)

// WithClock injects a clock used to default a zero event timestamp. Tests use it
// for determinism.
func WithClock(now func() time.Time) Option { return func(s *Store) { s.now = now } }

// New builds a Store over a transaction-capable handle (a *pgxpool.Pool in
// production). The handle MUST be the logalot_app role pool.
func New(db beginner, opts ...Option) *Store {
	s := &Store{db: db, now: time.Now}
	for _, o := range opts {
		o(s)
	}
	if s.now == nil {
		s.now = time.Now
	}
	return s
}

// Append persists events to the tenant's hot store inside a single RLS-armed
// transaction. It arms SET LOCAL app.tenant_id from tc, then runs ONE multi-row
// INSERT into the partitioned parent log_events (a single statement keeps the
// per-row GIN index maintenance batched, mitigating write amplification —
// ADR-0003). Every row's tenant_id is stamped from tc; any TenantID carried on a
// supplied event is ignored (ADR-0002), and the RLS WITH CHECK policy is the
// storage-layer backstop that rejects a foreign-tenant row.
//
// Empty input is a no-op. The arm + insert MUST share one transaction because
// SET LOCAL is transaction-scoped (kernel postgres.go).
func (s *Store) Append(tc kernel.TenantContext, ctx context.Context, events ...kernel.LogEvent) error {
	if err := tc.Valid(); err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}

	sql, args, err := buildInsert(tc.TenantID, s.now(), events)
	if err != nil {
		return err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("logstore: begin: %w", err)
	}
	err = kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
		_, eerr := tx.Exec(ctx, sql, args...)
		if eerr != nil {
			return fmt.Errorf("logstore: insert %d event(s): %w", len(events), eerr)
		}
		return nil
	})
	if err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

// Tail returns the most recent events for the tenant, newest-first — the seed for
// a live-tail subscription (#8). It is a tenant-scoped read armed by RLS, so a
// missing/invalid context yields zero rows (fail-closed). The backward PK scan
// (tenant_id, ts DESC, id DESC) serves the ordering without an extra index.
func (s *Store) Tail(tc kernel.TenantContext, ctx context.Context, q kernel.TailQuery) ([]kernel.LogEvent, error) {
	if err := tc.Valid(); err != nil {
		return nil, err
	}
	limit := q.Limit
	if limit <= 0 || limit > maxTailLimit {
		limit = defaultTailLimit
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("logstore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var events []kernel.LogEvent
	err = kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
		rows, qerr := tx.Query(ctx,
			`SELECT `+selectColumns+`
			   FROM log_events
			  ORDER BY ts DESC, id DESC
			  LIMIT $1`, limit)
		if qerr != nil {
			return qerr
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
		return nil, fmt.Errorf("logstore: tail: %w", err)
	}
	return events, tx.Commit(ctx)
}

// Search runs a tenant-scoped hot query. Not implemented in #7 — it lands with
// the query API (#10). It fails closed with a clear sentinel rather than
// returning a misleading empty page.
//
// TODO(#10): implement keyset-paginated FTS + structured + time-range search.
func (s *Store) Search(tc kernel.TenantContext, ctx context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	if err := tc.Valid(); err != nil {
		return kernel.SearchPage{}, err
	}
	return kernel.SearchPage{}, ErrSearchNotImplemented
}

const (
	defaultTailLimit = 200
	maxTailLimit     = 1000
)

// selectColumns is the read projection, ordered to match scanEvents (DRY).
const selectColumns = `tenant_id::text, ts, id::text, service, level::text, message, labels, trace_id, span_id, raw`

// insertColumns is the write projection. id is intentionally omitted so the
// table default gen_random_uuid() assigns it; search is a generated column.
const insertColumns = `tenant_id, ts, service, level, message, labels, trace_id, span_id, raw`

// buildInsert renders a single multi-row INSERT for events. tenantID and now are
// the authoritative tenant and the fallback timestamp — both applied per row so a
// caller can never smuggle a foreign tenant in via an event field, and a zero TS
// defaults to now (the normalizer also defaults TS, this is belt-and-suspenders).
//
// Pure and side-effect free so it is unit-testable without a database.
func buildInsert(tenantID kernel.TenantID, now time.Time, events []kernel.LogEvent) (string, []any, error) {
	const colsPerRow = 9
	var b strings.Builder
	b.WriteString(`INSERT INTO log_events (`)
	b.WriteString(insertColumns)
	b.WriteString(`) VALUES `)

	args := make([]any, 0, len(events)*colsPerRow)
	for i, ev := range events {
		if i > 0 {
			b.WriteString(", ")
		}
		base := i * colsPerRow
		// $tenant::uuid, $ts, $service, $level::log_level, $message,
		// $labels::jsonb, $trace, $span, $raw::jsonb
		b.WriteString("($")
		b.WriteString(strconv.Itoa(base + 1))
		b.WriteString("::uuid, $")
		b.WriteString(strconv.Itoa(base + 2))
		b.WriteString(", $")
		b.WriteString(strconv.Itoa(base + 3))
		b.WriteString(", $")
		b.WriteString(strconv.Itoa(base + 4))
		b.WriteString("::log_level, $")
		b.WriteString(strconv.Itoa(base + 5))
		b.WriteString(", $")
		b.WriteString(strconv.Itoa(base + 6))
		b.WriteString("::jsonb, $")
		b.WriteString(strconv.Itoa(base + 7))
		b.WriteString(", $")
		b.WriteString(strconv.Itoa(base + 8))
		b.WriteString(", $")
		b.WriteString(strconv.Itoa(base + 9))
		b.WriteString("::jsonb)")

		ts := ev.TS
		if ts.IsZero() {
			ts = now
		}
		level := ev.Level
		if level == "" {
			level = kernel.LevelInfo
		}
		labels, err := marshalLabels(ev.Labels)
		if err != nil {
			return "", nil, err
		}
		raw := ev.Raw
		if len(raw) == 0 {
			raw = json.RawMessage(`{}`)
		}
		args = append(args,
			string(tenantID), // authoritative tenant, NOT ev.TenantID
			ts.UTC(),
			ev.Service,
			string(level),
			ev.Message,
			labels,
			nullIfEmpty(ev.TraceID),
			nullIfEmpty(ev.SpanID),
			[]byte(raw),
		)
	}
	return b.String(), args, nil
}

// marshalLabels encodes labels as a jsonb object, always non-null ({} when nil).
func marshalLabels(labels map[string]string) ([]byte, error) {
	if labels == nil {
		return []byte(`{}`), nil
	}
	b, err := json.Marshal(labels)
	if err != nil {
		return nil, fmt.Errorf("logstore: marshal labels: %w", err)
	}
	return b, nil
}

// nullIfEmpty maps "" to a SQL NULL for the nullable trace_id/span_id columns.
func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// scanEvents reads a result set into LogEvents in the selectColumns order.
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
			return nil, err
		}
		ev.TenantID = kernel.TenantID(tenantID)
		ev.ID = id
		ev.Level = kernel.Level(level)
		if len(labels) > 0 {
			if err := json.Unmarshal(labels, &ev.Labels); err != nil {
				return nil, fmt.Errorf("logstore: unmarshal labels: %w", err)
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
	return out, nil
}

// execOf adapts a pgx.Tx to the kernel.ExecFunc the RLS-arming convention needs.
func execOf(tx pgx.Tx) kernel.ExecFunc {
	return func(ctx context.Context, sql string, args ...any) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}
}
