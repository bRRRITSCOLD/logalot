//go:build integration

// Migration 000017 wiring + validation tests.
//
// These integration tests prove the load-bearing security and data-integrity
// properties of the oauth_identities table that unit tests with fakes cannot:
//
//   - RLS fail-closed: an unarmed session returns zero rows and an INSERT with a
//     foreign tenant_id is rejected by the WITH CHECK policy (no bypass).
//   - Per-tenant uniqueness: the same (provider, provider_sub) pair may exist once
//     per tenant; a duplicate within a tenant yields SQLSTATE 23505.
//   - Cross-tenant isolation: a SELECT by (provider, provider_sub) under tenant A's
//     context never returns a row linked only to tenant B.
//   - No SECURITY DEFINER resolver: the function app.resolve_oauth_identity_by_sub
//     must NOT exist (dropped in the migration; D6).
//   - Composite FK integrity: (tenant_id, user_id) must satisfy the FK to users
//     (tenant_id, id) — a cross-tenant user reference is rejected (23503).
//   - Dev seed idempotency: running the seed SQL twice produces the same state (ON
//     CONFLICT DO NOTHING on the oauth_identities row).
//   - Up→down→up cycle: 000017 can be rolled back (drops table + type) and
//     re-applied without error.
//
// Run with:
//
//	go test -tags=integration -run TestMigration000017 ./pkg/auth/...
package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

// migration000017Env is a minimal test harness: Postgres only (no Redis), with
// two pools — admin (superuser, bypasses RLS) and app (NOSUPERUSER, RLS bites).
type migration000017Env struct {
	adminPool *pgxpool.Pool
	appPool   *pgxpool.Pool
	// pgURL is the pgx5:// DSN used by golang-migrate (postgres driver variant).
	pgURL string
	// appDSN is used to open the app pool (and can also be used to run seeds).
	appDSN string
}

