//go:build cold_smoke_aws

// Real-AWS cold-tier smoke test (decision 016 §7). This is the artifact that
// decision 016 §6 makes the gate for ever flipping COLD_ENABLED=true, so it must
// genuinely exercise Athena (NOT just the local fitness function).
//
// Canary sequence (all must pass before COLD_ENABLED=true is merged to main):
//
//  1. EnsureGlueTable        — provisions the external table with injected-projection DDL.
//  2. WriteParquet           — writes a known batch to S3 via coldstore.Archive.
//  3. GluePartitionRegistered— confirms CreatePartition via GetPartition.
//  4. Athena_BoundTenant     — Store.Search (fitness-gated) → ATHENA → assert the written rows return.
//  5. Athena_NoTenant_MustFail — RAW no-tenant SQL submitted to ATHENA → assert it FAILS
//     (injected projection: CONSTRAINT_VIOLATION). Bypasses the fitness
//     gate on purpose to prove the ENGINE enforces tenant scoping.
//  6. Athena_WrongTenant_ZeroRows — RAW SQL for a different tenant_id → ATHENA returns zero rows.
//  7. Athena_Dialect         — regexp_like + json_extract_scalar + from_unixtime → prove dialect.
//  8. FitnessGate_* (local)  — the app-side backstop; NOT a substitute for the Athena canaries.
//
// Without real AWS credentials/resources the test skips cleanly (loadSmokeEnv).
package coldtiersmoke

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/athena"
	athtypes "github.com/aws/aws-sdk-go-v2/service/athena/types"
	awsglue "github.com/aws/aws-sdk-go-v2/service/glue"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/coldstore"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const (
	smokeTenant  = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
	smokeOther   = "00000000-0000-0000-0000-000000000000"
	smokeService = "cold-tier-smoke"
)

// smokeEnv holds resolved environment configuration for the smoke test.
type smokeEnv struct {
	bucket        string
	glueDB        string
	athenaResults string
	workgroup     string
	region        string
}

// loadSmokeEnv resolves config and SKIPS the test cleanly when the required AWS
// resource env vars are absent (so normal CI / local runs don't fail). When the
// vars ARE present (the gated AWS workflow), every assertion is enforced.
func loadSmokeEnv(t *testing.T) smokeEnv {
	t.Helper()
	required := []string{"COLD_BUCKET", "COLD_GLUE_DB", "COLD_ATHENA_RESULT_BUCKET"}
	for _, k := range required {
		if os.Getenv(k) == "" {
			t.Skipf("skipping real-AWS smoke: %s not set (requires real AWS creds + resources)", k)
		}
	}
	def := func(key, d string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return d
	}
	return smokeEnv{
		bucket:        os.Getenv("COLD_BUCKET"),
		glueDB:        os.Getenv("COLD_GLUE_DB"),
		athenaResults: os.Getenv("COLD_ATHENA_RESULT_BUCKET"),
		workgroup:     def("COLD_ATHENA_WORKGROUP", "primary"),
		region:        def("AWS_REGION", "us-east-1"),
	}
}

