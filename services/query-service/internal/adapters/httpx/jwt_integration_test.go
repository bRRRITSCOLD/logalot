//go:build integration

// End-to-end JWT auth integration test (issue #74): a REAL control-plane-signed
// HS256 token is driven through the FULL query-service edge — the composite
// authenticator (JWT + API-key), the AuthMiddleware, and the RLS-backed search /
// live-tail handlers — against a migrated Postgres + Redis in hermetic,
// random-port testcontainers. Gated behind the `integration` build tag:
//
//	go test -tags=integration ./...
//
// It proves what fakes cannot, and what issue #74 demands:
//   - a token signed exactly as control-plane signs it (HS256 over JWT_SECRET,
//     iss=logalot-control-plane, aud=logalot, tenant_id, role, sub, iat, exp)
//     authorizes /v1/search and /v1/tail and scopes results to its tenant_id;
//   - CROSS-TENANT: a JWT for tenant A can never read tenant B's rows — isolation
//     is RLS + the claim-derived tenant, with no caller-controlled tenant input;
//   - the existing `lgk_` API-key path still authorizes (composite routing).
//
// The store/auth connect as the NOSUPERUSER logalot_app role so FORCE ROW LEVEL
// SECURITY actually bites (mirrors the pkg/auth + pkg/logstore integration tests).
package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/auth"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/logstore"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/pkg/tailbus"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/adapters/authn"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

// The control-plane token contract (jose-token-service.ts) reproduced here.
const (
	jwtTestSecret = "dev-jwt-secret-change-me-0123456789"
	jwtIssuer     = "logalot-control-plane"
	jwtAudience   = "logalot"
)

const (
	jwtTenantA = kernel.TenantID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	jwtTenantB = kernel.TenantID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
)

// jwtITEnv is the wired query-service edge under test plus the seams the test
// needs to seed rows and mint credentials.
type jwtITEnv struct {
	srv      *httptest.Server
	appPool  *pgxpool.Pool
	adminDSN string
	host     string
	port     string
}

func setupJWTEnv(t *testing.T) *jwtITEnv {
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

	runJWTMigrations(t, "pgx5://"+fmt.Sprintf("postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port()))

	appDSN := fmt.Sprintf("postgres://logalot_app:logalot_app@%s:%s/logalot?sslmode=disable", host, port.Port())
	appPool, err := platform.NewPool(ctx, appDSN)
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	t.Cleanup(appPool.Close)

	rc := startRedis(t) // reuses the helper in integration_test.go

	// The edge exactly as main.go wires it: composite(api-key, jwt) over the
	// RLS-governed app pool, the real LogStore searcher, and the real tailbus.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	jwtAuthr, err := authn.NewJWT(jwtTestSecret)
	if err != nil {
		t.Fatalf("NewJWT: %v", err)
	}
	authr := authn.NewComposite(auth.New(appPool, rc), jwtAuthr)

	bus := tailbus.New(rc)
	svc := app.New(bus, app.WithLogger(log))
	searcher := app.NewSearcher(logstore.New(appPool))
	h := NewHandler(svc, searcher, nil, func(context.Context) error { return rc.Ping(ctx).Err() }, log)
	srv := httptest.NewServer(NewRouter(h, authr, log))
	t.Cleanup(srv.Close)

	return &jwtITEnv{
		srv:      srv,
		appPool:  appPool,
		adminDSN: fmt.Sprintf("postgres://postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port()),
		host:     host,
		port:     port.Port(),
	}
}

func runJWTMigrations(t *testing.T, dbURL string) {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	// httpx -> adapters -> internal -> query-service -> services -> repo root.
	migrationsDir := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "..", "migrations")
	m, err := migrate.New("file://"+migrationsDir, dbURL)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}
}

// seedTenant inserts a registry row (tenants has no RLS) via a superuser pool.
func (e *jwtITEnv) seedTenant(t *testing.T, id kernel.TenantID, slug string) {
	t.Helper()
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, e.adminDSN)
	if err != nil {
		t.Fatalf("admin pool: %v", err)
	}
	defer admin.Close()
	_, err = admin.Exec(ctx,
		`INSERT INTO tenants (id, public_id, name, status) VALUES ($1, $2, $3, 'active')
		 ON CONFLICT (id) DO NOTHING`, string(id), slug, slug+" tenant")
	if err != nil {
		t.Fatalf("seed tenant %s: %v", slug, err)
	}
}