// setupMigration000017 starts a Postgres testcontainer, runs all migrations, and
// returns the harness. Each caller gets a fresh database.
func setupMigration000017(t *testing.T) *migration000017Env {
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

	host, err := pgC.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := pgC.MappedPort(ctx, "5432/tcp")
	if err != nil {
		t.Fatal(err)
	}

	adminDSN := fmt.Sprintf("postgres://postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port())
	appDSN := fmt.Sprintf("postgres://logalot_app:logalot_app@%s:%s/logalot?sslmode=disable", host, port.Port())
	pgURL := fmt.Sprintf("pgx5://postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port())

	// Apply all migrations (creates the schema, the app role, and 000017).
	runMigrations(t, pgURL)

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

	return &migration000017Env{
		adminPool: adminPool,
		appPool:   appPool,
		pgURL:     pgURL,
		appDSN:    appDSN,
	}
}

// migrationsDir returns the absolute path to the repo-root migrations directory.
func migrationsDir() string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
}

// seedsDir returns the absolute path to the repo-root migrations/seeds directory.
func seedsDir() string {
	return filepath.Join(migrationsDir(), "seeds")
}

// seedTenantAdmin inserts a tenant row via the superuser pool (tenants has no RLS).
func (e *migration000017Env) seedTenantAdmin(t *testing.T, id, slug string) {
	t.Helper()
	_, err := e.adminPool.Exec(context.Background(),
		`INSERT INTO tenants (id, public_id, name, status) VALUES ($1, $2, $3, 'active')
		 ON CONFLICT (id) DO NOTHING`, id, slug, slug+" tenant")
	if err != nil {
		t.Fatalf("seed tenant %s: %v", slug, err)
	}
}

// seedUserAdmin inserts a user row via the superuser pool (bypasses RLS).
func (e *migration000017Env) seedUserAdmin(t *testing.T, tenantID, userID, email string) {
	t.Helper()
	_, err := e.adminPool.Exec(context.Background(),
		`INSERT INTO users (id, tenant_id, email, password_hash, display_name)
		 VALUES ($1, $2, $3, 'x', 'test')
		 ON CONFLICT (id) DO NOTHING`, userID, tenantID, email)
	if err != nil {
		t.Fatalf("seed user %s/%s: %v", tenantID, email, err)
	}
}

// pgErrCode extracts the SQLSTATE code from a pgconn.PgError, returning "" if
// the error is not a PgError.
func pgErrCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// TestMigration000017 is the primary acceptance-criteria driver. All sub-tests
// share a single migrated Postgres container for speed.
func TestMigration000017(t *testing.T) {
	env := setupMigration000017(t)
	ctx := context.Background()

	const (
		// Two tenants.
		tenantA = "00000000-0000-0000-0000-000000000017"
		tenantB = "00000000-0000-0000-0000-000000000018"
		// One user per tenant.
		userA = "00000000-0000-0000-0000-0000000017a1"
		userB = "00000000-0000-0000-0000-0000000017b1"
		// A shared Google provider_sub used for the cross-tenant uniqueness test.
		sharedSub = "google-sub-shared-0017"
	)

	// Seed the tenants and their users via the admin pool (bypasses RLS).
	env.seedTenantAdmin(t, tenantA, "t17a")
	env.seedTenantAdmin(t, tenantB, "t17b")
	env.seedUserAdmin(t, tenantA, userA, "user@t17a.test")
	env.seedUserAdmin(t, tenantB, userB, "user@t17b.test")

	// -------------------------------------------------------------------------
	// AC-1: No resolver function exists (D6 — dropped in 000017).
	// -------------------------------------------------------------------------
	t.Run("no SECURITY DEFINER resolver (D6)", func(t *testing.T) {
		var count int
		err := env.adminPool.QueryRow(ctx, `
			SELECT count(*)
			FROM   pg_proc p
			JOIN   pg_namespace n ON n.oid = p.pronamespace
			WHERE  n.nspname = 'app'
			  AND  p.proname = 'resolve_oauth_identity_by_sub'
		`).Scan(&count)
		if err != nil {
			t.Fatalf("pg_proc query: %v", err)
		}
		if count != 0 {
			t.Errorf("app.resolve_oauth_identity_by_sub exists (count=%d); want 0 (must be dropped)", count)
		}
	})

	// -------------------------------------------------------------------------
	// AC-2: RLS fail-closed — no context => 0 rows (R2).
	// -------------------------------------------------------------------------
	t.Run("RLS fail-closed: unarmed session returns 0 rows", func(t *testing.T) {
		// Insert a valid row as tenant A (armed) so there IS a row to hide.
		_, err := env.appPool.Exec(ctx, `
			SET LOCAL app.tenant_id = $1;
			INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
			VALUES ($1, $2, 'google', 'rls-probe-sub', 'probe@t17a.test')
			ON CONFLICT DO NOTHING
		`, tenantA, userA)
		if err != nil {
			t.Fatalf("arm + insert for RLS probe: %v", err)
		}

		// Now run in a fresh connection with NO context set.
		var count int
		err = env.appPool.QueryRow(ctx, `SELECT count(*) FROM oauth_identities`).Scan(&count)
		if err != nil {
			t.Fatalf("unarmed count: %v", err)
		}
		if count != 0 {
			t.Errorf("unarmed session sees %d row(s), want 0 (RLS must fail-closed)", count)
		}
	})

	// -------------------------------------------------------------------------
	// AC-3: RLS WITH CHECK — foreign-tenant INSERT is rejected.
	// -------------------------------------------------------------------------
	t.Run("RLS WITH CHECK: foreign-tenant INSERT rejected", func(t *testing.T) {
		// Arm tenant A's context but try to INSERT a row with tenant_id = B.
		// The WITH CHECK policy (tenant_id = app.current_tenant_id()) must reject it.
		conn, err := env.appPool.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire conn: %v", err)
		}
		defer conn.Release()

		_, err = conn.Exec(ctx, `SET LOCAL app.tenant_id = $1`, tenantA)
		if err != nil {
			t.Fatalf("set tenant context: %v", err)
		}
		_, err = conn.Exec(ctx, `
			INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
			VALUES ($1, $2, 'google', 'cross-tenant-sub', 'cross@t17b.test')
		`, tenantB, userB)
		if err == nil {
			t.Fatal("expected WITH CHECK rejection for foreign-tenant INSERT, got nil error")
		}
		code := pgErrCode(err)
		// Postgres RLS WITH CHECK violation produces 42501 (insufficient_privilege).
		if code != "42501" {
			t.Errorf("WITH CHECK error code = %q, want 42501 (insufficient_privilege)", code)
		}
	})

	// -------------------------------------------------------------------------
	// AC-4: Per-tenant uniqueness — same (provider, sub) in different tenants (R3 / multi-tenant membership).
	// -------------------------------------------------------------------------
	t.Run("per-tenant uniqueness: same sub in different tenants is allowed", func(t *testing.T) {
		// Insert under tenant A.
		connA, err := env.appPool.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire conn A: %v", err)
		}
		defer connA.Release()
		if _, err = connA.Exec(ctx, `SET LOCAL app.tenant_id = $1`, tenantA); err != nil {
			t.Fatalf("set context A: %v", err)
		}
		if _, err = connA.Exec(ctx, `
			INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
			VALUES ($1, $2, 'google', $3, 'shared@t17a.test')
		`, tenantA, userA, sharedSub); err != nil {
			t.Fatalf("insert under A: %v", err)
		}

		// Insert the SAME (provider, provider_sub) under tenant B — must succeed.
		connB, err := env.appPool.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire conn B: %v", err)
		}
		defer connB.Release()
		if _, err = connB.Exec(ctx, `SET LOCAL app.tenant_id = $1`, tenantB); err != nil {
			t.Fatalf("set context B: %v", err)
		}
		if _, err = connB.Exec(ctx, `
			INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
			VALUES ($1, $2, 'google', $3, 'shared@t17b.test')
		`, tenantB, userB, sharedSub); err != nil {
			t.Fatalf("insert same sub under B should succeed (multi-tenant membership): %v", err)
		}
	})

	// -------------------------------------------------------------------------
	// AC-5: Per-tenant uniqueness — duplicate within the same tenant => 23505.
	// -------------------------------------------------------------------------
	t.Run("per-tenant uniqueness: duplicate sub within same tenant => 23505", func(t *testing.T) {
		const dupSub = "google-sub-dup-0017"

		conn, err := env.appPool.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire conn: %v", err)
		}
		defer conn.Release()

		if _, err = conn.Exec(ctx, `SET LOCAL app.tenant_id = $1`, tenantA); err != nil {
			t.Fatalf("set context: %v", err)
		}
		if _, err = conn.Exec(ctx, `
			INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
			VALUES ($1, $2, 'google', $3, 'dup@t17a.test')
		`, tenantA, userA, dupSub); err != nil {
			t.Fatalf("first insert: %v", err)
		}
		// Second insert with the same (tenant_id, provider, provider_sub) must fail.
		_, err = conn.Exec(ctx, `
			INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
			VALUES ($1, $2, 'google', $3, 'dup2@t17a.test')
		`, tenantA, userA, dupSub)
		if err == nil {
			t.Fatal("expected 23505 (unique_violation) for duplicate sub within tenant, got nil")
		}
		if code := pgErrCode(err); code != "23505" {
			t.Errorf("duplicate sub error code = %q, want 23505 (unique_violation)", code)
		}
	})

	// -------------------------------------------------------------------------
	// AC-6: RLS-scoped SELECT by sub — cross-tenant isolation (R3 structural).
	// -------------------------------------------------------------------------
	t.Run("RLS SELECT by sub: cross-tenant isolation (R3)", func(t *testing.T) {
		const selectSub = "google-sub-select-0017"

		// Insert under A.
		connA, err := env.appPool.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire conn A: %v", err)
		}
		defer connA.Release()
		if _, err = connA.Exec(ctx, `SET LOCAL app.tenant_id = $1`, tenantA); err != nil {
			t.Fatalf("set context A: %v", err)
		}
		if _, err = connA.Exec(ctx, `
			INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
			VALUES ($1, $2, 'google', $3, 'sel@t17a.test')
		`, tenantA, userA, selectSub); err != nil {
			t.Fatalf("insert under A: %v", err)
		}

		// SELECT under A → must see the row.
		var countA int
		if err = connA.QueryRow(ctx, `
			SELECT count(*) FROM oauth_identities
			WHERE  provider = 'google' AND provider_sub = $1
		`, selectSub).Scan(&countA); err != nil {
			t.Fatalf("select under A: %v", err)
		}
		if countA != 1 {
			t.Errorf("A sees %d row(s) for its own sub, want 1", countA)
		}

		// SELECT under B → must see 0 (structural RLS, no row for B).
		connB, err := env.appPool.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire conn B: %v", err)
		}
		defer connB.Release()
		if _, err = connB.Exec(ctx, `SET LOCAL app.tenant_id = $1`, tenantB); err != nil {
			t.Fatalf("set context B: %v", err)
		}
		var countB int
		if err = connB.QueryRow(ctx, `
			SELECT count(*) FROM oauth_identities
			WHERE  provider = 'google' AND provider_sub = $1
		`, selectSub).Scan(&countB); err != nil {
			t.Fatalf("select under B: %v", err)
		}
		if countB != 0 {
			t.Errorf("B sees %d row(s) for A's sub, want 0 (RLS cross-tenant isolation breach)", countB)
		}
	})

	// -------------------------------------------------------------------------
	// AC-7: Same-tenant composite FK violation — cross-tenant user_id is rejected.
	// -------------------------------------------------------------------------
	t.Run("FK violation: cross-tenant user_id rejected (23503)", func(t *testing.T) {
		// Arm tenant A but try to reference userB (belongs to tenant B).
		conn, err := env.appPool.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire conn: %v", err)
		}
		defer conn.Release()

		if _, err = conn.Exec(ctx, `SET LOCAL app.tenant_id = $1`, tenantA); err != nil {
			t.Fatalf("set context: %v", err)
		}
		_, err = conn.Exec(ctx, `
			INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
			VALUES ($1, $2, 'google', 'fk-violation-sub', 'fk@t17a.test')
		`, tenantA, userB) // tenantA + userB is a cross-tenant composite FK violation
		if err == nil {
			t.Fatal("expected FK violation (23503) for cross-tenant user_id, got nil")
		}
		if code := pgErrCode(err); code != "23503" {
			t.Errorf("FK violation error code = %q, want 23503 (foreign_key_violation)", code)
		}
	})
}

