//go:build integration

// Panel-store integration tests run against REAL Postgres in a random-port
// testcontainer. Gated behind the `integration` build tag:
//
//	go test -tags=integration ./...
//
// Acceptance criteria proven here (issue #18):
//   - AC3a: A dashboard panel referencing a saved query renders correct
//     count/time-series data for the authed tenant.
//   - AC4:  A saved query from tenant B is invisible to tenant A under RLS
//     (PanelStore.Resolve returns nil for a cross-tenant savedQueryId).
package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/jackc/pgx/v5/pgxpool"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

const (
	psTenantA = "00000000-0000-0000-0000-00000000000a"
	psTenantB = "00000000-0000-0000-0000-00000000000b"
)

type psEnv struct {
	adminPool *pgxpool.Pool // postgres superuser — seeds (bypasses RLS)
	appPool   *pgxpool.Pool // logalot_app (NOSUPERUSER, RLS-governed)
}

func psSetup(t *testing.T) *psEnv {
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

	adminDSN := fmt.Sprintf("postgres://postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port())
	appDSN := fmt.Sprintf("postgres://logalot_app:logalot_app@%s:%s/logalot?sslmode=disable", host, port.Port())

	// Run migrations as postgres superuser via the pgx/v5 driver URL.
	migrateURL := fmt.Sprintf("pgx5://postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port())
	psRunMigrations(t, migrateURL)

	adminPool, err := platform.NewPool(ctx, adminDSN)
	if err != nil {
		t.Fatalf("admin pool: %v", err)
	}
	t.Cleanup(adminPool.Close)

	appPool, err := platform.NewPool(ctx, appDSN)
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	t.Cleanup(appPool.Close)

	return &psEnv{adminPool: adminPool, appPool: appPool}
}

func psRunMigrations(t *testing.T, dbURL string) {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	// internal/adapters/postgres → query-service → services → repo root → migrations
	dir := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "..", "migrations")
	m, err := migrate.New("file://"+dir, dbURL)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}
}

func (e *psEnv) seedTenant(t *testing.T, id, slug string) {
	t.Helper()
	_, err := e.adminPool.Exec(context.Background(),
		`INSERT INTO tenants (id, public_id, name, status) VALUES ($1,$2,$3,'active') ON CONFLICT (id) DO NOTHING`,
		id, slug, slug)
	if err != nil {
		t.Fatalf("seed tenant %s: %v", slug, err)
	}
}

func (e *psEnv) seedSavedQuery(t *testing.T, id, tenantID, name string, filters map[string]interface{}) {
	t.Helper()
	filtersJSON, _ := json.Marshal(filters)
	// Use admin pool to bypass RLS for test seeding.
	_, err := e.adminPool.Exec(context.Background(),
		`INSERT INTO saved_queries (id, tenant_id, name, query_text, filters, time_range)
		 VALUES ($1,$2,$3,'',$4::jsonb,'{}'::jsonb)`,
		id, tenantID, name, string(filtersJSON))
	if err != nil {
		t.Fatalf("seed saved_query %s: %v", name, err)
	}
}

