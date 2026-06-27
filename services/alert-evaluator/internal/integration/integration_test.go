//go:build integration

// alert-evaluator integration tests run the evaluator against REAL infrastructure
// in hermetic, random-port testcontainers (the host runs a conflicting stack on
// the standard ports). Gated behind the `integration` build tag so the default
// `go test ./...` stays Docker-free:
//
//	go test -tags=integration ./...
//
// They prove the load-bearing properties fakes cannot — and that map 1:1 to the
// issue's acceptance criteria:
//
//	AC1  A rule crossing its threshold within the window transitions to `firing`
//	     and dispatches EXACTLY ONE notification per transition (no spam while it
//	     stays firing); it transitions back to `resolved` (ok) when it clears,
//	     emitting exactly one resolved notification. Proven against a REAL
//	     Postgres CAS + the alert_notifications outbox.
//	AC2  The evaluator reads log content ONLY under the rule's tenant RLS context.
//	     (a) The BYPASSRLS scheduler role (logalot_evaluator) is DENIED on
//	     log_events (permission denied), so the metadata scan cannot expose log
//	     content. (b) LogCounter (logalot_app) counts ONLY the armed tenant's rows
//	     — another tenant's context sees a different count.
//	AC3  Evaluation latency is < 30s on the test setup.
//
// A separate, SKIPPABLE test exercises the floci SNS/SQS dispatch path end-to-end
// (publish -> SQS subscription), since floci AWS fidelity is a tracked risk.
package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awscreds "github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/adapters/notify"
	pgadapter "github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/adapters/postgres"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

const (
	tenantA = "00000000-0000-0000-0000-00000000000a"
	tenantB = "00000000-0000-0000-0000-00000000000b"
	ruleAID = "11111111-1111-1111-1111-11111111111a"
)

type itEnv struct {
	adminPool *pgxpool.Pool // postgres superuser — seeds (bypasses RLS)
	metaPool  *pgxpool.Pool // logalot_evaluator (BYPASSRLS) — scheduling metadata
	appPool   *pgxpool.Pool // logalot_app (NOSUPERUSER) — RLS log reads/writes
}

func setup(t *testing.T) *itEnv {
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

	mk := func(user string) *pgxpool.Pool {
		dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/logalot?sslmode=disable", user, user, host, port.Port())
		p, perr := platform.NewPool(ctx, dsn)
		if perr != nil {
			t.Fatalf("pool %s: %v", user, perr)
		}
		t.Cleanup(p.Close)
		return p
	}
	adminDSN := fmt.Sprintf("postgres://postgres:postgres@%s:%s/logalot?sslmode=disable", host, port.Port())
	adminPool, err := platform.NewPool(ctx, adminDSN)
	if err != nil {
		t.Fatalf("admin pool: %v", err)
	}
	t.Cleanup(adminPool.Close)

	return &itEnv{
		adminPool: adminPool,
		metaPool:  mk("logalot_evaluator"),
		appPool:   mk("logalot_app"),
	}
}

func runMigrations(t *testing.T, dbURL string) {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	// internal/integration -> alert-evaluator -> services -> repo root -> migrations
	dir := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "migrations")
	m, err := migrate.New("file://"+dir, dbURL)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}
}

// ── seeding helpers ───────────────────────────────────────────────────────────

func (e *itEnv) seedTenant(t *testing.T, id, slug string) {
	t.Helper()
	_, err := e.adminPool.Exec(context.Background(),
		`INSERT INTO tenants (id, public_id, name, status) VALUES ($1,$2,$3,'active')
		 ON CONFLICT (id) DO NOTHING`, id, slug, slug)
	if err != nil {
		t.Fatalf("seed tenant %s: %v", slug, err)
	}
}

// seedRule inserts an alert rule (gt threshold over window) via the superuser
// (bypasses RLS) — the control-plane would do this as logalot_app under RLS.
func (e *itEnv) seedRule(t *testing.T, id, tenant, name string, threshold float64, windowSeconds int, query app.RuleQuery) {
	t.Helper()
	q, _ := json.Marshal(query)
	_, err := e.adminPool.Exec(context.Background(),
		`INSERT INTO alert_rules (id, tenant_id, name, query, comparator, threshold, window_seconds, severity, enabled, state)
		 VALUES ($1,$2,$3,$4::jsonb,'gt',$5,$6,'critical',true,'ok')`,
		id, tenant, name, string(q), threshold, windowSeconds)
	if err != nil {
		t.Fatalf("seed rule %s: %v", name, err)
	}
}