// TestMigration000017_DevSeedIdempotent proves that the dev seed's
// oauth_identities row can be inserted twice without error (ON CONFLICT DO NOTHING).
// It runs the relevant portion of migrations/seeds/dev_tenant.sql twice.
func TestMigration000017_DevSeedIdempotent(t *testing.T) {
	env := setupMigration000017(t)
	ctx := context.Background()

	seedSQL, err := os.ReadFile(filepath.Join(seedsDir(), "dev_tenant.sql"))
	if err != nil {
		t.Fatalf("read dev_tenant.sql: %v", err)
	}

	// Run the seed twice — both must succeed.
	for i := range 2 {
		if _, err := env.adminPool.Exec(ctx, string(seedSQL)); err != nil {
			t.Fatalf("seed run %d: %v", i+1, err)
		}
	}

	// After the second run the oauth_identities row must still exist exactly once
	// (idempotent, not duplicated).
	var count int
	if err := env.adminPool.QueryRow(ctx, `
		SELECT count(*) FROM oauth_identities
		WHERE  provider_sub = 'google-sub-dev-admin'
	`).Scan(&count); err != nil {
		t.Fatalf("count dev seed row: %v", err)
	}
	if count != 1 {
		t.Errorf("dev seed oauth_identities count = %d, want 1 (idempotent)", count)
	}
}

