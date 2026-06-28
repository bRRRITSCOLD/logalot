//go:build cold_query

// Cold-query integration tests: runs Trino against Parquet files in MinIO with
// HMS providing the schema. These tests validate the full SQL fitness function
// and query path against a real Trino engine — faithful to managed Athena
// (both are Trino forks, decision 016 §2).
//
// Requirements:
//   - Compose overlay must be running:
//     docker compose -f docker-compose.yml -f docker-compose.cold-query.yml up
//   - Environment:
//     TRINO_DSN=http://user@localhost:8080   (default)
//     MINIO_ENDPOINT=http://localhost:9000   (default)
//     MINIO_ACCESS_KEY=minioadmin            (default)
//     MINIO_SECRET_KEY=minioadmin            (default)
//
// Run:
//
//	go test -tags=cold_query -v -timeout 300s ./pkg/coldstore/...
package coldstore

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsglue "github.com/aws/aws-sdk-go-v2/service/glue"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	_ "github.com/trinodb/trino-go-client/trino" // trino driver
)

const (
	coldQueryBucket  = "logalot-cold-cq"
	coldQueryGlueDB  = "logalot_cold_cq"
	coldQueryTenant  = "aaaaaaaa-1111-1111-1111-111111111111"
	coldQueryTenant2 = "bbbbbbbb-2222-2222-2222-222222222222"
)

// TestColdQuery_Trino is the Trino cold-query integration suite.
// Sub-tests validate SQL fitness gating and query isolation.
func TestColdQuery_Trino(t *testing.T) {
	ctx := context.Background()

	// --- Wait for Trino to be ready (it can take 30–60 s to start). ---
	trinoDSN := envOrDefault("TRINO_DSN", "http://trino@localhost:8080")
	waitForTrino(t, ctx, trinoDSN)

	db, err := sql.Open("trino", trinoDSN)
	if err != nil {
		t.Fatalf("open trino: %v", err)
	}
	defer db.Close()

	// --- Seed MinIO with Parquet fixture. ---
	s3c := mustMinIOClient(t)
	ensureMinIOBucket(t, ctx, s3c, coldQueryBucket)
	seedParquetFixture(t, ctx, s3c)

	// Register HMS table so Trino can query.
	ensureColdQueryTable(t, ctx, db)

	t.Run("FitnessBlocksNoTenantQuery", func(t *testing.T) {
		testFitnessBlocksNoTenantQuery(t)
	})
	t.Run("FitnessBlocksMismatchedTenantQuery", func(t *testing.T) {
		testFitnessBlocksMismatchedTenantQuery(t)
	})
	t.Run("FitnessPassesValidQuery", func(t *testing.T) {
		testFitnessPassesValidQuery(t)
	})
	t.Run("TrinoQueryReturnsOnlyTenantRows", func(t *testing.T) {
		testTrinoQueryIsolation(t, ctx, db)
	})
}

// ---------------------------------------------------------------------------
// Sub-tests
// ---------------------------------------------------------------------------

func testFitnessBlocksNoTenantQuery(t *testing.T) {
	t.Helper()
	sql := "SELECT ts, id, message FROM hive.logalot_cold_cq.log_events LIMIT 10"
	err := CheckTenantPredicate(sql, coldQueryTenant)
	if err == nil {
		t.Error("fitness: expected error for query with no tenant_id predicate; got nil")
	} else {
		t.Logf("PASS: fitness rejected no-tenant SQL: %v", err)
	}
}

func testFitnessBlocksMismatchedTenantQuery(t *testing.T) {
	t.Helper()
	// Predicate is present but for a DIFFERENT tenant — must be rejected.
	wrongTenant := coldQueryTenant2
	sql := fmt.Sprintf(
		"SELECT ts FROM hive.logalot_cold_cq.log_events WHERE tenant_id = '%s'",
		wrongTenant,
	)
	err := CheckTenantPredicate(sql, coldQueryTenant) // bound to tenant 1, not 2
	if err == nil {
		t.Error("fitness: expected error for mismatched tenant_id; got nil")
	} else {
		t.Logf("PASS: fitness rejected mismatched-tenant SQL: %v", err)
	}
}

