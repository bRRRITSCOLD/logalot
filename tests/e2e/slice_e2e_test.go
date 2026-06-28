//go:build e2e

// Vertical-slice end-to-end test for issue #9: ingest -> store -> live tail,
// tenant-scoped, with the multi-tenant isolation invariant LOCKED.
//
// It is hermetic: Postgres, Redis and RabbitMQ run as random-port testcontainers
// (the host runs a conflicting `burrow` stack on the standard ports, so fixed
// ports are avoided). It then builds and runs the THREE REAL SERVICE BINARIES
// (ingest-service, processor, query-service) — the exact `main.go` wiring that
// `docker compose` runs — against that infra and drives them over HTTP, so the
// proof exercises the same code paths as production (real Gin routers, real
// RLS-backed API-key auth, real broker/logstore/tailbus adapters).
//
// Gated behind the `e2e` build tag so the default `go test ./...` (and CI's unit
// job) stays Docker-free. Run it with Docker available:
//
//	go test -tags=e2e -run TestSliceE2E ./tests/e2e/...
//
// It proves the slice acceptance criteria (docs spec §"Acceptance criteria (slice)"):
//   - a log POSTed for tenant A appears in tenant A's /v1/tail SSE within 2s;
//   - that event is persisted in log_events under tenant A (RLS-visible to A);
//   - it NEVER appears in tenant B's tail nor in B's rows (the isolation lock);
//   - invalid / unauthenticated ingest is rejected with 401.
package e2e

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/auth"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/logstore"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/jackc/pgx/v5/pgxpool"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcrabbitmq "github.com/testcontainers/testcontainers-go/modules/rabbitmq"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

// Two tenants with fixed UUIDs + slugs. The slug is embedded in the minted API
// key (lgk_<slug>_<keyId>_<secret>) and resolved to the tenant_id during auth.
const (
	idA   = "00000000-0000-0000-0000-00000000000a"
	idB   = "00000000-0000-0000-0000-00000000000b"
	slugA = "alpha"
	slugB = "bravo"
)

// harness holds the running slice: the infra handles plus the two service base
// URLs and the minted per-tenant API keys.
type harness struct {
	appPool   *pgxpool.Pool
	store     *logstore.Store
	ingestURL string
	queryURL  string
	keyA      string // plaintext ingest key for tenant A
	keyB      string // plaintext ingest key for tenant B
}

