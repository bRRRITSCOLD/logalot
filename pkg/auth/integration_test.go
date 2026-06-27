//go:build integration

// Package auth integration tests run against real Postgres + Redis in hermetic,
// random-port testcontainers (the host runs a conflicting stack on the standard
// ports, so fixed ports are avoided). They are gated behind the `integration`
// build tag so the default `go test ./...` stays fast and Docker-free; run with:
//
//	go test -tags=integration ./...
//
// These tests prove the load-bearing security properties that unit tests with
// fakes cannot: the key lookup runs INSIDE RLS (a key for tenant A is invisible
// when armed for tenant B), revocation busts the cache, and a cache hit truly
// skips Postgres.
package auth

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/redis/go-redis/v9"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

type itEnv struct {
	adminPool *pgxpool.Pool // superuser: seeds tenants, deletes rows out from under the cache
	appPool   *pgxpool.Pool // logalot_app (NOSUPERUSER) — RLS bites here
	rc        *redis.Client
	auth      *Authenticator
	keys      *KeyStore
}

func setupEnv(t *testing.T) *itEnv {
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
	dsn := func(user, pass string) string {
		return fmt.Sprintf("postgres://%s:%s@%s:%s/logalot?sslmode=disable", user, pass, host, port.Port())
	}

	// Apply repo migrations as the superuser owner (these create the schema, the
	// pgcrypto extension, and the NOSUPERUSER logalot_app role itself).
	runMigrations(t, "pgx5://"+fmt.Sprintf("postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port()))

	adminPool, err := platform.NewPool(ctx, dsn("postgres", "postgres"))
	if err != nil {
		t.Fatalf("admin pool: %v", err)
	}
	t.Cleanup(adminPool.Close)

	// The application connects as logalot_app (created by migration 000011) so
	// FORCE ROW LEVEL SECURITY governs it — this is what makes the RLS test real.
	appPool, err := platform.NewPool(ctx, dsn("logalot_app", "logalot_app"))
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	t.Cleanup(appPool.Close)

	redisC, err := tcredis.Run(ctx, "redis:7")
	if err != nil {
		t.Fatalf("start redis: %v", err)
	}
	t.Cleanup(func() { _ = redisC.Terminate(ctx) })
	rHost, _ := redisC.Host(ctx)
	rPort, _ := redisC.MappedPort(ctx, "6379/tcp")
	rc, err := platform.NewRedisClient(ctx, platform.RedisConfig{Addr: rHost + ":" + rPort.Port()})
	if err != nil {
		t.Fatalf("redis client: %v", err)
	}
	t.Cleanup(func() { _ = rc.Close() })

	return &itEnv{
		adminPool: adminPool,
		appPool:   appPool,
		rc:        rc,
		auth:      New(appPool, rc),
		keys:      NewKeyStore(appPool, rc, DefaultCacheTTL),
	}
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

// seedTenant inserts a registry row (tenants has no RLS) via the superuser pool.
func (e *itEnv) seedTenant(t *testing.T, id, slug string) kernel.TenantID {
	t.Helper()
	_, err := e.adminPool.Exec(context.Background(),
		`INSERT INTO tenants (id, public_id, name, status) VALUES ($1, $2, $3, 'active')
		 ON CONFLICT (id) DO NOTHING`, id, slug, slug+" tenant")
	if err != nil {
		t.Fatalf("seed tenant %s: %v", slug, err)
	}
	return kernel.TenantID(id)
}

func (e *itEnv) issue(t *testing.T, tid kernel.TenantID, slug string, exp *time.Time) Minted {
	t.Helper()
	m, err := IssueKey(context.Background(), e.appPool, IssueParams{
		TenantID:  tid,
		PublicID:  slug,
		Name:      "it key",
		ExpiresAt: exp,
	})
	if err != nil {
		t.Fatalf("IssueKey: %v", err)
	}
	return m
}

func TestIntegration_Auth(t *testing.T) {
	env := setupEnv(t)
	ctx := context.Background()

	const (
		idA = "00000000-0000-0000-0000-00000000000a"
		idB = "00000000-0000-0000-0000-00000000000b"
	)
	tenantA := env.seedTenant(t, idA, "alpha")
	tenantB := env.seedTenant(t, idB, "bravo")

	t.Run("valid key resolves to correct TenantContext", func(t *testing.T) {
		_ = env.rc.FlushDB(ctx)
		m := env.issue(t, tenantA, "alpha", nil)
		tc, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: m.Plaintext})
		if err != nil {
			t.Fatalf("Authenticate: %v", err)
		}
		if tc.TenantID != tenantA {
			t.Errorf("TenantID = %q, want %q", tc.TenantID, tenantA)
		}
		if tc.PrincipalID != kernel.PrincipalID(m.APIKey.ID) {
			t.Errorf("PrincipalID = %q, want %q", tc.PrincipalID, m.APIKey.ID)
		}
		if !tc.HasScope(kernel.ScopeIngestWrite) {
			t.Errorf("missing ingest:write scope")
		}
	})

	t.Run("cross-tenant key id is invisible under RLS", func(t *testing.T) {
		_ = env.rc.FlushDB(ctx) // force the DB path so RLS is exercised
		m := env.issue(t, tenantA, "alpha", nil)
		// Present tenant B's slug with tenant A's key id + secret. Resolution arms
		// RLS for B, then the scoped SELECT of A's key id returns ZERO rows.
		forged := keyPrefix + "_bravo_" + m.APIKey.ID + "_" + secretOf(t, m.Plaintext)
		if _, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: forged}); err == nil {
			t.Fatal("expected rejection: A's key id must be invisible when armed for B")
		}
		// Sanity: B's slug DOES own its own key.
		mB := env.issue(t, tenantB, "bravo", nil)
		if _, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: mB.Plaintext}); err != nil {
			t.Fatalf("B's own key should authenticate: %v", err)
		}
	})

	t.Run("revoked key is rejected and cache busted", func(t *testing.T) {
		_ = env.rc.FlushDB(ctx)
		m := env.issue(t, tenantA, "alpha", nil)
		if _, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: m.Plaintext}); err != nil {
			t.Fatalf("pre-revoke auth: %v", err)
		}
		tcA := kernel.TenantContext{TenantID: tenantA, PrincipalID: kernel.PrincipalID(m.APIKey.ID)}
		if err := env.keys.Revoke(tcA, ctx, m.APIKey.ID); err != nil {
			t.Fatalf("Revoke: %v", err)
		}
		if _, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: m.Plaintext}); err == nil {
			t.Fatal("revoked key still authenticated")
		}
	})

	t.Run("cache hit skips Postgres", func(t *testing.T) {
		_ = env.rc.FlushDB(ctx)
		m := env.issue(t, tenantA, "alpha", nil)
		// First call: miss -> DB -> populate cache.
		if _, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: m.Plaintext}); err != nil {
			t.Fatalf("first auth: %v", err)
		}
		// Delete the row out from under the cache (superuser bypasses RLS).
		if _, err := env.adminPool.Exec(ctx, `DELETE FROM api_keys WHERE id = $1`, m.APIKey.ID); err != nil {
			t.Fatalf("delete row: %v", err)
		}
		// Within TTL the cached entry still authenticates even though the row is gone.
		if _, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: m.Plaintext}); err != nil {
			t.Fatalf("cached auth after row delete should succeed: %v", err)
		}
		// Bust the cache and confirm it now fails (proves it WAS the cache serving it).
		_ = env.rc.Del(ctx, cacheKey(m.APIKey.ID))
		if _, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: m.Plaintext}); err == nil {
			t.Fatal("after cache bust + row delete the key must fail (no DB fallback)")
		}
	})

	t.Run("expired key is rejected", func(t *testing.T) {
		_ = env.rc.FlushDB(ctx)
		past := time.Now().Add(-time.Hour)
		m := env.issue(t, tenantA, "alpha", &past)
		if _, err := env.auth.Authenticate(ctx, kernel.Credential{APIKey: m.Plaintext}); err == nil {
			t.Fatal("expired key authenticated")
		}
	})

	t.Run("KeyStore.Lookup is tenant-scoped", func(t *testing.T) {
		_ = env.rc.FlushDB(ctx)
		m := env.issue(t, tenantA, "alpha", nil)
		tcA := kernel.TenantContext{TenantID: tenantA}
		got, err := env.keys.Lookup(tcA, ctx, m.APIKey.ID)
		if err != nil {
			t.Fatalf("Lookup under A: %v", err)
		}
		if got.TenantID != tenantA {
			t.Errorf("Lookup TenantID = %q", got.TenantID)
		}
		// The same key id is invisible to tenant B.
		tcB := kernel.TenantContext{TenantID: tenantB}
		if _, err := env.keys.Lookup(tcB, ctx, m.APIKey.ID); err == nil {
			t.Fatal("A's key id must not be Lookup-able under B's context")
		}
	})
}

// secretOf extracts the secret field from a freshly minted plaintext key for the
// cross-tenant forgery test. It is test-only; production never decomposes a key
// except via parseKey.
func secretOf(t *testing.T, plaintext string) string {
	t.Helper()
	pk, err := parseKey(plaintext)
	if err != nil {
		t.Fatalf("parse minted key: %v", err)
	}
	return pk.Secret
}