// TestColdTierSmoke_AWS is the real-AWS smoke test entry point.
func TestColdTierSmoke_AWS(t *testing.T) {
	env := loadSmokeEnv(t)
	ctx := context.Background()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(env.region))
	if err != nil {
		t.Fatalf("aws config: %v", err)
	}

	s3Client := s3.NewFromConfig(awsCfg)
	glueClient := awsglue.NewFromConfig(awsCfg)
	athenaClient := athena.NewFromConfig(awsCfg)

	// The smoke Store has Athena wired AND search enabled — this is the only
	// place cold search is turned on, precisely to validate it before the flag
	// flips in production (decision 016 §6).
	store := coldstore.New(
		s3Client, glueClient, athenaClient,
		env.bucket, env.glueDB, env.athenaResults,
		coldstore.WithWorkgroup(env.workgroup),
		coldstore.WithSearchEnabled(true),
	)

	runner := &athenaRunner{
		client:    athenaClient,
		db:        env.glueDB,
		workgroup: env.workgroup,
		output:    env.athenaResults,
	}

	tc := kernel.TenantContext{TenantID: smokeTenant}
	smokeTime := time.Now().UTC().Truncate(time.Hour)

	t.Run("EnsureGlueTable", func(t *testing.T) {
		if err := coldstore.EnsureGlueTable(ctx, glueClient, env.glueDB, env.bucket); err != nil {
			t.Fatalf("EnsureGlueTable: %v", err)
		}
		t.Logf("PASS: Glue table provisioned (db=%s, location=s3://%s/logs/)", env.glueDB, env.bucket)
	})

	t.Run("WriteParquet", func(t *testing.T) {
		testSmokeWriteParquet(t, ctx, store, tc, smokeTime)
	})

	t.Run("GluePartitionRegistered", func(t *testing.T) {
		testSmokeGluePartition(t, ctx, glueClient, env, tc, smokeTime)
	})

	t.Run("Athena_BoundTenant_ReturnsRows", func(t *testing.T) {
		testAthenaBoundTenant(t, ctx, store, tc)
	})

	t.Run("Athena_NoTenant_MustFailConstraint", func(t *testing.T) {
		testAthenaNoTenantFails(t, ctx, runner, env)
	})

	t.Run("Athena_WrongTenant_ZeroRows", func(t *testing.T) {
		testAthenaWrongTenantZeroRows(t, ctx, runner, env)
	})

	t.Run("Athena_DialectConstructs", func(t *testing.T) {
		testAthenaDialect(t, ctx, runner, env)
	})

	t.Run("FitnessGate_NoTenant_MustFail", func(t *testing.T) {
		sql := fmt.Sprintf("SELECT ts FROM %s.log_events WHERE ts > 0 LIMIT 10", env.glueDB)
		if err := coldstore.CheckTenantPredicate(sql, smokeTenant); err == nil {
			t.Fatal("local fitness gate PASSED a no-tenant query — fail-closed violated")
		}
	})

	t.Run("FitnessGate_WrongTenant_MustFail", func(t *testing.T) {
		sql := fmt.Sprintf("SELECT ts FROM %s.log_events WHERE tenant_id = '%s' LIMIT 1", env.glueDB, smokeOther)
		if err := coldstore.CheckTenantPredicate(sql, smokeTenant); err == nil {
			t.Fatal("local fitness gate PASSED a cross-tenant query — fail-closed violated")
		}
	})
}

// ---------------------------------------------------------------------------
// Athena canary sub-tests
// ---------------------------------------------------------------------------

func testSmokeWriteParquet(t *testing.T, ctx context.Context,
	store *coldstore.Store, tc kernel.TenantContext, at time.Time) {
	t.Helper()
	events := []kernel.LogEvent{
		{TenantID: tc.TenantID, TS: at, ID: "smoke-001", Service: smokeService,
			Level: kernel.LevelInfo, Message: "smoke canary 1", Labels: map[string]string{"region": "us-east-1"}},
		{TenantID: tc.TenantID, TS: at.Add(time.Minute), ID: "smoke-002", Service: smokeService,
			Level: kernel.LevelWarn, Message: "smoke canary 2", Labels: map[string]string{"region": "us-east-1"}},
	}
	if err := store.Archive(tc, ctx, events...); err != nil {
		t.Fatalf("Archive: %v", err)
	}
	t.Logf("PASS: archived %d events under tenant_id=%s", len(events), tc.TenantID)
}

func testSmokeGluePartition(t *testing.T, ctx context.Context,
	gc *awsglue.Client, env smokeEnv, tc kernel.TenantContext, at time.Time) {
	t.Helper()
	dt := at.Format("2006-01-02")
	hour := fmt.Sprintf("%02d", at.Hour())

	got, err := gc.GetPartition(ctx, &awsglue.GetPartitionInput{
		DatabaseName:    aws.String(env.glueDB),
		TableName:       aws.String("log_events"),
		PartitionValues: []string{string(tc.TenantID), dt, hour},
	})
	if err != nil {
		t.Fatalf("GetPartition [%s,%s,%s]: %v", tc.TenantID, dt, hour, err)
	}
	t.Logf("PASS: Glue partition registered: %v", got.Partition.Values)
}