func testFitnessPassesValidQuery(t *testing.T) {
	t.Helper()
	sql := fmt.Sprintf(
		"SELECT ts, id, message FROM hive.logalot_cold_cq.log_events WHERE tenant_id = '%s' AND ts > 0 LIMIT 10",
		coldQueryTenant,
	)
	if err := CheckTenantPredicate(sql, coldQueryTenant); err != nil {
		t.Errorf("fitness: expected nil for valid tenant SQL; got: %v", err)
	} else {
		t.Logf("PASS: fitness accepted valid tenant SQL")
	}
}

// testTrinoQueryIsolation writes two tenants' Parquet rows and confirms Trino
// only returns the scoped tenant's rows when the fitness-approved SQL is run.
func testTrinoQueryIsolation(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()

	q := fmt.Sprintf(`
		SELECT id, message
		FROM hive.%s.log_events
		WHERE tenant_id = '%s'
		LIMIT 100
	`, coldQueryGlueDB, coldQueryTenant)

	// Fitness gate must pass before we send to Trino (same path as production).
	if err := CheckTenantPredicate(q, coldQueryTenant); err != nil {
		t.Fatalf("fitness pre-check: %v", err)
	}

	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		t.Fatalf("trino query: %v", err)
	}
	defer rows.Close()

	var count int
	for rows.Next() {
		var id, message string
		if err := rows.Scan(&id, &message); err != nil {
			t.Fatalf("scan: %v", err)
		}
		// Every row must belong to the scoped tenant (verified via fixture IDs).
		if !strings.HasPrefix(id, "cq-tenant1-") {
			t.Errorf("cross-tenant leak: row id=%q does not belong to tenant1", id)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows error: %v", err)
	}
	if count == 0 {
		t.Error("expected rows for scoped tenant; got 0")
	} else {
		t.Logf("PASS: Trino returned %d rows, all belong to scoped tenant", count)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func waitForTrino(t *testing.T, ctx context.Context, dsn string) {
	t.Helper()
	// Extract host from DSN: http://user@host:port -> http://host:port/v1/info
	host := strings.Replace(dsn, "trino@", "", 1)
	infoURL := host + "/v1/info"

	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(infoURL) //nolint:noctx
		if err == nil && resp.StatusCode == 200 {
			_ = resp.Body.Close()
			t.Logf("Trino ready at %s", infoURL)
			return
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
		time.Sleep(5 * time.Second)
	}
	t.Fatalf("Trino not ready after 120s at %s", infoURL)
}

func mustMinIOClient(t *testing.T) *s3.Client {
	t.Helper()
	endpoint := envOrDefault("MINIO_ENDPOINT", "http://localhost:9000")
	accessKey := envOrDefault("MINIO_ACCESS_KEY", "minioadmin")
	secretKey := envOrDefault("MINIO_SECRET_KEY", "minioadmin")

	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
		awsconfig.WithEndpointResolver( //nolint:staticcheck
			aws.EndpointResolverFunc( //nolint:staticcheck
				func(_, _ string) (aws.Endpoint, error) { //nolint:staticcheck
					return aws.Endpoint{ //nolint:staticcheck
						URL:               endpoint,
						SigningRegion:     "us-east-1",
						HostnameImmutable: true,
					}, nil
				}),
		),
	)
	if err != nil {
		t.Fatalf("aws config: %v", err)
	}
	return s3.NewFromConfig(awsCfg, func(o *s3.Options) { o.UsePathStyle = true })
}

func ensureMinIOBucket(t *testing.T, ctx context.Context, s3c *s3.Client, bucket string) {
	t.Helper()
	_, err := s3c.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)})
	if err != nil && !strings.Contains(err.Error(), "BucketAlreadyExists") &&
		!strings.Contains(err.Error(), "BucketAlreadyOwnedByYou") {
		t.Fatalf("ensure bucket %q: %v", bucket, err)
	}
}