func TestSliceE2E(t *testing.T) {
	h := setupSlice(t)

	// A canary unique to this run, so a cross-tenant leak is unambiguous.
	canary := fmt.Sprintf("ISOLATION-CANARY-%d", time.Now().UnixNano())

	// --- Open BOTH tenants' tails BEFORE publishing -------------------------
	// pub/sub has no replay, so subscribers must be live first. Tenant B's tail
	// is the leak detector: it must receive NOTHING for A's publish.
	framesA, stopA := openTail(t, h.queryURL, h.keyA)
	defer stopA()
	framesB, stopB := openTail(t, h.queryURL, h.keyB)
	defer stopB()
	time.Sleep(750 * time.Millisecond) // let both SUBSCRIBEs register

	// --- Negative auth: reject before we trust any 202 ----------------------
	t.Run("unauthenticated ingest is rejected 401", func(t *testing.T) {
		code := postIngest(t, h.ingestURL, "", `{"message":"no-auth","level":"info"}`)
		if code != http.StatusUnauthorized {
			t.Fatalf("no-credential ingest status=%d, want 401", code)
		}
		t.Logf("AUTH PROOF: ingest with no credential -> %d", code)
	})
	t.Run("invalid-key ingest is rejected 401", func(t *testing.T) {
		code := postIngest(t, h.ingestURL, "lgk_alpha_bogus_deadbeef", `{"message":"bad-key","level":"info"}`)
		if code != http.StatusUnauthorized {
			t.Fatalf("invalid-key ingest status=%d, want 401", code)
		}
		t.Logf("AUTH PROOF: ingest with a forged/invalid key -> %d", code)
	})

	// --- POST a log for tenant A via the real ingest edge -------------------
	postedAt := time.Now()
	body := fmt.Sprintf(`{"message":%q,"level":"warn","service":"orders","trace_id":"trace-e2e","labels":{"region":"us-east-1"},"order_id":987}`, canary)
	if code := postIngest(t, h.ingestURL, h.keyA, body); code != http.StatusAccepted {
		t.Fatalf("ingest for A status=%d, want 202", code)
	}
	t.Logf("INGEST: POST /v1/ingest (tenant A key) -> 202; canary=%q", canary)

	// --- (a) A's tail receives the event within 2s --------------------------
	t.Run("A receives its event in live tail within 2s", func(t *testing.T) {
		select {
		case msg := <-framesA:
			latency := time.Since(postedAt)
			if !strings.Contains(msg, canary) {
				t.Fatalf("A tail frame = %q, want it to contain the canary", msg)
			}
			if latency > 2*time.Second {
				t.Fatalf("tail latency %s exceeds the 2s ADR-0006 target", latency)
			}
			t.Logf("TAIL RECEIPT: tenant A saw its event in %s (<2s); frame contains canary", latency.Round(time.Millisecond))
		case <-time.After(2 * time.Second):
			t.Fatal("tenant A did not receive its event within 2s (ADR-0006 target)")
		}
	})

	// --- (b) the event is persisted in log_events under tenant A ------------
	t.Run("event is persisted under tenant A (RLS-visible to A)", func(t *testing.T) {
		tcA := kernel.TenantContext{TenantID: kernel.TenantID(idA)}
		rows := waitForRows(t, h.store, tcA, canary)
		row := rows[0]
		if row.TenantID != kernel.TenantID(idA) {
			t.Errorf("row tenant = %q, want %q", row.TenantID, idA)
		}
		if row.Service != "orders" || row.Level != kernel.LevelWarn || row.TraceID != "trace-e2e" {
			t.Errorf("row fields = %+v", row)
		}
		if row.Labels["region"] != "us-east-1" || row.Labels["order_id"] != "987" {
			t.Errorf("row labels = %v (order_id should be coerced to string)", row.Labels)
		}
		t.Logf("PERSIST PROOF: tenant A sees row id=%s msg=%q service=%q level=%q", row.ID, row.Message, row.Service, row.Level)
	})

	// --- (c) THE ISOLATION LOCK: tenant B sees nothing ----------------------
	t.Run("tenant B sees nothing: no tail frame and no rows (isolation lock)", func(t *testing.T) {
		// Give a real drain window AFTER A has already received its event, so a
		// leak across the channel boundary would have had every chance to show.
		deadline := time.After(3 * time.Second)
		for {
			select {
			case msg := <-framesB:
				// A heartbeat/gap frame would not contain the canary; a DATA frame
				// carrying A's event would. Any canary on B's stream is a breach.
				if strings.Contains(msg, canary) {
					t.Fatalf("CROSS-TENANT LEAK: tenant B's tail received A's event: %q", msg)
				}
			case <-deadline:
				goto rowsCheck
			}
		}
	rowsCheck:
		tcB := kernel.TenantContext{TenantID: kernel.TenantID(idB)}
		asB, err := h.store.Tail(tcB, context.Background(), kernel.TailQuery{Limit: 1000})
		if err != nil {
			t.Fatalf("tail as B: %v", err)
		}
		if len(asB) != 0 {
			t.Fatalf("RLS BREACH: tenant B sees %d row(s), want 0", len(asB))
		}
		t.Logf("ISOLATION LOCK: over a 3s drain window tenant B received 0 tail frames carrying the canary AND has 0 rows in log_events")
	})
}

// ---------------------------------------------------------------------------
// Setup: testcontainers infra + migrations + seeded tenants/keys + 3 binaries.
// ---------------------------------------------------------------------------