// TestMigration000017_UpDownUp proves that the 000017 migration pair is
// reversible: up→down drops the table and type; up re-creates them cleanly.
func TestMigration000017_UpDownUp(t *testing.T) {
	env := setupMigration000017(t)
	ctx := context.Background()

	mDir := "file://" + migrationsDir()

	// Step 1: All migrations are already applied by setupMigration000017.
	// Verify 000017 is in place.
	if _, err := env.adminPool.Exec(ctx, `SELECT 'ok' FROM oauth_identities WHERE false`); err != nil {
		t.Fatalf("pre-down: oauth_identities does not exist: %v", err)
	}

	// Step 2: Roll back 000017 (Steps(-1)).
	m, err := migrate.New(mDir, env.pgURL)
	if err != nil {
		t.Fatalf("migrate.New for down: %v", err)
	}
	if err := m.Steps(-1); err != nil {
		t.Fatalf("migrate Steps(-1): %v", err)
	}
	_, _ = m.Close()

	// Verify the table and enum are gone.
	var tableExists bool
	err = env.adminPool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema='public' AND table_name='oauth_identities'
		)
	`).Scan(&tableExists)
	if err != nil {
		t.Fatalf("table existence check after down: %v", err)
	}
	if tableExists {
		t.Error("oauth_identities table still exists after rolling back 000017")
	}

	var typeExists bool
	err = env.adminPool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM pg_type WHERE typname = 'oauth_provider'
		)
	`).Scan(&typeExists)
	if err != nil {
		t.Fatalf("type existence check after down: %v", err)
	}
	if typeExists {
		t.Error("oauth_provider type still exists after rolling back 000017")
	}

	// Step 3: Re-apply 000017 (Steps(+1)).
	m2, err := migrate.New(mDir, env.pgURL)
	if err != nil {
		t.Fatalf("migrate.New for re-up: %v", err)
	}
	if err := m2.Steps(1); err != nil {
		t.Fatalf("migrate Steps(+1): %v", err)
	}
	_, _ = m2.Close()

	// Verify the table is back.
	if _, err := env.adminPool.Exec(ctx, `SELECT 'ok' FROM oauth_identities WHERE false`); err != nil {
		t.Fatalf("post-re-up: oauth_identities not restored: %v", err)
	}
}
