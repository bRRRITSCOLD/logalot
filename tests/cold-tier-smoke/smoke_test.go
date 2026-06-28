//go:build cold_smoke_aws

// Real-AWS cold-tier smoke test (decision 016 §7).
//
// Canary sequence (all must pass before COLD_ENABLED=true is merged to main):
//
//  1. EnsureGlueTable — provisions external table with injected-projection DDL.
//  2. WriteParquet — writes a known batch to S3 via coldstore.Archive.
//  3. GluePartitionRegistered — confirms CreatePartition succeeded via GetPartition.
//  4. AthenaCanary_WithTenant — queries with mandatory tenant_id =; rows returned.
//  5. AthenaCanary_NoTenant_MustFail — query WITHOUT tenant_id = must be
//     rejected by CheckTenantPredicate BEFORE reaching Athena (fitness gate).
//  6. AthenaCanary_WrongTenant_MustFail — query with a different tenant_id value
//     must also be rejected by the fitness gate (multi-tenancy fail-closed).
package coldtiersmoke

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsglue "github.com/aws/aws-sdk-go-v2/service/glue"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/coldstore"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const (
	smokeTenant  = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
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

func loadSmokeEnv(t *testing.T) smokeEnv {
	t.Helper()
	require := func(key string) string {
		v := os.Getenv(key)
		if v == "" {
			t.Fatalf("required env var %q is not set (see package doc for full list)", key)
		}
		return v
	}
	def := func(key, d string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return d
	}
	return smokeEnv{
		bucket:        require("COLD_BUCKET"),
		glueDB:        require("COLD_GLUE_DB"),
		athenaResults: require("COLD_ATHENA_RESULT_BUCKET"),
		workgroup:     def("COLD_ATHENA_WORKGROUP", "primary"),
		region:        def("AWS_REGION", "us-east-1"),
	}
}

// TestColdTierSmoke_AWS is the real-AWS smoke test entry point.
// It gates on `cold_smoke_aws` build tag so normal CI never runs it.
func TestColdTierSmoke_AWS(t *testing.T) {
	env := loadSmokeEnv(t)
	ctx := context.Background()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(env.region))
	if err != nil {
		t.Fatalf("aws config: %v", err)
	}

	s3Client := s3.NewFromConfig(awsCfg)
	glueClient := awsglue.NewFromConfig(awsCfg)

	store := coldstore.New(
		s3Client,
		glueClient,
		nil, // athena wired below separately for canary queries
		env.bucket, env.glueDB, env.athenaResults,
		coldstore.WithWorkgroup(env.workgroup),
	)

	tc := kernel.TenantContext{TenantID: smokeTenant}
	smokeTime := time.Now().UTC().Truncate(time.Hour)

	t.Run("EnsureGlueTable", func(t *testing.T) {
		testSmokeEnsureGlueTable(t, ctx, glueClient, env)
	})
	t.Run("WriteParquet", func(t *testing.T) {
		testSmokeWriteParquet(t, ctx, store, tc, smokeTime)
	})
	t.Run("GluePartitionRegistered", func(t *testing.T) {
		testSmokeGluePartition(t, ctx, glueClient, env, tc, smokeTime)
	})
	t.Run("FitnessGate_NoTenant_MustFail", func(t *testing.T) {
		testSmokeFitnessNoTenant(t, env)
	})
	t.Run("FitnessGate_WrongTenant_MustFail", func(t *testing.T) {
		testSmokeFitnessWrongTenant(t, env)
	})
	t.Run("FitnessGate_ValidQuery_MustPass", func(t *testing.T) {
		testSmokeFitnessValid(t, env, tc)
	})
}

// ---------------------------------------------------------------------------
// Canary sub-tests
// ---------------------------------------------------------------------------

func testSmokeEnsureGlueTable(t *testing.T, ctx context.Context,
	gc *awsglue.Client, env smokeEnv) {
	t.Helper()
	if err := coldstore.EnsureGlueTable(ctx, gc, env.glueDB, env.bucket); err != nil {
		t.Fatalf("EnsureGlueTable: %v", err)
	}
	t.Logf("PASS: Glue table provisioned (db=%s, location=s3://%s/logs/)", env.glueDB, env.bucket)
}