func setupSlice(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()
	root := repoRoot(t)

	// --- Postgres (migrated; app role is NOSUPERUSER so RLS bites) -----------
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
	pgHost, _ := pgC.Host(ctx)
	pgPort, _ := pgC.MappedPort(ctx, "5432/tcp")
	runMigrations(t, root, fmt.Sprintf("pgx5://postgres:postgres@%s:%s/logalot?sslmode=disable", pgHost, pgPort.Port()))

	adminDSN := fmt.Sprintf("postgres://postgres:postgres@%s:%s/logalot?sslmode=disable", pgHost, pgPort.Port())
	appDSN := fmt.Sprintf("postgres://logalot_app:logalot_app@%s:%s/logalot?sslmode=disable", pgHost, pgPort.Port())

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

	// --- Redis --------------------------------------------------------------
	redisC, err := tcredis.Run(ctx, "redis:7-alpine")
	if err != nil {
		t.Fatalf("start redis: %v", err)
	}
	t.Cleanup(func() { _ = redisC.Terminate(ctx) })
	rHost, _ := redisC.Host(ctx)
	rPort, _ := redisC.MappedPort(ctx, "6379/tcp")

	// --- RabbitMQ -----------------------------------------------------------
	rabbitC, err := tcrabbitmq.Run(ctx, "rabbitmq:3-management-alpine")
	if err != nil {
		t.Fatalf("start rabbitmq: %v", err)
	}
	t.Cleanup(func() { _ = rabbitC.Terminate(ctx) })
	rabbitURL, err := rabbitC.AmqpURL(ctx)
	if err != nil {
		t.Fatalf("amqp url: %v", err)
	}

	// --- Seed two tenants (registry) + mint a key for each ------------------
	seedTenant(t, adminPool, idA, slugA)
	seedTenant(t, adminPool, idB, slugB)
	keyA := issueKey(t, appPool, idA, slugA)
	keyB := issueKey(t, appPool, idB, slugB)

	// --- Shared env for every service process -------------------------------
	infraEnv := map[string]string{
		platform.AppDatabaseURLEnv: appDSN,
		"RABBITMQ_URL":             rabbitURL,
		"REDIS_HOST":               rHost,
		"REDIS_PORT":               rPort.Port(),
		"REDIS_PASSWORD":           "", // testcontainers redis has no auth
	}

	// --- Build + run the three real service binaries ------------------------
	binDir := t.TempDir()
	ingestBin := buildService(t, root, binDir, "ingest-service")
	processorBin := buildService(t, root, binDir, "processor")
	queryBin := buildService(t, root, binDir, "query-service")

	ingestPort := freePort(t)
	queryPort := freePort(t)

	startService(t, "processor", processorBin, infraEnv, nil)
	startService(t, "ingest-service", ingestBin, infraEnv, map[string]string{"INGEST_HTTP_ADDR": ":" + ingestPort})
	// query-service now requires JWT_SECRET to boot (issue #74 — UI session-JWT auth).
	// This e2e exercises the API-key path (keyA/keyB), so the value only needs to
	// satisfy the startup config check (>=16 chars); it isn't used by these assertions.
	startService(t, "query-service", queryBin, infraEnv, map[string]string{
		"QUERY_HTTP_ADDR": ":" + queryPort,
		"JWT_SECRET":      "e2e-test-jwt-secret-0123456789",
	})

	ingestURL := "http://127.0.0.1:" + ingestPort
	queryURL := "http://127.0.0.1:" + queryPort
	waitReady(t, ingestURL+"/readyz")
	waitReady(t, queryURL+"/readyz")

	return &harness{
		appPool:   appPool,
		store:     logstore.New(appPool),
		ingestURL: ingestURL,
		queryURL:  queryURL,
		keyA:      keyA,
		keyB:      keyB,
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	// tests/e2e/slice_e2e_test.go -> repo root is two dirs up.
	return filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))
}

func runMigrations(t *testing.T, root, dbURL string) {
	t.Helper()
	m, err := migrate.New("file://"+filepath.Join(root, "migrations"), dbURL)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}
}

// seedTenant inserts a registry row (tenants has no RLS) via the admin pool.
func seedTenant(t *testing.T, admin *pgxpool.Pool, id, slug string) {
	t.Helper()
	_, err := admin.Exec(context.Background(),
		`INSERT INTO tenants (id, public_id, name, status) VALUES ($1, $2, $3, 'active')
		 ON CONFLICT (id) DO NOTHING`, id, slug, slug+" tenant")
	if err != nil {
		t.Fatalf("seed tenant %s: %v", slug, err)
	}
}