// seedParquetFixture writes a minimal Parquet file for each test tenant using
// the production encoder so the schema is exactly what Trino will read.
func seedParquetFixture(t *testing.T, ctx context.Context, s3c *s3.Client) {
	t.Helper()

	fixTime := time.Date(2026, 6, 27, 10, 0, 0, 0, time.UTC)

	for _, tc := range []struct {
		tenantID  kernel.TenantID
		prefix    string
		msgPrefix string
	}{
		{coldQueryTenant, "cq-tenant1-", "tenant1 cold query event"},
		{coldQueryTenant2, "cq-tenant2-", "tenant2 cold query event"},
	} {
		events := make([]kernel.LogEvent, 3)
		for i := range events {
			events[i] = kernel.LogEvent{
				TenantID: tc.tenantID,
				TS:       fixTime.Add(time.Duration(i) * time.Minute),
				ID:       fmt.Sprintf("%s%03d", tc.prefix, i),
				Service:  "cold-query-test",
				Level:    kernel.LevelInfo,
				Message:  fmt.Sprintf("%s %d", tc.msgPrefix, i),
			}
		}

		tctx := kernel.TenantContext{TenantID: tc.tenantID}
		parquet, err := encodeParquet(tctx, events)
		if err != nil {
			t.Fatalf("encodeParquet tenant %s: %v", tc.tenantID, err)
		}

		batchID := fmt.Sprintf("fixture-%s", strings.ReplaceAll(string(tc.tenantID)[:8], "-", ""))
		key := coldKey(string(tc.tenantID), batchID, fixTime)

		_, err = s3c.PutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(coldQueryBucket),
			Key:         aws.String(key),
			Body:        bytes.NewReader(parquet),
			ContentType: aws.String("application/octet-stream"),
		})
		if err != nil {
			t.Fatalf("PutObject tenant %s: %v", tc.tenantID, err)
		}
		t.Logf("seeded s3://%s/%s (%d bytes)", coldQueryBucket, key, len(parquet))
	}
}

// ensureColdQueryTable creates the external Hive table in HMS so Trino can
// query it. Uses CREATE TABLE IF NOT EXISTS so it is idempotent.
func ensureColdQueryTable(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()

	minioEndpoint := envOrDefault("MINIO_ENDPOINT", "http://localhost:9000")
	// Convert http://host:port to s3a://bucket for Hive location.
	_ = minioEndpoint // location uses s3a scheme via catalog config

	ddl := fmt.Sprintf(`
CREATE SCHEMA IF NOT EXISTS hive.%s
WITH (location = 's3a://%s/')
`, coldQueryGlueDB, coldQueryBucket)

	if _, err := db.ExecContext(ctx, ddl); err != nil {
		t.Logf("create schema (may already exist): %v", err)
	}

	createTable := fmt.Sprintf(`
CREATE TABLE IF NOT EXISTS hive.%s.log_events (
    tenant_id  VARCHAR,
    ts         BIGINT,
    id         VARCHAR,
    service    VARCHAR,
    level      VARCHAR,
    message    VARCHAR,
    labels     VARCHAR,
    trace_id   VARCHAR,
    span_id    VARCHAR,
    raw        VARCHAR
)
WITH (
    format = 'PARQUET',
    external_location = 's3a://%s/logs/',
    partitioned_by = ARRAY['tenant_id']
)
`, coldQueryGlueDB, coldQueryBucket)

	if _, err := db.ExecContext(ctx, createTable); err != nil {
		t.Logf("create table (may already exist): %v", err)
	}

	// Sync partitions from MinIO.
	callMSCK := fmt.Sprintf("CALL system.sync_partition_metadata('hive', '%s', 'log_events', 'ADD')", coldQueryGlueDB)
	if _, err := db.ExecContext(ctx, callMSCK); err != nil {
		t.Logf("sync_partition_metadata: %v", err)
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// Compile-time guard: ensure we imported glue (used via EnsureGlueTable in integration_test).
var _ = (*awsglue.Client)(nil)