func (e *psEnv) insertLog(t *testing.T, tenantID string, ts time.Time, level kernel.Level, svc, msg string) {
	t.Helper()
	ctx := context.Background()
	tx, err := e.appPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("arm tenant: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO log_events (tenant_id, ts, service, level, message, labels)
		 VALUES ($1::uuid, $2, $3, $4::log_level, $5, '{}'::jsonb)`,
		tenantID, ts.UTC(), svc, string(level), msg); err != nil {
		t.Fatalf("insert log: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// AC3a: PanelStore returns correct count and recent logs for the authed tenant.
func TestIntegration_PanelStore_CountAndRecent_MatchTenantA(t *testing.T) {
	e := psSetup(t)
	e.seedTenant(t, psTenantA, "ps-tenant-a")

	sqID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	e.seedSavedQuery(t, sqID, psTenantA, "billing errors", map[string]interface{}{
		"service": "billing",
		"level":   "error",
	})

	now := time.Now().UTC()
	for i := 0; i < 5; i++ {
		e.insertLog(t, psTenantA, now.Add(-time.Duration(i)*time.Second), kernel.LevelError, "billing", "payment failed")
	}
	// Extra log that should NOT match (different service).
	e.insertLog(t, psTenantA, now, kernel.LevelError, "api", "api error")

	store := NewPanelStore(e.appPool)
	tc := kernel.TenantContext{TenantID: psTenantA}
	ctx := context.Background()

	def, err := store.Resolve(ctx, tc, sqID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if def == nil {
		t.Fatal("Resolve returned nil for a saved query that exists in the tenant")
	}
	if def.Service != "billing" {
		t.Errorf("def.Service = %q, want billing", def.Service)
	}
	t.Logf("AC3a PROOF: Resolve returned service=%q level=%v", def.Service, def.Level)

	from := now.Add(-time.Hour)
	to := now.Add(time.Minute)

	count, err := store.Count(ctx, tc, *def, from, to)
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if count != 5 {
		t.Errorf("Count = %d, want 5 (the non-billing log must not match)", count)
	}
	t.Logf("AC3a PROOF: Count for tenant A billing/error = %d (correct, api error excluded)", count)

	recent, err := store.RecentLogs(ctx, tc, *def, from, to, 10)
	if err != nil {
		t.Fatalf("RecentLogs: %v", err)
	}
	if len(recent) != 5 {
		t.Errorf("RecentLogs = %d events, want 5", len(recent))
	}
	t.Logf("AC3a PROOF: RecentLogs returned %d events (correct)", len(recent))
}

// AC4: A saved query from tenant B is invisible to tenant A under RLS.
func TestIntegration_PanelStore_CrossTenantSavedQuery_Invisible(t *testing.T) {
	e := psSetup(t)
	e.seedTenant(t, psTenantA, "ps-ta2")
	e.seedTenant(t, psTenantB, "ps-tb2")

	sqID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	e.seedSavedQuery(t, sqID, psTenantB, "b secret query", map[string]interface{}{})

	store := NewPanelStore(e.appPool)
	// Resolve as tenant A — B's saved query is invisible under RLS.
	tc := kernel.TenantContext{TenantID: psTenantA}
	def, err := store.Resolve(context.Background(), tc, sqID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if def != nil {
		t.Fatalf("AC4 VIOLATION: tenant A resolved tenant B's saved query (cross-tenant leak): %+v", def)
	}
	t.Logf("AC4 PROOF: tenant A cannot resolve tenant B's saved query (RLS invisible → nil)")
}

// TimeSeries returns at least one bucket when there are logs in the range.
func TestIntegration_PanelStore_TimeSeries_ReturnsBuckets(t *testing.T) {
	e := psSetup(t)
	e.seedTenant(t, psTenantA, "ps-tc3")

	sqID := "cccccccc-cccc-cccc-cccc-cccccccccccc"
	e.seedSavedQuery(t, sqID, psTenantA, "all errors", map[string]interface{}{"level": "error"})

	now := time.Now().UTC()
	for i := 0; i < 6; i++ {
		e.insertLog(t, psTenantA, now.Add(-time.Duration(i)*time.Minute), kernel.LevelError, "svc", "boom")
	}

	store := NewPanelStore(e.appPool)
	tc := kernel.TenantContext{TenantID: psTenantA}
	ctx := context.Background()

	def, err := store.Resolve(ctx, tc, sqID)
	if err != nil || def == nil {
		t.Fatalf("Resolve: %v (def=%v)", err, def)
	}

	from := now.Add(-time.Hour)
	to := now.Add(time.Minute)
	buckets, err := store.TimeSeries(ctx, tc, *def, from, to, app.DefaultPanelBuckets)
	if err != nil {
		t.Fatalf("TimeSeries: %v", err)
	}
	if len(buckets) == 0 {
		t.Fatal("TimeSeries returned no buckets for 6 inserted logs")
	}
	var total int64
	for _, b := range buckets {
		total += b.Count
	}
	if total != 6 {
		t.Errorf("sum of bucket counts = %d, want 6", total)
	}
	t.Logf("AC3a PROOF: TimeSeries returned %d buckets, total events = %d", len(buckets), total)
}
