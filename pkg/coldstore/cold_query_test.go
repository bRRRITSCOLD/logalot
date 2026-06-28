//go:build cold_query

// Cold-query integration tests: run the REAL buildColdQuery output against a
// genuine Trino engine (Athena IS managed Trino, decision 016 §2) over Parquet
// files in MinIO, with HMS providing the schema and partitioning. This proves
// the §4 SQL dialect constructs (regexp_like, json_extract_scalar, dt BETWEEN
// partition pruning, ORDER BY/LIMIT) actually execute, and that the engine
// itself rejects a query lacking a partition predicate — the faithful local
// analog of Athena's injected projection (hive.query-partition-filter-required).
//
// Requirements:
//   - The cold-query stack must be up:
//     docker compose -f docker-compose.cold-query.yml up -d
//     (wait for the trino container to report healthy)
//   - Env (defaults target the compose stack):
//     TRINO_DSN=http://trino@localhost:8080
//     MINIO_ENDPOINT=http://localhost:9000
//     MINIO_ACCESS_KEY=minioadmin
//     MINIO_SECRET_KEY=minioadmin
//
// Run:
//
//	go test -tags=cold_query -v -timeout 600s ./pkg/coldstore/...
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
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	_ "github.com/trinodb/trino-go-client/trino" // trino database/sql driver
)

const (
	// Schema name MUST match buildColdQuery's hard-coded `FROM logalot_cold.…`
	// so we exercise the production SQL with only a catalog prefix added.
	coldQuerySchema  = "logalot_cold"
	coldQueryBucket  = "logalot-cold-cq"
	coldQueryTenant  = "aaaaaaaa-1111-1111-1111-111111111111"
	coldQueryTenant2 = "bbbbbbbb-2222-2222-2222-222222222222"
)

// TestColdQuery_Trino is the Trino cold-query integration suite.
func TestColdQuery_Trino(t *testing.T) {
	ctx := context.Background()

	trinoDSN := envOrDefault("TRINO_DSN", "http://trino@localhost:8080")
	waitForTrino(t, trinoDSN)

	db, err := sql.Open("trino", trinoDSN)
	if err != nil {
		t.Fatalf("open trino: %v", err)
	}
	defer db.Close()

	// Seed MinIO with two tenants' Parquet fixtures using the PRODUCTION encoder
	// and key layout, then register the external table + sync partitions.
	s3c := mustMinIOClient(t)
	ensureMinIOBucket(t, ctx, s3c, coldQueryBucket)
	seedParquetFixture(t, ctx, s3c)
	ensureColdQueryTable(t, ctx, db)

	t.Run("RealBuildColdQuery_ReturnsOnlyScopedTenantRows", func(t *testing.T) {
		testRealQueryIsolation(t, ctx, db)
	})
	t.Run("EngineRejectsNoPartitionPredicate", func(t *testing.T) {
		testEngineRejectsNoTenant(t, ctx, db)
	})
	t.Run("DialectConstructsExecute", func(t *testing.T) {
		testDialectConstructs(t, ctx, db)
	})
	t.Run("LocalFitnessGate_Supplementary", func(t *testing.T) {
		// NOTE: this is the app-side backstop, NOT a substitute for the engine
		// rejection proven above. Asserted here only for completeness.
		sqlNoTenant := "SELECT ts FROM " + coldQuerySchema + ".log_events LIMIT 1"
		if err := CheckTenantPredicate(sqlNoTenant, coldQueryTenant); err == nil {
			t.Error("fitness gate should reject a no-tenant query")
		}
	})
}

