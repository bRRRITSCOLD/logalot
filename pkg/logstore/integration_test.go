//go:build integration

// Hot-search integration tests run the real Search against a migrated Postgres in
// a hermetic, random-port testcontainer. Gated behind the `integration` build tag
// so the default `go test ./...` stays Docker-free:
//
//	go test -tags=integration ./...
//
// They prove what the pure builder/pagination unit tests cannot:
//   - full-text (websearch_to_tsquery), label containment (@>), time-range,
//     level and service filters each select the right rows;
//   - keyset pagination walks page1 -> cursor -> page2 with no overlap and no gap;
//   - CROSS-TENANT ISOLATION: a search armed as tenant A never returns tenant B's
//     rows, enforced purely by RLS + the bound tenant predicate.
//
// The store connects as the NOSUPERUSER logalot_app role so FORCE ROW LEVEL
// SECURITY actually bites (mirrors the processor/auth integration tests).
package logstore

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/jackc/pgx/v5/pgxpool"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

const (
	idA = kernel.TenantID("00000000-0000-0000-0000-00000000000a")
	idB = kernel.TenantID("00000000-0000-0000-0000-00000000000b")
)

// newStore stands up a migrated Postgres and returns a Store over the NOSUPERUSER
// logalot_app pool (so RLS is enforced).
func newStore(t *testing.T) *Store {
	t.Helper()
	ctx := context.Background()

	pgC, err := tcpostgres.Run(ctx, "postgres:16",
		tcpostgres.WithDatabase("logalot"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("postgres"),
		tcpostgres.BasicWaitStrategies(),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = pgC.Terminate(ctx) })
	host, _ := pgC.Host(ctx)
	port, _ := pgC.MappedPort(ctx, "5432/tcp")

	runMigrations(t, "pgx5://"+fmt.Sprintf("postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port()))

	appDSN := fmt.Sprintf("postgres://logalot_app:logalot_app@%s:%s/logalot?sslmode=disable", host, port.Port())
	pool, err := pgxpool.New(ctx, appDSN)
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping app pool: %v", err)
	}
	return New(pool)
}

func runMigrations(t *testing.T, dbURL string) {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	migrationsDir := filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
	m, err := migrate.New("file://"+migrationsDir, dbURL)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}
}

// seed appends events for a tenant, one per supplied event, via the real
// RLS-armed Append path. Each event's TS must already be set by the caller.
func seed(t *testing.T, s *Store, tenant kernel.TenantID, events ...kernel.LogEvent) {
	t.Helper()
	if err := s.Append(kernel.TenantContext{TenantID: tenant}, context.Background(), events...); err != nil {
		t.Fatalf("seed append (%s): %v", tenant, err)
	}
}

func tcOf(tenant kernel.TenantID) kernel.TenantContext {
	return kernel.TenantContext{TenantID: tenant}
}

// base is a fixed instant inside "today" so all seeded rows land in the
// bootstrapped daily partition (the migration ensures today..+7). Using distinct
// second offsets keeps the (ts, id) ordering deterministic.
func base() time.Time {
	return time.Now().UTC().Truncate(time.Hour).Add(30 * time.Minute)
}

func msgs(events []kernel.LogEvent) []string {
	out := make([]string, len(events))
	for i, e := range events {
		out[i] = e.Message
	}
	return out
}

func TestIntegration_FullTextSearch(t *testing.T) {
	s := newStore(t)
	b := base()
	seed(t, s, idA,
		kernel.LogEvent{TS: b, Service: "api", Level: kernel.LevelError, Message: "disk almost full on node-1"},
		kernel.LogEvent{TS: b.Add(time.Second), Service: "api", Level: kernel.LevelInfo, Message: "user login succeeded"},
		kernel.LogEvent{TS: b.Add(2 * time.Second), Service: "worker", Level: kernel.LevelWarn, Message: "disk space reclaimed"},
	)

	page, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Text: "disk"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(page.Events) != 2 {
		t.Fatalf("FTS 'disk' matched %d rows %v, want 2", len(page.Events), msgs(page.Events))
	}
	for _, e := range page.Events {
		if e.Message == "user login succeeded" {
			t.Errorf("FTS leaked a non-matching row: %q", e.Message)
		}
	}
	t.Logf("FTS PROOF: 'disk' -> %v", msgs(page.Events))

	// A garbage query with tsquery metacharacters must NOT error (websearch parse).
	if _, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Text: "disk & | ! ( :*"}); err != nil {
		t.Fatalf("malformed FTS query must not error (websearch_to_tsquery is safe): %v", err)
	}
	t.Logf("FTS SAFETY: malformed query 'disk & | ! ( :*' parsed without error")
}