// insertLog writes a log_events row for tenant under RLS (as logalot_app), exactly
// like the processor's write path, so RLS WITH CHECK governs it.
func (e *itEnv) insertLog(t *testing.T, tenant string, ts time.Time, level kernel.Level, message string) {
	t.Helper()
	ctx := context.Background()
	tx, err := e.appPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin insert: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
		t.Fatalf("arm tenant: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO log_events (tenant_id, ts, service, level, message, labels)
		 VALUES ($1::uuid, $2, 'billing', $3::log_level, $4, '{}'::jsonb)`,
		tenant, ts.UTC(), string(level), message); err != nil {
		t.Fatalf("insert log: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit insert: %v", err)
	}
}

func (e *itEnv) countNotifications(t *testing.T, tenant, ruleID string) int {
	t.Helper()
	var n int
	if err := e.adminPool.QueryRow(context.Background(),
		`SELECT count(*) FROM alert_notifications WHERE tenant_id=$1 AND rule_id=$2`, tenant, ruleID).Scan(&n); err != nil {
		t.Fatalf("count notifications: %v", err)
	}
	return n
}

// settableClock is a test clock the evaluator reads; the test advances it to move
// the rolling window past previously-inserted logs (drives firing -> resolved).
type settableClock struct{ v atomic.Int64 }

func (c *settableClock) set(ts time.Time) { c.v.Store(ts.UnixNano()) }
func (c *settableClock) now() time.Time   { return time.Unix(0, c.v.Load()).UTC() }

// ── AC2: tenant isolation ─────────────────────────────────────────────────────

func TestIntegration_EvaluatorBypassrlsRole_CannotReadLogContent(t *testing.T) {
	e := setup(t)
	e.seedTenant(t, tenantA, "tenant-a")
	e.insertLog(t, tenantA, time.Now(), kernel.LevelError, "secret content for A")

	// The BYPASSRLS scheduler role bypasses RLS but has NO grant on log_events, so
	// the read fails permission-denied — it can never reach tenant log content.
	var n int
	err := e.metaPool.QueryRow(context.Background(), `SELECT count(*) FROM log_events`).Scan(&n)
	if err == nil {
		t.Fatalf("BYPASSRLS evaluator role read log_events (got %d rows) — ISOLATION BREACH; expected permission denied", n)
	}
	t.Logf("AC2(a) PROOF: logalot_evaluator denied on log_events: %v", err)

	// Sanity: the same role CAN read the scheduling metadata it is granted.
	if err := e.metaPool.QueryRow(context.Background(), `SELECT count(*) FROM alert_rules`).Scan(&n); err != nil {
		t.Fatalf("evaluator role must be able to read alert_rules metadata: %v", err)
	}
	t.Logf("AC2(a) PROOF: logalot_evaluator CAN read alert_rules metadata (%d rows)", n)
}

func TestIntegration_LogCounter_CountsOnlyArmedTenantUnderRLS(t *testing.T) {
	e := setup(t)
	e.seedTenant(t, tenantA, "tenant-a")
	e.seedTenant(t, tenantB, "tenant-b")
	now := time.Now().UTC()
	// Tenant A: 3 errors. Tenant B: 1 error.
	for i := 0; i < 3; i++ {
		e.insertLog(t, tenantA, now.Add(-time.Duration(i)*time.Second), kernel.LevelError, "A error")
	}
	e.insertLog(t, tenantB, now, kernel.LevelError, "B error")

	counter := pgadapter.NewLogCounter(e.appPool)
	lvl := kernel.LevelError
	q := app.RuleQuery{Level: &lvl}
	from, to := now.Add(-time.Hour), now.Add(time.Minute)

	gotA, err := counter.Count(kernel.TenantContext{TenantID: tenantA}, context.Background(), q, from, to)
	if err != nil {
		t.Fatalf("count A: %v", err)
	}
	gotB, err := counter.Count(kernel.TenantContext{TenantID: tenantB}, context.Background(), q, from, to)
	if err != nil {
		t.Fatalf("count B: %v", err)
	}
	if gotA != 3 {
		t.Fatalf("tenant A count = %d, want 3", gotA)
	}
	if gotB != 1 {
		t.Fatalf("tenant B count = %d, want 1 (A's rows invisible under B's RLS context)", gotB)
	}
	t.Logf("AC2(b) PROOF: LogCounter under RLS — A sees 3, B sees 1 (no cross-tenant bleed)")

	// Fail-closed: a blank tenant context is rejected before any count runs.
	if _, err := counter.Count(kernel.TenantContext{}, context.Background(), q, from, to); err == nil {
		t.Fatal("blank tenant context must fail closed")
	}
}

// ── AC1 + AC3: fire-once / resolve-once + latency, against real Postgres ──────

func TestIntegration_RuleCrossesThreshold_FiresOnceThenResolvesOnce(t *testing.T) {
	e := setup(t)
	e.seedTenant(t, tenantA, "tenant-a")
	lvl := kernel.LevelError
	e.seedRule(t, ruleAID, tenantA, "too many errors", 5, 300, app.RuleQuery{Level: &lvl})

	base := time.Now().UTC()
	// 9 errors within the window (> threshold 5).
	for i := 0; i < 9; i++ {
		e.insertLog(t, tenantA, base.Add(-time.Duration(i)*time.Second), kernel.LevelError, "boom")
	}

	clock := &settableClock{}
	clock.set(base.Add(time.Minute)) // window [base-4m, base+1m) includes the 9 logs
	sink := notify.NewLogSink(nil)
	ev := app.New(
		pgadapter.NewRuleStore(e.metaPool),
		pgadapter.NewLogCounter(e.appPool),
		sink,
		app.WithClock(clock.now),
		app.WithInterval(10*time.Second),
	)
	ctx := context.Background()

	// Cycle 1: breach -> firing + exactly one notification. Also AC3: under 30s.
	start := time.Now()
	if _, err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("cycle 1: %v", err)
	}
	latency := time.Since(start)
	if latency >= 30*time.Second {
		t.Fatalf("AC3: evaluation latency %s exceeds 30s", latency)
	}
	if sink.CountTo(app.StateFiring) != 1 {
		t.Fatalf("AC1: firing notifications = %d, want 1", sink.CountTo(app.StateFiring))
	}
	if got := e.countNotifications(t, tenantA, ruleAID); got != 1 {
		t.Fatalf("AC1: outbox rows = %d, want 1", got)
	}
	t.Logf("AC1 PROOF: breach -> firing + 1 notification (eval latency %s, AC3 < 30s)", latency)

	// Cycles 2-3: still breaching -> NO new notifications (no spam while firing).
	clock.set(base.Add(2 * time.Minute))
	if _, err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("cycle 2: %v", err)
	}
	clock.set(base.Add(3 * time.Minute))
	if _, err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("cycle 3: %v", err)
	}
	if sink.CountTo(app.StateFiring) != 1 {
		t.Fatalf("AC1: firing notifications after sustained breach = %d, want still 1 (no spam)", sink.CountTo(app.StateFiring))
	}
	t.Logf("AC1 PROOF: 2 more sustained-breach cycles emitted 0 additional notifications")

	// Cycle 4: advance the clock 1h so the window no longer covers the logs ->
	// count drops to 0 -> resolved, exactly one resolved notification.
	clock.set(base.Add(time.Hour))
	if _, err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("cycle 4: %v", err)
	}
	if sink.CountTo(app.StateOK) != 1 {
		t.Fatalf("AC1: resolved notifications = %d, want 1", sink.CountTo(app.StateOK))
	}
	if got := e.countNotifications(t, tenantA, ruleAID); got != 2 {
		t.Fatalf("AC1: total outbox rows = %d, want 2 (1 firing + 1 resolved)", got)
	}
	t.Logf("AC1 PROOF: window cleared -> resolved + exactly 1 resolved notification (2 outbox rows total)")
}

// ── floci SNS/SQS dispatch (skippable — floci AWS fidelity is a tracked risk) ──

func TestIntegration_FlociSNSDispatch_DeliversNotificationToSQS(t *testing.T) {
	ctx := context.Background()

	flociC, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "floci/floci:1.5.28",
			ExposedPorts: []string{"4566/tcp"},
			Env: map[string]string{
				"FLOCI_STORAGE_MODE":    "memory",
				"AWS_REGION":            "us-east-1",
				"AWS_DEFAULT_REGION":    "us-east-1",
				"AWS_ACCESS_KEY_ID":     "test",
				"AWS_SECRET_ACCESS_KEY": "test",
			},
			WaitingFor: wait.ForHTTP("/_floci/health").WithPort("4566/tcp").WithStartupTimeout(90 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		t.Skipf("floci unavailable (AWS-local fidelity is a tracked risk): %v", err)
	}
	t.Cleanup(func() { _ = flociC.Terminate(ctx) })
	host, _ := flociC.Host(ctx)
	port, _ := flociC.MappedPort(ctx, "4566/tcp")
	endpoint := fmt.Sprintf("http://%s:%s", host, port.Port())

	creds := awscreds.NewStaticCredentialsProvider("test", "test", "")
	snsClient := sns.New(sns.Options{Region: "us-east-1", Credentials: creds, BaseEndpoint: aws.String(endpoint)})
	sqsClient := sqs.New(sqs.Options{Region: "us-east-1", Credentials: creds, BaseEndpoint: aws.String(endpoint)})

	topic, err := snsClient.CreateTopic(ctx, &sns.CreateTopicInput{Name: aws.String("logalot-alerts")})
	if err != nil {
		t.Skipf("floci SNS CreateTopic unsupported: %v", err)
	}
	queue, err := sqsClient.CreateQueue(ctx, &sqs.CreateQueueInput{QueueName: aws.String("logalot-alerts-q")})
	if err != nil {
		t.Skipf("floci SQS CreateQueue unsupported: %v", err)
	}
	attrs, err := sqsClient.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl:       queue.QueueUrl,
		AttributeNames: []sqstypes.QueueAttributeName{"QueueArn"},
	})
	if err != nil {
		t.Skipf("floci SQS GetQueueAttributes unsupported: %v", err)
	}
	queueArn := attrs.Attributes["QueueArn"]
	if _, err := snsClient.Subscribe(ctx, &sns.SubscribeInput{
		TopicArn: topic.TopicArn,
		Protocol: aws.String("sqs"),
		Endpoint: aws.String(queueArn),
		Attributes: map[string]string{
			"RawMessageDelivery": "true",
		},
	}); err != nil {
		t.Skipf("floci SNS Subscribe(sqs) unsupported: %v", err)
	}

	// Dispatch a firing notification through the real SNS notifier adapter.
	notifier := notify.NewSNS(snsClient, *topic.TopicArn, nil)
	n := app.Notification{
		ID: "n-1", TenantID: tenantA, RuleID: ruleAID, RuleName: "too many errors",
		TransitionSeq: 1, ToState: app.StateFiring, Severity: "critical",
		ObservedCount: 9, Threshold: 5, OccurredAt: time.Now().UTC(),
	}
	if err := notifier.Notify(ctx, n); err != nil {
		t.Fatalf("SNS notify: %v", err)
	}

	// Poll the SQS subscription for the delivered message.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		out, rerr := sqsClient.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:            queue.QueueUrl,
			MaxNumberOfMessages: 1,
			WaitTimeSeconds:     2,
		})
		if rerr != nil {
			t.Skipf("floci SQS ReceiveMessage unsupported: %v", rerr)
		}
		if len(out.Messages) > 0 {
			body := *out.Messages[0].Body
			if !contains(body, ruleAID) || !contains(body, "firing") {
				t.Fatalf("SQS message missing rule/kind: %s", body)
			}
			t.Logf("FLOCI PROOF: SNS->SQS delivered the firing notification: %s", body)
			return
		}
	}
	t.Fatal("notification never arrived on the SQS subscription within 20s")
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