// seedLog appends one event for a tenant via the real RLS-armed Append path.
func (e *jwtITEnv) seedLog(t *testing.T, tenant kernel.TenantID, msg string) {
	t.Helper()
	store := logstore.New(e.appPool)
	ev := kernel.LogEvent{
		TS:      time.Now().UTC().Truncate(time.Hour).Add(30 * time.Minute),
		Service: "api", Level: kernel.LevelInfo, Message: msg,
		Labels: map[string]string{"shared": "yes"},
	}
	if err := store.Append(kernel.TenantContext{TenantID: tenant}, context.Background(), ev); err != nil {
		t.Fatalf("seed log (%s): %v", tenant, err)
	}
}

// signControlPlaneJWT mints a token the way control-plane's JoseTokenService does.
func signControlPlaneJWT(t *testing.T, secret string, tenant kernel.TenantID, role kernel.Role) string {
	t.Helper()
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"iss":       jwtIssuer,
		"aud":       jwtAudience,
		"sub":       "55555555-5555-5555-5555-555555555555",
		"tenant_id": string(tenant),
		"role":      string(role),
		"iat":       jwt.NewNumericDate(now),
		"exp":       jwt.NewNumericDate(now.Add(15 * time.Minute)),
	})
	str, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("sign control-plane JWT: %v", err)
	}
	return str
}