func TestIntegration_LabelContainmentFilter(t *testing.T) {
	s := newStore(t)
	b := base()
	seed(t, s, idA,
		kernel.LogEvent{TS: b, Service: "api", Level: kernel.LevelInfo, Message: "east", Labels: map[string]string{"region": "us-east-1", "env": "prod"}},
		kernel.LogEvent{TS: b.Add(time.Second), Service: "api", Level: kernel.LevelInfo, Message: "west", Labels: map[string]string{"region": "us-west-2", "env": "prod"}},
	)

	page, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Labels: map[string]string{"region": "us-east-1"}})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(page.Events) != 1 || page.Events[0].Message != "east" {
		t.Fatalf("label @> {region:us-east-1} -> %v, want [east]", msgs(page.Events))
	}

	// Multi-key containment narrows further.
	page, err = s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Labels: map[string]string{"env": "prod", "region": "us-west-2"}})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(page.Events) != 1 || page.Events[0].Message != "west" {
		t.Fatalf("multi-key containment -> %v, want [west]", msgs(page.Events))
	}
	t.Logf("LABEL PROOF: @> containment selects exactly the matching row")
}

func TestIntegration_TimeRangeAndLevelAndService(t *testing.T) {
	s := newStore(t)
	b := base()
	seed(t, s, idA,
		kernel.LogEvent{TS: b, Service: "api", Level: kernel.LevelInfo, Message: "in-range-api-info"},
		kernel.LogEvent{TS: b.Add(time.Second), Service: "worker", Level: kernel.LevelError, Message: "in-range-worker-error"},
		kernel.LogEvent{TS: b.Add(10 * time.Minute), Service: "api", Level: kernel.LevelInfo, Message: "out-of-range"},
	)

	// [from, to) excludes the +10m row.
	from := b.Add(-time.Second)
	to := b.Add(5 * time.Minute)
	page, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{From: from, To: to})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(page.Events) != 2 {
		t.Fatalf("time-range -> %v, want 2 (excludes out-of-range)", msgs(page.Events))
	}

	// Level filter.
	lvl := kernel.LevelError
	page, err = s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Level: &lvl})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(page.Events) != 1 || page.Events[0].Message != "in-range-worker-error" {
		t.Fatalf("level=error -> %v, want [in-range-worker-error]", msgs(page.Events))
	}

	// Service filter.
	page, err = s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Service: "worker"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(page.Events) != 1 || page.Events[0].Service != "worker" {
		t.Fatalf("service=worker -> %v, want one worker row", msgs(page.Events))
	}
	t.Logf("FILTER PROOF: time-range/level/service each select correctly")
}