// testRealQueryIsolation runs the actual buildColdQuery output (with text,
// service, and label filters set so the §4 constructs appear) against Trino and
// asserts every returned row belongs to the scoped tenant.
func testRealQueryIsolation(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()

	tc := kernel.TenantContext{TenantID: kernel.TenantID(coldQueryTenant)}
	q := kernel.SearchQuery{
		Text:    "cold query",                        // -> regexp_like(message, ...)
		Service: "cold-query-test",                   // -> service = ...
		Labels:  map[string]string{"region": "eu-1"}, // -> json_extract_scalar(labels,'$.region')
		From:    time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC),
		To:      time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC),
		Limit:   100,
	}

	prodSQL := buildColdQuery(tc, q)

	// App-side fitness gate must pass before we ever hit the engine (production
	// path). This is the same gate Store.Search applies.
	if err := CheckTenantPredicate(prodSQL, coldQueryTenant); err != nil {
		t.Fatalf("fitness pre-check on production SQL failed: %v\nSQL:\n%s", err, prodSQL)
	}

	// Athena addresses `schema.table`; Trino addresses `catalog.schema.table`.
	// Add only the catalog prefix — the rest is the verbatim production SQL.
	trinoSQL := strings.Replace(prodSQL,
		"FROM "+coldQuerySchema+".log_events",
		"FROM hive."+coldQuerySchema+".log_events", 1)
	t.Logf("executing production-derived Trino SQL:\n%s", trinoSQL)

	rows, err := db.QueryContext(ctx, trinoSQL)
	if err != nil {
		t.Fatalf("trino query (real buildColdQuery): %v", err)
	}
	defer rows.Close()

	var count int
	for rows.Next() {
		var ts int64
		var id, service, level, message, labels string
		if err := rows.Scan(&ts, &id, &service, &level, &message, &labels); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if !strings.HasPrefix(id, "cq-tenant1-") {
			t.Errorf("cross-tenant leak: row id=%q is not tenant1", id)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows error: %v", err)
	}
	if count == 0 {
		t.Fatal("expected NON-ZERO rows for scoped tenant from real buildColdQuery; got 0")
	}
	t.Logf("PASS: real buildColdQuery returned %d rows, all tenant1 (dialect + projection exercised)", count)
}

// testEngineRejectsNoTenant submits a query with NO partition predicate directly
// to Trino and asserts the ENGINE rejects it (hive.query-partition-filter-
// required=true) — the local analog of Athena injected projection.
func testEngineRejectsNoTenant(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()

	noPart := "SELECT ts, id FROM hive." + coldQuerySchema + ".log_events LIMIT 5"
	rows, err := db.QueryContext(ctx, noPart)
	if err == nil {
		// Some drivers defer execution to first scan; force materialization.
		defer rows.Close()
		if rows.Next() {
			t.Fatal("engine ACCEPTED a no-partition-predicate query — partition filter not enforced")
		}
		if err = rows.Err(); err == nil {
			t.Fatal("engine ACCEPTED a no-partition-predicate query — expected rejection")
		}
	}
	t.Logf("PASS: engine rejected no-partition query: %v", err)
}

// testDialectConstructs runs a query exercising regexp_like + json_extract_scalar
// + from_unixtime(ts/1000) to prove the Athena/Trino dialect support relied on by
// buildColdQuery and the §3 bigint-millis ts encoding.
func testDialectConstructs(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()

	q := fmt.Sprintf(`
SELECT id,
       from_unixtime(ts/1000) AS ts_rendered,
       json_extract_scalar(labels, '$.region') AS region
FROM hive.%s.log_events
WHERE tenant_id = '%s'
  AND regexp_like(message, 'cold query')
  AND json_extract_scalar(labels, '$.region') = 'eu-1'
LIMIT 10`, coldQuerySchema, coldQueryTenant)

	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		t.Fatalf("dialect query: %v", err)
	}
	defer rows.Close()

	var count int
	for rows.Next() {
		var id, tsRendered, region string
		if err := rows.Scan(&id, &tsRendered, &region); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if region != "eu-1" {
			t.Errorf("json_extract_scalar returned region=%q, want eu-1", region)
		}
		count++
	}
	if count == 0 {
		t.Fatal("dialect query returned 0 rows; regexp_like/json_extract_scalar/ts decode not exercised")
	}
	t.Logf("PASS: dialect constructs executed, %d rows (regexp_like + json_extract_scalar + from_unixtime)", count)
}

// ---------------------------------------------------------------------------
// Fixture + harness helpers
// ---------------------------------------------------------------------------

func waitForTrino(t *testing.T, dsn string) {
	t.Helper()
	host := strings.Replace(dsn, "trino@", "", 1)
	infoURL := host + "/v1/info"

	deadline := time.Now().Add(180 * time.Second)
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
		time.Sleep(3 * time.Second)
	}
	t.Fatalf("Trino not ready after 180s at %s", infoURL)
}

