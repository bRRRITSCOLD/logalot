package logstore

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/jackc/pgx/v5"
)

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

// Search runs a tenant-scoped, keyset-paginated hot query inside one RLS-armed
// transaction (SET LOCAL app.tenant_id from tc, then the SELECT on the same tx).
// It supports, in any combination: full-text on the generated `search` tsvector
// via websearch_to_tsquery, structured `labels @> $` containment, a [from,to)
// time range on ts (BRIN/partition friendly), and level/service equality. Results
// are ordered (ts DESC, id DESC) — the PK's backward scan — and paginated with an
// opaque keyset cursor instead of OFFSET, so deep pages cost the same as shallow.
//
// Tenant isolation is layered (model.md §4.4): the builder binds tenant_id from
// tc into the WHERE (application layer) AND RLS is armed (storage backstop), so a
// search for tenant A can never return tenant B's rows. The tenant is taken ONLY
// from tc — SearchQuery has no tenant field a caller could spoof (ADR-0002). All
// values, including the FTS text, are bound parameters; websearch_to_tsquery parses
// arbitrary user input without ever raising a syntax error, so a malformed query
// degrades to fewer matches rather than a 500 (no injection, no error surface).
func (s *Store) Search(tc kernel.TenantContext, ctx context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	if err := tc.Valid(); err != nil {
		return kernel.SearchPage{}, err
	}
	limit := q.Limit
	if limit <= 0 || limit > maxSearchLimit {
		limit = defaultSearchLimit
	}

	// Fetch one extra row: its presence is exactly the signal that another page
	// exists, and the last kept row becomes the next cursor (see paginate).
	sql, args, err := buildSearch(tc.TenantID, q, limit+1)
	if err != nil {
		return kernel.SearchPage{}, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return kernel.SearchPage{}, fmt.Errorf("logstore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var events []kernel.LogEvent
	err = kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
		rows, qerr := tx.Query(ctx, sql, args...)
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
		return kernel.SearchPage{}, fmt.Errorf("logstore: search: %w", err)
	}

	page, next := paginate(events, limit)
	return kernel.SearchPage{Events: page, NextCursor: next}, tx.Commit(ctx)
}

const (
	defaultTailLimit = 200
	maxTailLimit     = 1000

	// Search page bounds. These are a defensive backstop independent of the
	// edge's own validation (app.MaxSearchLimit): the store always clamps, so an
	// over-large or unset limit can never translate into an unbounded scan.
	defaultSearchLimit = 50
	maxSearchLimit     = 1000
)

// buildSearch renders the tenant-scoped keyset SELECT and its bound args.
// fetchLimit is the LIMIT to request (callers pass desiredLimit+1 so paginate can
// detect a following page). Pure and side-effect free so the filter→SQL+args
// mapping is unit-testable without a database.
//
// $1 is always the tenant predicate, bound from tc — never from the query — which
// (a) is the application-layer half of the layered tenant isolation and (b) lets
// the planner use the (tenant_id, service|level, ts) btree indexes and prune
// partitions. Every other clause is appended only when its filter is set, each
// value a fresh placeholder, so there is no SQL injection surface.
func buildSearch(tenantID kernel.TenantID, q kernel.SearchQuery, fetchLimit int) (string, []any, error) {
	var b strings.Builder
	args := make([]any, 0, 8)

	// $1: tenant predicate (defense-in-depth with RLS + planner pruning).
	args = append(args, string(tenantID))
	b.WriteString("SELECT ")
	b.WriteString(selectColumns)
	b.WriteString(" FROM log_events WHERE tenant_id = $1::uuid")

	// ph binds v as the next positional parameter and returns its $N token.
	ph := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}

	if !q.From.IsZero() {
		b.WriteString(" AND ts >= ")
		b.WriteString(ph(q.From.UTC()))
	}
	if !q.To.IsZero() {
		b.WriteString(" AND ts < ")
		b.WriteString(ph(q.To.UTC()))
	}
	if text := strings.TrimSpace(q.Text); text != "" {
		// websearch_to_tsquery tolerates ANY user input (it never raises on bad
		// syntax), so a malformed query degrades to fewer/zero matches, never a 500.
		b.WriteString(" AND search @@ websearch_to_tsquery('english', ")
		b.WriteString(ph(text))
		b.WriteString(")")
	}
	if len(q.Labels) > 0 {
		labels, err := marshalLabels(q.Labels)
		if err != nil {
			return "", nil, err
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
	if q.Cursor != nil {
		// Keyset: continue strictly AFTER the last row in (ts DESC, id DESC) order.
		// The row-value comparison (ts, id) < ($ts, $id) is served by a backward PK
		// scan, so page depth does not affect cost (model.md §5.4).
		b.WriteString(" AND (ts, id) < (")
		b.WriteString(ph(q.Cursor.TS.UTC()))
		b.WriteString(", ")
		b.WriteString(ph(q.Cursor.ID))
		b.WriteString("::uuid)")
	}

	b.WriteString(" ORDER BY ts DESC, id DESC LIMIT ")
	b.WriteString(ph(fetchLimit))
	return b.String(), args, nil
}

// paginate trims an over-fetched result to limit and derives the next cursor. If
// the query returned more than limit rows there is a following page, so the last
// KEPT row's (ts, id) is the cursor; otherwise the page is final (nil cursor).
// Pure so the keyset boundary logic is testable without a database.
func paginate(events []kernel.LogEvent, limit int) ([]kernel.LogEvent, *kernel.Cursor) {
	if len(events) <= limit {
		return events, nil
	}
	trimmed := events[:limit]
	last := trimmed[len(trimmed)-1]
	return trimmed, &kernel.Cursor{TS: last.TS, ID: last.ID}
}

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