// searchMessages performs GET /v1/search with the given Authorization header and
// returns the status and the messages of the returned events.
func (e *jwtITEnv) searchMessages(t *testing.T, authorization string) (int, []string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+"/v1/search?label=shared=yes", nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("search request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil
	}
	var body struct {
		Events []kernel.LogEvent `json:"events"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode search body: %v", err)
	}
	msgs := make([]string, len(body.Events))
	for i, ev := range body.Events {
		msgs[i] = ev.Message
	}
	return resp.StatusCode, msgs
}

func TestIntegration_JWT_SearchAuthorizesAndScopesToTenant(t *testing.T) {
	env := setupJWTEnv(t)
	env.seedTenant(t, jwtTenantA, "alpha")
	env.seedTenant(t, jwtTenantB, "bravo")
	env.seedLog(t, jwtTenantA, "TENANT-A-SECRET")
	env.seedLog(t, jwtTenantB, "TENANT-B-SECRET")

	// A control-plane JWT for tenant A authorizes and sees ONLY A's row.
	tokenA := signControlPlaneJWT(t, jwtTestSecret, jwtTenantA, kernel.RoleMember)
	status, msgs := env.searchMessages(t, "Bearer "+tokenA)
	if status != http.StatusOK {
		t.Fatalf("search as JWT tenant A: status=%d, want 200", status)
	}
	if len(msgs) != 1 || msgs[0] != "TENANT-A-SECRET" {
		t.Fatalf("CROSS-TENANT LEAK: JWT A sees %v, want only [TENANT-A-SECRET]", msgs)
	}
	t.Logf("JWT PROOF: control-plane token for A -> 200, results=%v (claim-derived tenant)", msgs)

	// A JWT for tenant B sees ONLY B's row — tenant comes from the claim, not input.
	tokenB := signControlPlaneJWT(t, jwtTestSecret, jwtTenantB, kernel.RoleMember)
	status, msgs = env.searchMessages(t, "Bearer "+tokenB)
	if status != http.StatusOK {
		t.Fatalf("search as JWT tenant B: status=%d, want 200", status)
	}
	if len(msgs) != 1 || msgs[0] != "TENANT-B-SECRET" {
		t.Fatalf("CROSS-TENANT LEAK: JWT B sees %v, want only [TENANT-B-SECRET]", msgs)
	}
	t.Logf("ISOLATION PROOF: A's token never returns B's rows and vice versa (RLS + claim tenant)")
}

func TestIntegration_JWT_TailAuthorizes(t *testing.T) {
	env := setupJWTEnv(t)
	env.seedTenant(t, jwtTenantA, "alpha")

	token := signControlPlaneJWT(t, jwtTestSecret, jwtTenantA, kernel.RoleMember)
	resp, cancel := openTail(t, env.srv.URL, "text/event-stream", "Bearer "+token)
	defer cancel()
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tail with control-plane JWT: status=%d, want 200 (auth-before-subscribe)", resp.StatusCode)
	}
	t.Logf("TAIL PROOF: control-plane JWT authorizes /v1/tail -> 200")
}

// signCustomJWT mints a token with caller-chosen method/audience/expiry so the
// edge reject cases (expired, alg=none, wrong aud) can be driven end to end.
func signCustomJWT(t *testing.T, method jwt.SigningMethod, secret, audience string, exp time.Time, role kernel.Role) string {
	t.Helper()
	tok := jwt.NewWithClaims(method, jwt.MapClaims{
		"iss":       jwtIssuer,
		"aud":       audience,
		"sub":       "55555555-5555-5555-5555-555555555555",
		"tenant_id": string(jwtTenantA),
		"role":      string(role),
		"iat":       jwt.NewNumericDate(time.Now()),
		"exp":       jwt.NewNumericDate(exp),
	})
	var key any = []byte(secret)
	if method == jwt.SigningMethodNone {
		key = jwt.UnsafeAllowNoneSignatureType
	}
	str, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign custom JWT: %v", err)
	}
	return str
}

// TestIntegration_JWT_RejectsBadTokensAtEdge drives the rejection matrix all the
// way through the edge (composite -> AuthMiddleware -> 401), so the issue's
// accept/reject claims are proven at the HTTP boundary, not just in unit tests.
func TestIntegration_JWT_RejectsBadTokensAtEdge(t *testing.T) {
	env := setupJWTEnv(t)
	env.seedTenant(t, jwtTenantA, "alpha")
	env.seedLog(t, jwtTenantA, "TENANT-A-SECRET")

	now := time.Now()
	cases := []struct {
		name  string
		token string
	}{
		{"foreign-signed", signControlPlaneJWT(t, "totally-wrong-secret-0123456789", jwtTenantA, kernel.RoleMember)},
		{"expired", signCustomJWT(t, jwt.SigningMethodHS256, jwtTestSecret, jwtAudience, now.Add(-time.Hour), kernel.RoleMember)},
		{"alg=none", signCustomJWT(t, jwt.SigningMethodNone, jwtTestSecret, jwtAudience, now.Add(time.Hour), kernel.RoleMember)},
		{"wrong audience", signCustomJWT(t, jwt.SigningMethodHS256, jwtTestSecret, "some-other-app", now.Add(time.Hour), kernel.RoleMember)},
		// platform_operator is structurally barred from tenant log content
		// (kernel/tenant.go); even a perfectly valid token for it must 401 here.
		{"platform_operator barred", signControlPlaneJWT(t, jwtTestSecret, jwtTenantA, kernel.RolePlatformOperator)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if status, _ := env.searchMessages(t, "Bearer "+tc.token); status != http.StatusUnauthorized {
				t.Fatalf("%s: /v1/search status=%d, want 401", tc.name, status)
			}
		})
	}
	t.Logf("REJECTION PROOF: foreign-signed / expired / alg=none / wrong-aud / platform_operator -> 401 at the edge")
}

// The composite must still authorize the legacy `lgk_` API-key path unchanged.
func TestIntegration_APIKeyPathStillWorks(t *testing.T) {
	env := setupJWTEnv(t)
	env.seedTenant(t, jwtTenantA, "alpha")
	env.seedLog(t, jwtTenantA, "TENANT-A-SECRET")

	minted, err := auth.IssueKey(context.Background(), env.appPool, auth.IssueParams{
		TenantID: jwtTenantA,
		PublicID: "alpha",
		Name:     "it key",
	})
	if err != nil {
		t.Fatalf("IssueKey: %v", err)
	}

	status, msgs := env.searchMessages(t, "Bearer "+minted.Plaintext)
	if status != http.StatusOK {
		t.Fatalf("search with lgk_ API key: status=%d, want 200 (composite routes lgk_)", status)
	}
	if len(msgs) != 1 || msgs[0] != "TENANT-A-SECRET" {
		t.Fatalf("API-key search sees %v, want only [TENANT-A-SECRET]", msgs)
	}

	// And via X-API-Key header too (the other extraction path).
	req, _ := http.NewRequest(http.MethodGet, env.srv.URL+"/v1/search?label=shared=yes", nil)
	req.Header.Set("X-API-Key", minted.Plaintext)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("x-api-key request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("X-API-Key search: status=%d, want 200", resp.StatusCode)
	}
	t.Logf("API-KEY PROOF: lgk_ key authorizes via both Bearer and X-API-Key (composite routing intact)")
}