func mustMinIOClient(t *testing.T) *s3.Client {
	t.Helper()
	endpoint := envOrDefault("MINIO_ENDPOINT", "http://localhost:9000")
	accessKey := envOrDefault("MINIO_ACCESS_KEY", "minioadmin")
	secretKey := envOrDefault("MINIO_SECRET_KEY", "minioadmin")

	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
		awsconfig.WithEndpointResolver( //nolint:staticcheck
			aws.EndpointResolverFunc( //nolint:staticcheck
				func(_, _ string) (aws.Endpoint, error) { //nolint:staticcheck
					return aws.Endpoint{ //nolint:staticcheck
						URL:               endpoint,
						SigningRegion:     "us-east-1",
						HostnameImmutable: true,
					}, nil
				})),
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

// seedParquetFixture writes one Parquet object per tenant using the PRODUCTION
// encoder + coldKey so the on-disk schema and Hive layout are exactly what cold
// reads will encounter.
func seedParquetFixture(t *testing.T, ctx context.Context, s3c *s3.Client) {
	t.Helper()

	fixTime := time.Date(2026, 6, 27, 10, 0, 0, 0, time.UTC)

	for _, f := range []struct {
		tenantID  kernel.TenantID
		idPrefix  string
		msgPrefix string
	}{
		{coldQueryTenant, "cq-tenant1-", "tenant1 cold query event"},
		{coldQueryTenant2, "cq-tenant2-", "tenant2 cold query event"},
	} {
		events := make([]kernel.LogEvent, 3)
		for i := range events {
			events[i] = kernel.LogEvent{
				TenantID: f.tenantID,
				TS:       fixTime.Add(time.Duration(i) * time.Minute),
				ID:       fmt.Sprintf("%s%03d", f.idPrefix, i),
				Service:  "cold-query-test",
				Level:    kernel.LevelInfo,
				Message:  fmt.Sprintf("%s %d", f.msgPrefix, i),
				Labels:   map[string]string{"region": "eu-1"},
			}
		}

		tctx := kernel.TenantContext{TenantID: f.tenantID}
		parquet, err := encodeParquet(tctx, events)
		if err != nil {
			t.Fatalf("encodeParquet tenant %s: %v", f.tenantID, err)
		}

		batchID := "fixture-" + string(f.tenantID)[:8]
		key := coldKey(string(f.tenantID), batchID, fixTime)

		if _, err := s3c.PutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(coldQueryBucket),
			Key:         aws.String(key),
			Body:        bytes.NewReader(parquet),
			ContentType: aws.String("application/octet-stream"),
		}); err != nil {
			t.Fatalf("PutObject tenant %s: %v", f.tenantID, err)
		}
		t.Logf("seeded s3://%s/%s (%d bytes)", coldQueryBucket, key, len(parquet))
	}
}

// ensureColdQueryTable creates the external Hive table partitioned by
// (tenant_id, dt, hour) — matching production (EnsureGlueTable + cold-tier.md
// §1/§3) — then syncs partitions from the seeded MinIO prefixes.
func ensureColdQueryTable(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()

	// Schema is metadata-only (local HMS warehouse dir); the external table below
	// carries the S3 location, which Trino reads directly. Keeping the schema
	// off S3 avoids requiring an S3A driver inside the HMS image.
	if _, err := db.ExecContext(ctx, fmt.Sprintf(
		"CREATE SCHEMA IF NOT EXISTS hive.%s", coldQuerySchema)); err != nil {
		t.Logf("create schema (continuing if exists): %v", err)
	}

	// Data columns first, partition columns LAST (Trino requirement). The Parquet
	// file also carries tenant_id, but as a partition column its value comes from
	// the path (Athena/Trino both shadow the in-file value the same way).
	createTable := fmt.Sprintf(`
CREATE TABLE IF NOT EXISTS hive.%s.log_events (
    ts         BIGINT,
    id         VARCHAR,
    service    VARCHAR,
    level      VARCHAR,
    message    VARCHAR,
    labels     VARCHAR,
    trace_id   VARCHAR,
    span_id    VARCHAR,
    raw        VARCHAR,
    tenant_id  VARCHAR,
    dt         VARCHAR,
    hour       VARCHAR
)
WITH (
    format = 'PARQUET',
    external_location = 's3a://%s/logs/',
    partitioned_by = ARRAY['tenant_id','dt','hour']
)`, coldQuerySchema, coldQueryBucket)
	if _, err := db.ExecContext(ctx, createTable); err != nil {
		t.Logf("create table (continuing if exists): %v", err)
	}

	// Discover the seeded tenant_id=…/dt=…/hour=… prefixes. The procedure is
	// fully qualified (hive.system.…) because no session catalog is set.
	if _, err := db.ExecContext(ctx, fmt.Sprintf(
		"CALL hive.system.sync_partition_metadata('%s', 'log_events', 'FULL')",
		coldQuerySchema)); err != nil {
		t.Fatalf("sync_partition_metadata: %v", err)
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
