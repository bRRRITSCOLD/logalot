//go:build integration

// Processor integration tests run the FULL slice through real infrastructure in
// hermetic, random-port testcontainers (the host runs a conflicting stack on the
// standard ports, so fixed ports are avoided). Gated behind the `integration`
// build tag so the default `go test ./...` stays Docker-free:
//
//	go test -tags=integration ./...
//
// They prove the load-bearing properties fakes cannot:
//   - an ingest envelope flows broker -> processor -> a real RLS-governed row;
//   - RLS isolation: that row is INVISIBLE when armed as a different tenant;
//   - the event is PUBLISHed to tail:{tenant_id} and a subscriber receives it;
//   - a poison message lands in the DLQ.
//
// The application connects as the NOSUPERUSER logalot_app role so FORCE ROW LEVEL
// SECURITY actually bites (mirrors the auth integration test).
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/broker"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/logstore"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/pkg/tailbus"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/redis/go-redis/v9"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcrabbitmq "github.com/testcontainers/testcontainers-go/modules/rabbitmq"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

const (
	idA = "00000000-0000-0000-0000-00000000000a"
	idB = "00000000-0000-0000-0000-00000000000b"
)

type itEnv struct {
	appPool   *pgxpool.Pool
	rc        *redis.Client
	rabbitURL string
	store     *logstore.Store
	tail      *tailbus.Bus
}

func setup(t *testing.T) *itEnv {
	t.Helper()
	ctx := context.Background()

	// --- Postgres (migrated, NOSUPERUSER app role) ---------------------------
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
	runMigrations(t, "pgx5://"+fmt.Sprintf("postgres:postgres@%s:%s/logalot?sslmode=disable", pgHost, pgPort.Port()))

	appDSN := fmt.Sprintf("postgres://logalot_app:logalot_app@%s:%s/logalot?sslmode=disable", pgHost, pgPort.Port())
	appPool, err := platform.NewPool(ctx, appDSN)
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	t.Cleanup(appPool.Close)

	// --- Redis ---------------------------------------------------------------
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

	// --- RabbitMQ ------------------------------------------------------------
	rabbitC, err := tcrabbitmq.Run(ctx, "rabbitmq:3-management-alpine")
	if err != nil {
		t.Fatalf("start rabbitmq: %v", err)
	}
	t.Cleanup(func() { _ = rabbitC.Terminate(ctx) })
	rabbitURL, err := rabbitC.AmqpURL(ctx)
	if err != nil {
		t.Fatalf("amqp url: %v", err)
	}

	return &itEnv{
		appPool:   appPool,
		rc:        rc,
		rabbitURL: rabbitURL,
		store:     logstore.New(appPool),
		tail:      tailbus.New(rc),
	}
}

func runMigrations(t *testing.T, dbURL string) {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	migrationsDir := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "migrations")
	m, err := migrate.New("file://"+migrationsDir, dbURL)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}
}

// startProcessor wires the real broker -> processor -> logstore/tailbus pipeline
// and runs it until the returned cancel is called.
func (e *itEnv) startProcessor(t *testing.T) (context.CancelFunc, *broker.Broker) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())

	b, err := broker.New(ctx, e.rabbitURL)
	if err != nil {
		cancel()
		t.Fatalf("broker.New: %v", err)
	}
	svc := New(e.store, e.tail, WithRetry(3, 50*time.Millisecond))
	go func() {
		_ = b.Consume(kernel.TenantContext{Role: kernel.RolePlatformOperator}, ctx, svc.Handle)
	}()
	t.Cleanup(func() { cancel(); _ = b.Close() })
	return cancel, b
}