// testAthenaBoundTenant runs the production read path (Store.Search → fitness
// gate → Athena) and asserts the written rows come back.
func testAthenaBoundTenant(t *testing.T, ctx context.Context, store *coldstore.Store, tc kernel.TenantContext) {
	t.Helper()
	page, err := store.Search(tc, ctx, kernel.SearchQuery{Limit: 50})
	if err != nil {
		t.Fatalf("Store.Search (bound tenant): %v", err)
	}
	if len(page.Events) == 0 {
		t.Fatal("bound-tenant Athena query returned 0 rows; expected the written canary rows")
	}
	for _, ev := range page.Events {
		if !strings.HasPrefix(ev.ID, "smoke-") {
			t.Errorf("unexpected row id=%q in tenant-scoped result", ev.ID)
		}
	}
	t.Logf("PASS: bound-tenant Athena query returned %d rows", len(page.Events))
}

// testAthenaNoTenantFails submits RAW no-tenant SQL directly to Athena and
// asserts the query FAILS because the injected tenant_id projection requires an
// equality predicate (CONSTRAINT_VIOLATION). Bypasses the local fitness gate on
// purpose — it validates the ENGINE-enforced guard.
func testAthenaNoTenantFails(t *testing.T, ctx context.Context, r *athenaRunner, env smokeEnv) {
	t.Helper()
	sql := fmt.Sprintf("SELECT ts, id FROM %s.log_events WHERE dt >= '2026-01-01' LIMIT 10", env.glueDB)
	res, err := r.run(ctx, sql)
	if err != nil {
		t.Fatalf("athena run (no-tenant): %v", err)
	}
	if res.state == string(athtypes.QueryExecutionStateSucceeded) {
		t.Fatalf("Athena ACCEPTED a no-tenant query — injected projection not enforced (got %d rows)", len(res.rows))
	}
	reason := strings.ToUpper(res.reason)
	if !strings.Contains(reason, "CONSTRAINT") && !strings.Contains(reason, "TENANT_ID") &&
		!strings.Contains(reason, "PROJECT") && !strings.Contains(reason, "PARTITION") {
		t.Fatalf("Athena failed but not with a tenant/constraint reason: state=%s reason=%q", res.state, res.reason)
	}
	t.Logf("PASS: Athena rejected no-tenant query: state=%s reason=%q", res.state, res.reason)
}

// testAthenaWrongTenantZeroRows submits a RAW query for a DIFFERENT tenant_id
// (valid predicate, no data under that prefix) and asserts zero rows.
func testAthenaWrongTenantZeroRows(t *testing.T, ctx context.Context, r *athenaRunner, env smokeEnv) {
	t.Helper()
	sql := fmt.Sprintf("SELECT ts, id FROM %s.log_events WHERE tenant_id = '%s' LIMIT 10", env.glueDB, smokeOther)
	res, err := r.run(ctx, sql)
	if err != nil {
		t.Fatalf("athena run (wrong-tenant): %v", err)
	}
	if res.state != string(athtypes.QueryExecutionStateSucceeded) {
		t.Fatalf("wrong-tenant query did not succeed: state=%s reason=%q", res.state, res.reason)
	}
	if len(res.rows) != 0 {
		t.Fatalf("wrong-tenant query returned %d rows; expected 0 (cross-tenant isolation)", len(res.rows))
	}
	t.Logf("PASS: wrong-tenant Athena query returned 0 rows (isolation holds)")
}