// issueKey mints a combined ingest+read API key for the tenant via the real
// auth path and returns the one-time plaintext (lgk_<slug>_<keyId>_<secret>).
//
// The e2e test uses the same key for both ingest (POST /v1/ingest, requires
// ingest:write) and tail reads (GET /v1/tail, requires logs:read since #82).
// Both scopes are therefore included. A production read-only consumer would
// carry only ['logs:read'].
func issueKey(t *testing.T, appPool *pgxpool.Pool, id, slug string) string {
	t.Helper()
	m, err := auth.IssueKey(context.Background(), appPool, auth.IssueParams{
		TenantID: kernel.TenantID(id),
		PublicID: slug,
		Name:     "e2e key",
		Scopes:   []kernel.Scope{kernel.ScopeIngestWrite, kernel.ScopeLogsRead},
	})
	if err != nil {
		t.Fatalf("IssueKey %s: %v", slug, err)
	}
	return m.Plaintext
}

// buildService compiles services/<name>/cmd/<name> to binDir/<name> using the
// workspace, so the binary is the exact one docker compose would run.
func buildService(t *testing.T, root, binDir, name string) string {
	t.Helper()
	out := filepath.Join(binDir, name)
	cmd := exec.Command("go", "build", "-o", out, "./cmd/"+name)
	cmd.Dir = filepath.Join(root, "services", name)
	// Pin the workspace so the local pkg/* replacements resolve during build.
	cmd.Env = append(os.Environ(), "GOWORK="+filepath.Join(root, "go.work"))
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v\n%s", name, err, b)
	}
	return out
}

// startService runs a built service binary with the merged env and registers a
// cleanup that signals it to stop. stdout/stderr are captured and dumped on a
// test failure so a startup error is diagnosable.
func startService(t *testing.T, name, bin string, base, extra map[string]string) {
	t.Helper()
	env := map[string]string{}
	for k, v := range base {
		env[k] = v
	}
	for k, v := range extra {
		env[k] = v
	}

	cmd := exec.Command(bin)
	cmd.Env = mergeEnv(env)
	var buf syncBuf
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", name, err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _, _ = cmd.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
		}
		if t.Failed() {
			t.Logf("--- %s output ---\n%s", name, buf.String())
		}
	})
}

// mergeEnv overlays overrides onto the parent environment, ensuring each key
// appears once (last value wins) so the child's getenv is unambiguous.
func mergeEnv(overrides map[string]string) []string {
	merged := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			merged[kv[:i]] = kv[i+1:]
		}
	}
	for k, v := range overrides {
		merged[k] = v
	}
	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	return out
}

// waitReady polls url until it returns 200 or the deadline elapses.
func waitReady(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url) //nolint:gosec // fixed localhost probe URL
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("service at %s never became ready", url)
}

// freePort asks the OS for an ephemeral port and returns it as a string. There is
// an inherent TOCTOU window before the service binds it, acceptable for a test.
func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer func() { _ = l.Close() }()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port
}

// ---------------------------------------------------------------------------
// HTTP drivers (the demo's curls, in Go).
// ---------------------------------------------------------------------------

// postIngest POSTs a single JSON event to /v1/ingest and returns the status code.
// An empty key sends no credential (the unauthenticated case).
func postIngest(t *testing.T, baseURL, key, body string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, baseURL+"/v1/ingest", strings.NewReader(body))
	if err != nil {
		t.Fatalf("build ingest request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST ingest: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

// openTail opens an SSE tail for the given key and streams `data:` frames on the
// returned channel until the returned stop func is called.
func openTail(t *testing.T, baseURL, key string) (<-chan string, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/tail", nil)
	if err != nil {
		cancel()
		t.Fatalf("build tail request: %v", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("open tail: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		cancel()
		t.Fatalf("tail status=%d, want 200", resp.StatusCode)
	}
	frames := make(chan string, 64)
	go func() {
		defer close(frames)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			if msg, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				select {
				case frames <- msg:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return frames, func() { cancel(); _ = resp.Body.Close() }
}

// waitForRows polls the hot store under tc until a row carrying the canary is
// visible (the processor persists asynchronously after the broker delivers).
func waitForRows(t *testing.T, store *logstore.Store, tc kernel.TenantContext, canary string) []kernel.LogEvent {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		got, err := store.Tail(tc, context.Background(), kernel.TailQuery{Limit: 100})
		if err != nil {
			t.Fatalf("tail: %v", err)
		}
		for _, ev := range got {
			if strings.Contains(ev.Message, canary) {
				return []kernel.LogEvent{ev}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for the persisted row carrying the canary")
	return nil
}

// syncBuf is a tiny concurrency-safe buffer for capturing child process output
// written from the process's stdout/stderr goroutines.
type syncBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}