func TestIntegration_KeysetPagination_NoOverlapNoGap(t *testing.T) {
	s := newStore(t)
	b := base()
	// Five rows, descending ts: e4 (newest) .. e0 (oldest).
	var events []kernel.LogEvent
	for i := 0; i < 5; i++ {
		events = append(events, kernel.LogEvent{
			TS:      b.Add(time.Duration(i) * time.Second),
			Service: "api", Level: kernel.LevelInfo,
			Message: fmt.Sprintf("event-%d", i),
		})
	}
	seed(t, s, idA, events...)

	// Page 1: newest 2 (event-4, event-3) + a next cursor.
	p1, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Limit: 2})
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(p1.Events) != 2 || p1.NextCursor == nil {
		t.Fatalf("page1 = %v (cursor=%v), want 2 events + cursor", msgs(p1.Events), p1.NextCursor)
	}
	if p1.Events[0].Message != "event-4" || p1.Events[1].Message != "event-3" {
		t.Fatalf("page1 order = %v, want [event-4 event-3] (ts DESC)", msgs(p1.Events))
	}

	// Page 2: follow the cursor — event-2, event-1.
	p2, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Limit: 2, Cursor: p1.NextCursor})
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(p2.Events) != 2 || p2.NextCursor == nil {
		t.Fatalf("page2 = %v (cursor=%v), want 2 events + cursor", msgs(p2.Events), p2.NextCursor)
	}
	if p2.Events[0].Message != "event-2" || p2.Events[1].Message != "event-1" {
		t.Fatalf("page2 order = %v, want [event-2 event-1]", msgs(p2.Events))
	}

	// Page 3: the final row — event-0, no further cursor.
	p3, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Limit: 2, Cursor: p2.NextCursor})
	if err != nil {
		t.Fatalf("page3: %v", err)
	}
	if len(p3.Events) != 1 || p3.NextCursor != nil {
		t.Fatalf("page3 = %v (cursor=%v), want [event-0] + nil cursor", msgs(p3.Events), p3.NextCursor)
	}

	// No overlap and no gap: the three pages reconstruct all 5 rows in order.
	var seen []string
	for _, p := range []kernel.SearchPage{p1, p2, p3} {
		seen = append(seen, msgs(p.Events)...)
	}
	want := []string{"event-4", "event-3", "event-2", "event-1", "event-0"}
	if len(seen) != len(want) {
		t.Fatalf("paged rows = %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("paged order = %v, want %v (overlap or gap)", seen, want)
		}
	}
	t.Logf("KEYSET PROOF: page1=%v -> page2=%v -> page3=%v (no overlap, no gap)", msgs(p1.Events), msgs(p2.Events), msgs(p3.Events))
}

// TestIntegration_CrossTenantIsolation is the load-bearing multi-tenancy proof: a
// search armed as tenant A never returns tenant B's rows, even though both share
// the same physical partitions. Isolation is enforced by RLS + the bound tenant
// predicate — SearchQuery carries no tenant a caller could spoof.
func TestIntegration_CrossTenantIsolation(t *testing.T) {
	s := newStore(t)
	b := base()

	seed(t, s, idA,
		kernel.LogEvent{TS: b, Service: "api", Level: kernel.LevelInfo, Message: "TENANT-A-SECRET", Labels: map[string]string{"shared": "yes"}},
	)
	seed(t, s, idB,
		kernel.LogEvent{TS: b.Add(time.Second), Service: "api", Level: kernel.LevelInfo, Message: "TENANT-B-SECRET", Labels: map[string]string{"shared": "yes"}},
	)

	// A broad query (matching label, no other filter) as A must see ONLY A's row.
	asA, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Labels: map[string]string{"shared": "yes"}})
	if err != nil {
		t.Fatalf("search as A: %v", err)
	}
	if len(asA.Events) != 1 || asA.Events[0].Message != "TENANT-A-SECRET" {
		t.Fatalf("CROSS-TENANT LEAK: A sees %v, want only [TENANT-A-SECRET]", msgs(asA.Events))
	}
	for _, e := range asA.Events {
		if e.TenantID != idA {
			t.Fatalf("CROSS-TENANT LEAK: A's result carries tenant %q", e.TenantID)
		}
	}

	// And B sees ONLY B's row.
	asB, err := s.Search(tcOf(idB), context.Background(), kernel.SearchQuery{Labels: map[string]string{"shared": "yes"}})
	if err != nil {
		t.Fatalf("search as B: %v", err)
	}
	if len(asB.Events) != 1 || asB.Events[0].Message != "TENANT-B-SECRET" {
		t.Fatalf("CROSS-TENANT LEAK: B sees %v, want only [TENANT-B-SECRET]", msgs(asB.Events))
	}

	// Even an FTS query for B's secret, armed as A, returns nothing.
	leak, err := s.Search(tcOf(idA), context.Background(), kernel.SearchQuery{Text: "TENANT-B-SECRET"})
	if err != nil {
		t.Fatalf("search A for B's secret: %v", err)
	}
	if len(leak.Events) != 0 {
		t.Fatalf("CROSS-TENANT LEAK: A searching B's secret returned %v, want 0", msgs(leak.Events))
	}
	t.Logf("ISOLATION PROOF: A sees only A, B sees only B; A searching B's secret -> 0 rows (pure RLS + bound predicate)")
}