func (e *itEnv) publish(t *testing.T, tenant kernel.TenantID, raw string) {
	t.Helper()
	b, err := broker.New(context.Background(), e.rabbitURL)
	if err != nil {
		t.Fatalf("publisher broker: %v", err)
	}
	defer func() { _ = b.Close() }()
	tc := kernel.TenantContext{TenantID: tenant, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
	env := kernel.Envelope{TenantID: tenant, ReceivedAt: time.Now().UTC(), Raw: json.RawMessage(raw)}
	if err := b.Publish(tc, context.Background(), env); err != nil {
		t.Fatalf("publish: %v", err)
	}
}

func TestIntegration_EndToEnd_PersistRLSAndTail(t *testing.T) {
	env := setup(t)
	env.startProcessor(t)

	tcA := kernel.TenantContext{TenantID: kernel.TenantID(idA)}
	tcB := kernel.TenantContext{TenantID: kernel.TenantID(idB)}
	ctx := context.Background()

	// Subscribe to tenant A's tail BEFORE publishing (pub/sub has no replay).
	tailCh, err := env.tail.Subscribe(tcA, ctx)
	if err != nil {
		t.Fatalf("tail subscribe: %v", err)
	}
	time.Sleep(500 * time.Millisecond) // let the SUBSCRIBE register

	// Publish an ingest envelope for tenant A.
	env.publish(t, kernel.TenantID(idA), `{
		"message":"checkout completed","level":"warn","service":"orders",
		"trace_id":"trace-xyz","labels":{"region":"us-east-1"},"order_id":987
	}`)

	// (3) Tail receipt: the subscriber on tail:{A} receives the event.
	select {
	case ev := <-tailCh:
		if ev.TenantID != kernel.TenantID(idA) {
			t.Errorf("tail event tenant = %q, want %q", ev.TenantID, idA)
		}
		if ev.Message != "checkout completed" || ev.Level != kernel.LevelWarn {
			t.Errorf("tail event = %+v", ev)
		}
		t.Logf("TAIL RECEIPT: received event on tail:%s msg=%q level=%q labels=%v", idA, ev.Message, ev.Level, ev.Labels)
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for tail event")
	}

	// (1) Persist proof: the row is visible under tenant A's RLS context.
	got := waitForTail(t, env.store, tcA, 1)
	row := got[0]
	if row.TenantID != kernel.TenantID(idA) {
		t.Errorf("row tenant = %q, want %q", row.TenantID, idA)
	}
	if row.Message != "checkout completed" || row.Service != "orders" || row.Level != kernel.LevelWarn {
		t.Errorf("row fields = %+v", row)
	}
	if row.TraceID != "trace-xyz" {
		t.Errorf("row trace_id = %q", row.TraceID)
	}
	if row.Labels["region"] != "us-east-1" || row.Labels["order_id"] != "987" {
		t.Errorf("row labels = %v (order_id coerced to string expected)", row.Labels)
	}
	t.Logf("PERSIST PROOF: tenant A sees row id=%s msg=%q service=%q level=%q", row.ID, row.Message, row.Service, row.Level)

	// (2) RLS PROOF: the same row is INVISIBLE under tenant B's context.
	asB, err := env.store.Tail(tcB, ctx, kernel.TailQuery{Limit: 100})
	if err != nil {
		t.Fatalf("tail as B: %v", err)
	}
	if len(asB) != 0 {
		t.Fatalf("RLS BREACH: tenant B sees %d rows, want 0", len(asB))
	}
	t.Logf("RLS PROOF: tenant B sees 0 rows (A's event is invisible cross-tenant)")
}

func TestIntegration_PoisonMessageLandsInDLQ(t *testing.T) {
	env := setup(t)
	env.startProcessor(t)

	// A valid envelope whose Raw cannot be normalized at all (a JSON scalar, not an
	// object) is poison: the handler returns immediately, the broker nacks without
	// requeue, and the message dead-letters.
	env.publish(t, kernel.TenantID(idA), `"this is not a log object"`)

	conn, err := amqp.Dial(env.rabbitURL)
	if err != nil {
		t.Fatalf("dial dlq: %v", err)
	}
	defer func() { _ = conn.Close() }()
	ch, err := conn.Channel()
	if err != nil {
		t.Fatalf("dlq channel: %v", err)
	}
	defer func() { _ = ch.Close() }()

	dlq := broker.DefaultTopology().DeadLetterQueue
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		msg, ok, gerr := ch.Get(dlq, true)
		if gerr != nil {
			t.Fatalf("get dlq: %v", gerr)
		}
		if ok {
			var got kernel.Envelope
			if jerr := json.Unmarshal(msg.Body, &got); jerr != nil {
				t.Fatalf("decode dlq body: %v", jerr)
			}
			if got.TenantID != kernel.TenantID(idA) {
				t.Errorf("dlq message tenant = %q, want %q", got.TenantID, idA)
			}
			t.Logf("DLQ PROOF: poison message captured on %s (tenant=%s raw=%s)", dlq, got.TenantID, string(got.Raw))
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("poison message never reached the DLQ %q", dlq)
}

// waitForTail polls the hot store until at least want rows are visible under tc or
// it times out (the processor persists asynchronously after the broker delivers).
func waitForTail(t *testing.T, store *logstore.Store, tc kernel.TenantContext, want int) []kernel.LogEvent {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		got, err := store.Tail(tc, context.Background(), kernel.TailQuery{Limit: 100})
		if err != nil {
			t.Fatalf("tail: %v", err)
		}
		if len(got) >= want {
			return got
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d persisted row(s)", want)
	return nil
}