// testAthenaDialect proves the §4 dialect constructs run on Athena.
func testAthenaDialect(t *testing.T, ctx context.Context, r *athenaRunner, env smokeEnv) {
	t.Helper()
	sql := fmt.Sprintf(`SELECT id, from_unixtime(ts/1000) AS ts_rendered,
       json_extract_scalar(labels, '$.region') AS region
FROM %s.log_events
WHERE tenant_id = '%s'
  AND regexp_like(message, 'canary')
  AND json_extract_scalar(labels, '$.region') = 'us-east-1'
LIMIT 10`, env.glueDB, smokeTenant)
	res, err := r.run(ctx, sql)
	if err != nil {
		t.Fatalf("athena run (dialect): %v", err)
	}
	if res.state != string(athtypes.QueryExecutionStateSucceeded) {
		t.Fatalf("dialect query did not succeed: state=%s reason=%q", res.state, res.reason)
	}
	if len(res.rows) == 0 {
		t.Fatal("dialect query returned 0 rows; regexp_like/json_extract_scalar/from_unixtime not exercised")
	}
	t.Logf("PASS: Athena dialect constructs executed, %d rows", len(res.rows))
}

// ---------------------------------------------------------------------------
// athenaRunner — minimal raw Athena query executor (bypasses the fitness gate on
// purpose so the engine-enforced guards can be validated directly).
// ---------------------------------------------------------------------------

type athenaRunner struct {
	client    *athena.Client
	db        string
	workgroup string
	output    string
}

type athenaResult struct {
	state  string
	reason string
	rows   [][]string // data rows (header stripped)
}

func (r *athenaRunner) run(ctx context.Context, sql string) (athenaResult, error) {
	start, err := r.client.StartQueryExecution(ctx, &athena.StartQueryExecutionInput{
		QueryString:           aws.String(sql),
		QueryExecutionContext: &athtypes.QueryExecutionContext{Database: aws.String(r.db)},
		ResultConfiguration:   &athtypes.ResultConfiguration{OutputLocation: aws.String(r.output)},
		WorkGroup:             aws.String(r.workgroup),
	})
	if err != nil {
		return athenaResult{}, fmt.Errorf("start: %w", err)
	}
	qid := aws.ToString(start.QueryExecutionId)

	deadline := time.Now().Add(2 * time.Minute)
	var state athtypes.QueryExecutionState
	var reason string
	for time.Now().Before(deadline) {
		ex, err := r.client.GetQueryExecution(ctx, &athena.GetQueryExecutionInput{
			QueryExecutionId: aws.String(qid),
		})
		if err != nil {
			return athenaResult{}, fmt.Errorf("get execution: %w", err)
		}
		state = ex.QueryExecution.Status.State
		if ex.QueryExecution.Status.StateChangeReason != nil {
			reason = *ex.QueryExecution.Status.StateChangeReason
		}
		switch state {
		case athtypes.QueryExecutionStateSucceeded:
			rows, err := r.fetchRows(ctx, qid)
			return athenaResult{state: string(state), reason: reason, rows: rows}, err
		case athtypes.QueryExecutionStateFailed, athtypes.QueryExecutionStateCancelled:
			return athenaResult{state: string(state), reason: reason}, nil
		}
		time.Sleep(time.Second)
	}
	return athenaResult{state: string(state), reason: "timeout"}, nil
}

func (r *athenaRunner) fetchRows(ctx context.Context, qid string) ([][]string, error) {
	out, err := r.client.GetQueryResults(ctx, &athena.GetQueryResultsInput{
		QueryExecutionId: aws.String(qid),
	})
	if err != nil {
		return nil, fmt.Errorf("get results: %w", err)
	}
	rs := out.ResultSet.Rows
	if len(rs) > 0 {
		rs = rs[1:] // strip header row
	}
	rows := make([][]string, 0, len(rs))
	for _, row := range rs {
		cells := make([]string, 0, len(row.Data))
		for _, d := range row.Data {
			cells = append(cells, aws.ToString(d.VarCharValue))
		}
		rows = append(rows, cells)
	}
	return rows, nil
}