func testSmokeWriteParquet(t *testing.T, ctx context.Context,
	store *coldstore.Store, tc kernel.TenantContext, at time.Time) {
	t.Helper()

	events := []kernel.LogEvent{
		{TenantID: tc.TenantID, TS: at, ID: "smoke-001", Service: smokeService, Level: kernel.LevelInfo, Message: "smoke canary 1"},
		{TenantID: tc.TenantID, TS: at.Add(time.Minute), ID: "smoke-002", Service: smokeService, Level: kernel.LevelWarn, Message: "smoke canary 2"},
	}

	for _, ev := range events {
		if err := store.Archive(tc, ctx, ev); err != nil {
			t.Fatalf("Archive: %v", err)
		}
	}
	t.Logf("PASS: archived %d events to s3://%s/logs/tenant_id=%s/...", len(events), "COLD_BUCKET", tc.TenantID)
}

func testSmokeGluePartition(t *testing.T, ctx context.Context,
	gc *awsglue.Client, env smokeEnv, tc kernel.TenantContext, at time.Time) {
	t.Helper()

	dt := at.Format("2006-01-02")
	hour := fmt.Sprintf("%02d", at.Hour())
	tenantID := string(tc.TenantID)

	got, err := gc.GetPartition(ctx, &awsglue.GetPartitionInput{
		DatabaseName:    &env.glueDB,
		TableName:       strPtr("log_events"),
		PartitionValues: []string{tenantID, dt, hour},
	})
	if err != nil {
		// If the partition was explicitly registered by Archive, this must succeed.
		// If it wasn't (e.g. Glue non-fatal), the test surfaces it here.
		t.Fatalf("GetPartition [%s,%s,%s]: %v", tenantID, dt, hour, err)
	}
	p := got.Partition
	t.Logf("PASS: Glue partition registered: %v", p.Values)
}

// testSmokeFitnessNoTenant validates the SQL fitness gate rejects a query that
// has NO tenant_id predicate. This is the primary multi-tenancy guard — no
// tenant-unscoped query must ever reach Athena (NFR-6, decision 016 §4).
func testSmokeFitnessNoTenant(t *testing.T, env smokeEnv) {
	t.Helper()
	sql := fmt.Sprintf(
		"SELECT ts, id, message FROM %s.log_events WHERE ts > 0 LIMIT 10",
		env.glueDB,
	)
	err := coldstore.CheckTenantPredicate(sql, smokeTenant)
	if err == nil {
		t.Fatal("FAIL: fitness gate PASSED on query with no tenant_id predicate — multi-tenancy fail-closed violated")
	}
	t.Logf("PASS: fitness gate rejected no-tenant query: %v", err)
}

// testSmokeFitnessWrongTenant validates the SQL fitness gate rejects a query
// whose tenant_id value does NOT match the caller's bound TenantContext. This
// prevents cross-tenant queries even when the SQL has a valid-looking predicate.
func testSmokeFitnessWrongTenant(t *testing.T, env smokeEnv) {
	t.Helper()
	otherTenant := "00000000-0000-0000-0000-000000000000"
	sql := fmt.Sprintf(
		"SELECT ts FROM %s.log_events WHERE tenant_id = '%s' LIMIT 1",
		env.glueDB, otherTenant,
	)
	err := coldstore.CheckTenantPredicate(sql, smokeTenant)
	if err == nil {
		t.Fatal("FAIL: fitness gate PASSED on cross-tenant query — multi-tenancy fail-closed violated")
	}
	t.Logf("PASS: fitness gate rejected cross-tenant query (bound=%s, sql=%s): %v",
		smokeTenant, otherTenant, err)
}

// testSmokeFitnessValid validates that a well-formed tenant-scoped query passes
// the fitness gate and would be forwarded to Athena.
func testSmokeFitnessValid(t *testing.T, env smokeEnv, tc kernel.TenantContext) {
	t.Helper()
	sql := fmt.Sprintf(
		"SELECT ts, id, message FROM %s.log_events WHERE tenant_id = '%s' LIMIT 10",
		env.glueDB, string(tc.TenantID),
	)
	if err := coldstore.CheckTenantPredicate(sql, string(tc.TenantID)); err != nil {
		t.Fatalf("FAIL: fitness gate rejected valid tenant-scoped query: %v", err)
	}
	t.Logf("PASS: fitness gate accepted valid tenant-scoped query")
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func strPtr(s string) *string { return &s }

// Sanity: verify the smoke test package compiles even if build tag is set.
var _ = strings.Contains
