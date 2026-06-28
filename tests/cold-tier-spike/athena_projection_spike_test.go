//go:build floci_spike

// Reproducible integration spike for issue #14: validates floci Athena query
// template fidelity and injected-tenant-projection enforcement against the
// cold-tier.md §4 design.
//
// # Scope
//
// The spike answers four questions asked by issue #14:
//
//  1. Does floci Athena actually execute SQL over seeded Parquet (real scan, real
//     predicate eval), or does it stub/return canned results?
//
//  2. Does floci enforce the injected `tenant_id` projection — refusing a query
//     that omits `tenant_id=`?
//
//  3. Do `dt`/`hour` partition predicates prune partitions?
//
//  4. Do `json_extract_scalar(labels,'$.region')` and `regexp_like(message,…)`
//     predicates behave as designed?
//
// # Key Finding (tl;dr)
//
// floci Athena is DuckDB v1.5.2, not Trino/Presto. DuckDB's catalog is entirely
// independent of floci's Glue emulation — the Glue bridge is absent. As a result:
//
//   - All cold-tier.md §4 query templates FAIL with "schema does not exist" (not
//     a partition-projection error, not a predicate error — the table simply does
//     not exist in DuckDB's catalog).
//   - `regexp_like` (Presto/Trino) and `json_extract_scalar` (Presto/Trino) are
//     not DuckDB functions → FAIL at query execution.
//   - Injected partition projection (`projection.tenant_id.type = injected`) is
//     NOT enforced by floci. A query with no `tenant_id=` predicate fails with
//     the same Glue-bridge error as one that includes it — not because of the
//     injected constraint.
//   - DuckDB CAN execute real SQL and CAN read Parquet from floci S3 via
//     `read_parquet('s3://...')` (DuckDB-native syntax) — it is NOT a stub.
//   - DuckDB equivalents (`json_extract_string`, `regexp_matches`) work correctly
//     on Parquet data from floci S3, returning content-correct rows.
//
// # What this means for cold-tier (#17 feature flag)
//
//   - The §4 query template CANNOT be validated against floci as-is. The
//     recommended local cold-query validation stack is MinIO + Trino + Hive
//     Metastore (Athena IS managed Trino → fully faithful SQL dialect).
//   - The injected-projection guarantee (`projection.tenant_id.type = injected`
//     forces a `tenant_id=` predicate at query execution time on real AWS) can
//     only be validated against real AWS Athena. It is not reproducible in floci.
//   - The local guard is the app-side SQL fitness function (cold-tier.md §4
//     NFR-6): reject any generated SQL lacking `tenant_id = <ctx>` before
//     submission to Athena. This is the enforced local backstop.
//   - The `ADD PARTITION` fallback (explicit `CreatePartition` per #13) is the
//     correct local path for partition registration; `MSCK REPAIR` and partition
//     projection are irrelevant on floci.
//
// # Sub-test Verdicts
//
//   - EngineIdentity              PASS  (DuckDB v1.5.2, confirmed at source)
//   - ParquetSeedAndDirectRead    PASS  (Parquet → floci S3 → DuckDB read works)
//   - DuckDBEquivalents           PASS  (json_extract_string / regexp_matches)
//   - CrossTenantGlobLeak         PASS  (shows 5 rows, confirming fitness-fn need)
//   - PrestoFunction_JsonExtractScalar   FAIL (expected; function absent in DuckDB)
//   - PrestoFunction_RegexpLike          FAIL (expected; function absent in DuckDB)
//   - GlueBridge_TemplateWithTenant      FAIL (expected; Glue not bridged to DuckDB)
//   - GlueBridge_TemplateWithoutTenant   FAIL (expected; Glue not bridged to DuckDB;
//                                               NOT an injected-projection error)
//   - InjectedProjectionEnforcement      FAIL (expected; NOT enforced by floci)
//
// Requires compose floci running at FLOCI_ENDPOINT (default http://localhost:4566).
// Start the stack with `make up` and confirm health with `curl /_floci/health`.
//
// Run:
//
//	go test -tags=floci_spike -run TestAthenaProjectionFidelity -v -timeout 300s \
//	    ./tests/cold-tier-spike/...
package coldtierspike

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/athena"
	athtypes "github.com/aws/aws-sdk-go-v2/service/athena/types"
	"github.com/aws/aws-sdk-go-v2/service/glue"
	glutypes "github.com/aws/aws-sdk-go-v2/service/glue/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	parquetgo "github.com/parquet-go/parquet-go"
)

// ---------------------------------------------------------------------------
// Constants — §14 spike.
// ---------------------------------------------------------------------------

const (
	// athenaDataBucket is isolated from other spike data so the Athena tests can
	// be re-run cleanly without orphaning the #13 Firehose data.
	athenaDataBucket   = "logalot-cold-athena-spike"
	athenaResultBucket = "logalot-cold-athena-results"
	athenaGlueDB       = "logalot_cold_athena_spike"

	// tenantAlpha and tenantBeta are two distinct tenants used to prove that
	// content-correct rows are returned per-tenant and that a glob across ALL
	// tenants leaks cross-tenant data (demonstrating why the fitness function
	// is necessary).
	tenantAlpha = "aaaaaaaa-1111-1111-1111-000000000001"
	tenantBeta  = "bbbbbbbb-2222-2222-2222-000000000002"

	athenaDT   = "2026-06-27"
	athenaHour = "14"

	// duckdbExpectedVersion is the DuckDB version embedded in floci 1.5.28.
	// Confirmed by Probe I in the investigation session.
	duckdbExpectedVersion = "v1.5.2"
)

// ---------------------------------------------------------------------------
// §2 Parquet record schema (mirrors cold-tier.md §2 exactly).
// ---------------------------------------------------------------------------

// coldLogRecord mirrors the cold-tier.md §2 Parquet schema.
// Labels and raw are stored as JSON strings (not Parquet structs) so a fluid
// label schema does not force Parquet schema evolution per tenant.
type coldLogRecord struct {
	TenantID string `parquet:"tenant_id"`
	TS       int64  `parquet:"ts"` // Unix millis UTC
	ID       string `parquet:"id"`
	Service  string `parquet:"service"`
	Level    string `parquet:"level"`
	Message  string `parquet:"message"`
	Labels   string `parquet:"labels"`  // JSON-encoded
	TraceID  string `parquet:"trace_id"`
	SpanID   string `parquet:"span_id"`
	Raw      string `parquet:"raw"` // JSON-encoded
}

// ---------------------------------------------------------------------------
// Suite entry-point.
// ---------------------------------------------------------------------------

// TestAthenaProjectionFidelity is the top-level suite for issue #14 spike
// findings. It probes floci Athena (DuckDB v1.5.2) against the cold-tier.md §4
// query template shape, injected-projection enforcement, and Presto-function
// support.
//
// Expected outcome: most sub-tests FAIL by design (confirmed fidelity gaps).
// The PASS sub-tests document what DOES work (DuckDB direct reads, DuckDB
// functions) so the results are actionable, not just a list of absences.
func TestAthenaProjectionFidelity(t *testing.T) {
	ctx := context.Background()
	cfg := mustFlociConfig(t)

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true })
	athClient := athena.NewFromConfig(cfg)
	glueClient := glue.NewFromConfig(cfg)

	ensureBucket(t, ctx, s3Client, athenaDataBucket)
	ensureBucket(t, ctx, s3Client, athenaResultBucket)

	// ---- Sub-tests run in declaration order; independent, each self-cleaning. ----

	// Seed MUST run first; all subsequent Athena sub-tests read from the seeded data.
	t.Run("ParquetSeedAndDirectRead", func(t *testing.T) {
		testParquetSeedAndDirectRead(t, ctx, s3Client, athClient)
	})
	t.Run("EngineIdentity", func(t *testing.T) {
		testEngineIdentity(t, ctx, athClient)
	})
	t.Run("DuckDBEquivalents", func(t *testing.T) {
		testDuckDBEquivalents(t, ctx, athClient)
	})
	t.Run("CrossTenantGlobLeak", func(t *testing.T) {
		testCrossTenantGlobLeak(t, ctx, athClient)
	})
	// Expected-FAIL sub-tests: fidelity gaps documented by design.
	t.Run("PrestoFunction_RegexpLike", func(t *testing.T) {
		testPrestoRegexpLike(t, ctx, athClient)
	})
	t.Run("PrestoFunction_JsonExtractScalar", func(t *testing.T) {
		testPrestoJsonExtractScalar(t, ctx, athClient)
	})
	// Glue bridge sub-tests require the Glue table to be set up first.
	setupAthenaGlueTable(t, ctx, glueClient)
	t.Run("GlueBridge_TemplateWithTenant", func(t *testing.T) {
		testGlueBridgeTemplateWithTenant(t, ctx, athClient)
	})
	t.Run("GlueBridge_TemplateWithoutTenant", func(t *testing.T) {
		testGlueBridgeTemplateWithoutTenant(t, ctx, athClient)
	})
	t.Run("InjectedProjectionEnforcement", func(t *testing.T) {
		testInjectedProjectionEnforcement(t, ctx, athClient)
	})
}

// ---------------------------------------------------------------------------
// Sub-test: Parquet seeding + direct DuckDB read from floci S3.
// Validates that DuckDB v1.5.2 actually executes real SQL over real Parquet
// data in floci S3 (NOT a stub) using DuckDB-native read_parquet() syntax.
// EXPECTED: PASS.
// ---------------------------------------------------------------------------

func testParquetSeedAndDirectRead(t *testing.T, ctx context.Context, s3Client *s3.Client, athClient *athena.Client) {
	t.Helper()

	// Seed tenant alpha: 3 rows, two regions in labels.
	rowsAlpha := []coldLogRecord{
		{
			TenantID: tenantAlpha, TS: 1751000000000, ID: "id-alpha-001",
			Service: "orders", Level: "info", Message: "order placed successfully",
			Labels: `{"region":"us-east-1","env":"prod"}`, TraceID: "tr-001", SpanID: "sp-001", Raw: `{}`,
		},
		{
			TenantID: tenantAlpha, TS: 1751000001000, ID: "id-alpha-002",
			Service: "orders", Level: "warn", Message: "payment retry attempt",
			Labels: `{"region":"us-east-1","env":"prod"}`, TraceID: "tr-002", SpanID: "sp-002", Raw: `{}`,
		},
		{
			TenantID: tenantAlpha, TS: 1751000002000, ID: "id-alpha-003",
			Service: "auth", Level: "error", Message: "login failed",
			Labels: `{"region":"eu-west-1","env":"prod"}`, TraceID: "tr-003", SpanID: "sp-003", Raw: `{}`,
		},
	}

	// Seed tenant beta: 2 rows (different service, different content).
	rowsBeta := []coldLogRecord{
		{
			TenantID: tenantBeta, TS: 1751000000000, ID: "id-beta-001",
			Service: "billing", Level: "info", Message: "invoice generated",
			Labels: `{"region":"us-west-2","env":"prod"}`, TraceID: "tr-b01", SpanID: "sp-b01", Raw: `{}`,
		},
		{
			TenantID: tenantBeta, TS: 1751000001000, ID: "id-beta-002",
			Service: "billing", Level: "error", Message: "payment gateway timeout",
			Labels: `{"region":"us-west-2","env":"prod"}`, TraceID: "tr-b02", SpanID: "sp-b02", Raw: `{}`,
		},
	}

	keyAlpha := fmt.Sprintf("logs/tenant_id=%s/dt=%s/hour=%s/batch-spike14-001.parquet",
		tenantAlpha, athenaDT, athenaHour)
	keyBeta := fmt.Sprintf("logs/tenant_id=%s/dt=%s/hour=%s/batch-spike14-001.parquet",
		tenantBeta, athenaDT, athenaHour)

	writeParquetToS3(t, ctx, s3Client, athenaDataBucket, keyAlpha, rowsAlpha)
	writeParquetToS3(t, ctx, s3Client, athenaDataBucket, keyBeta, rowsBeta)
	t.Logf("PASS: Parquet seeding complete. tenantAlpha=%d rows @ %s; tenantBeta=%d rows @ %s",
		len(rowsAlpha), keyAlpha, len(rowsBeta), keyBeta)

	// Verify tenant alpha: read via DuckDB read_parquet() using the tenant-specific path.
	// The path scope is the ONLY isolation mechanism available in DuckDB (no Glue bridge).
	pathAlpha := fmt.Sprintf("s3://%s/logs/tenant_id=%s/dt=%s/hour=%s/*.parquet",
		athenaDataBucket, tenantAlpha, athenaDT, athenaHour)
	sql := fmt.Sprintf("SELECT id, service, level, message FROM read_parquet('%s') ORDER BY id", pathAlpha)
	result := runAthenaQuery(t, ctx, athClient, sql, "s3://"+athenaResultBucket+"/seed-alpha/")
	if result.failed {
		t.Errorf("FIDELITY GAP: DuckDB could not read tenantAlpha Parquet from floci S3: %s", result.failReason)
		return
	}
	dataRows := result.dataRows() // strips the header row
	if len(dataRows) != 3 {
		t.Errorf("tenantAlpha read: got %d rows, want 3. Rows: %v", len(dataRows), dataRows)
	} else {
		// Spot-check content: first row by ID order is id-alpha-001.
		if got := dataRows[0][0]; got != "id-alpha-001" {
			t.Errorf("tenantAlpha row[0][id] = %q, want id-alpha-001", got)
		}
		if got := dataRows[0][3]; got != "order placed successfully" {
			t.Errorf("tenantAlpha row[0][message] = %q, want 'order placed successfully'", got)
		}
		t.Logf("PASS: tenantAlpha Parquet read → 3 rows returned; content correct "+
			"(real SQL execution, not a stub). DuckDB reads from floci S3. row[0]: id=%s msg=%q",
			dataRows[0][0], dataRows[0][3])
	}

	// Verify tenant beta: different path, different content.
	pathBeta := fmt.Sprintf("s3://%s/logs/tenant_id=%s/dt=%s/hour=%s/*.parquet",
		athenaDataBucket, tenantBeta, athenaDT, athenaHour)
	sql = fmt.Sprintf("SELECT id, service, level, message FROM read_parquet('%s') ORDER BY id", pathBeta)
	result = runAthenaQuery(t, ctx, athClient, sql, "s3://"+athenaResultBucket+"/seed-beta/")
	if result.failed {
		t.Errorf("FIDELITY GAP: DuckDB could not read tenantBeta Parquet from floci S3: %s", result.failReason)
		return
	}
	dataRows = result.dataRows()
	if len(dataRows) != 2 {
		t.Errorf("tenantBeta read: got %d rows, want 2. Rows: %v", len(dataRows), dataRows)
	} else {
		if got := dataRows[0][0]; got != "id-beta-001" {
			t.Errorf("tenantBeta row[0][id] = %q, want id-beta-001", got)
		}
		t.Logf("PASS: tenantBeta Parquet read → 2 rows returned; content correct "+
			"(separate tenant, separate path, correct row count). row[0]: id=%s", dataRows[0][0])
	}
}

// ---------------------------------------------------------------------------
// Sub-test: engine identity — confirm DuckDB v1.5.2 via SELECT version().
// EXPECTED: PASS.
// ---------------------------------------------------------------------------

func testEngineIdentity(t *testing.T, ctx context.Context, athClient *athena.Client) {
	t.Helper()

	result := runAthenaQuery(t, ctx, athClient,
		"SELECT version() AS duckdb_version",
		"s3://"+athenaResultBucket+"/engine-id/")
	if result.failed {
		t.Fatalf("engine identity query failed: %s", result.failReason)
	}
	rows := result.dataRows()
	if len(rows) != 1 {
		t.Fatalf("engine identity: expected 1 row, got %d: %v", len(rows), rows)
	}
	ver := rows[0][0]
	// Error messages also expose "floci-duck execute" — both confirm DuckDB.
	t.Logf("PASS: floci Athena engine = DuckDB %q (confirmed via SELECT version()). "+
		"IMPLICATION: NOT Trino/Presto (the real AWS Athena engine). SQL dialect "+
		"differences: no regexp_like, no json_extract_scalar, no Glue catalog bridge.",
		ver)
	if !strings.HasPrefix(ver, "v") {
		t.Errorf("unexpected version format %q — expected DuckDB vX.Y.Z", ver)
	}
	if ver != duckdbExpectedVersion {
		// Log as informational; the version may drift across floci releases.
		t.Logf("NOTE: DuckDB version %q differs from expected %q — "+
			"update duckdbExpectedVersion constant if floci was upgraded", ver, duckdbExpectedVersion)
	}
}

// ---------------------------------------------------------------------------
// Sub-test: DuckDB equivalents of the Presto functions used in cold-tier.md §4.
// These pass on floci but are NOT the SQL cold-tier.md §4 specifies.
// Documented so the engineering team knows the closest viable alternative.
// EXPECTED: PASS (but function names diverge from the §4 template).
// ---------------------------------------------------------------------------

func testDuckDBEquivalents(t *testing.T, ctx context.Context, athClient *athena.Client) {
	t.Helper()

	// json_extract_string is DuckDB's equivalent of json_extract_scalar.
	pathAlpha := fmt.Sprintf("s3://%s/logs/tenant_id=%s/dt=%s/hour=%s/*.parquet",
		athenaDataBucket, tenantAlpha, athenaDT, athenaHour)

	jsonSQL := fmt.Sprintf(
		`SELECT id, json_extract_string(labels, '$.region') AS region `+
			`FROM read_parquet('%s') `+
			`WHERE json_extract_string(labels, '$.region') = 'us-east-1' `+
			`ORDER BY id`,
		pathAlpha)
	r := runAthenaQuery(t, ctx, athClient, jsonSQL, "s3://"+athenaResultBucket+"/duckdb-json/")
	if r.failed {
		t.Errorf("DuckDB json_extract_string failed: %s", r.failReason)
	} else {
		rows := r.dataRows()
		if len(rows) != 2 {
			t.Errorf("json_extract_string filter: got %d rows, want 2 (us-east-1 rows only)", len(rows))
		} else {
			t.Logf("PASS: json_extract_string(labels,'$.region')='us-east-1' → %d rows "+
				"(correct: 2/3 tenantAlpha rows have us-east-1; eu-west-1 row excluded). "+
				"NOTE: DuckDB function is json_extract_string, NOT json_extract_scalar (Presto).",
				len(rows))
		}
	}

	// regexp_matches is DuckDB's equivalent of regexp_like.
	reSQL := fmt.Sprintf(
		`SELECT id, message FROM read_parquet('%s') `+
			`WHERE regexp_matches(message, 'order.*') `+
			`ORDER BY id`,
		pathAlpha)
	r = runAthenaQuery(t, ctx, athClient, reSQL, "s3://"+athenaResultBucket+"/duckdb-regexp/")
	if r.failed {
		t.Errorf("DuckDB regexp_matches failed: %s", r.failReason)
	} else {
		rows := r.dataRows()
		if len(rows) != 1 {
			t.Errorf("regexp_matches filter: got %d rows, want 1 ('order placed successfully')", len(rows))
		} else {
			if rows[0][1] != "order placed successfully" {
				t.Errorf("regexp_matches row[0][message] = %q, want 'order placed successfully'", rows[0][1])
			}
			t.Logf("PASS: regexp_matches(message,'order.*') → 1 row %q (correct: only "+
				"'order placed' matches; 'payment retry' and 'login failed' excluded). "+
				"NOTE: DuckDB function is regexp_matches, NOT regexp_like (Presto).",
				rows[0][1])
		}
	}
}

// ---------------------------------------------------------------------------
// Sub-test: cross-tenant glob leak.
// Shows that WITHOUT a tenant-scoped path, DuckDB returns rows from ALL tenants.
// This confirms that the fitness function (assert tenant_id= in generated SQL)
// is the ONLY local guard — partition projection is not enforced by floci.
// EXPECTED: PASS (observes 5 rows = 3 alpha + 2 beta).
// ---------------------------------------------------------------------------

func testCrossTenantGlobLeak(t *testing.T, ctx context.Context, athClient *athena.Client) {
	t.Helper()

	pathAll := fmt.Sprintf("s3://%s/logs/**/*.parquet", athenaDataBucket)
	sql := fmt.Sprintf(
		`SELECT tenant_id, id FROM read_parquet('%s') ORDER BY tenant_id, id`,
		pathAll)
	r := runAthenaQuery(t, ctx, athClient, sql, "s3://"+athenaResultBucket+"/glob-leak/")
	if r.failed {
		t.Logf("NOTE: cross-tenant glob query failed (DuckDB may not support ** glob): %s", r.failReason)
		// Non-fatal: this probe is informational. If glob syntax differs,
		// the important isolation finding is still in GlueBridge sub-tests.
		return
	}
	rows := r.dataRows()
	// Both tenants' data is visible — the glob leaks across tenant boundaries.
	alphaCount := 0
	betaCount := 0
	for _, row := range rows {
		if len(row) > 0 && row[0] == tenantAlpha {
			alphaCount++
		} else if len(row) > 0 && row[0] == tenantBeta {
			betaCount++
		}
	}
	t.Logf("PASS (with caveat): glob query across all tenants returned %d rows "+
		"(tenantAlpha=%d, tenantBeta=%d). "+
		"FINDING: DuckDB returns ALL tenants' data when the S3 path is not scoped "+
		"to a single tenant. The injected partition projection on real AWS is the "+
		"engine-enforced guard; on floci it is absent. The app-side SQL fitness "+
		"function (cold-tier.md §4 NFR-6) is the ONLY local backstop.",
		len(rows), alphaCount, betaCount)
}

// ---------------------------------------------------------------------------
// Sub-test: Presto/Trino regexp_like — NOT a DuckDB function.
// EXPECTED: FAIL — confirmed fidelity gap.
// ---------------------------------------------------------------------------

func testPrestoRegexpLike(t *testing.T, ctx context.Context, athClient *athena.Client) {
	t.Helper()

	r := runAthenaQuery(t, ctx, athClient,
		"SELECT regexp_like('order placed', 'order.*') AS match_val",
		"s3://"+athenaResultBucket+"/presto-regexp/")
	if r.failed {
		if strings.Contains(r.failReason, "regexp_like") &&
			(strings.Contains(r.failReason, "does not exist") ||
				strings.Contains(r.failReason, "not found") ||
				strings.Contains(r.failReason, "Unknown")) {
			t.Errorf("FIDELITY GAP: cold-tier.md §4 uses regexp_like (Presto/Trino syntax) but "+
				"floci Athena (DuckDB v1.5.2) does not have this function. "+
				"DuckDB error: %s. "+
				"DuckDB equivalent: regexp_matches(). "+
				"Local validation requires Trino; the §4 template must use Trino syntax on real AWS.",
				r.failReason)
		} else {
			t.Errorf("FIDELITY GAP: regexp_like query failed with unexpected error: %s", r.failReason)
		}
	} else {
		// If it somehow succeeds, that is equally surprising — record it.
		t.Logf("NOTE: regexp_like SUCCEEDED on floci (unexpected — DuckDB does not define this "+
			"function in earlier versions). Rows: %v", r.allRows)
	}
}

// ---------------------------------------------------------------------------
// Sub-test: Presto/Trino json_extract_scalar — NOT a DuckDB function.
// EXPECTED: FAIL — confirmed fidelity gap.
// ---------------------------------------------------------------------------

func testPrestoJsonExtractScalar(t *testing.T, ctx context.Context, athClient *athena.Client) {
	t.Helper()

	r := runAthenaQuery(t, ctx, athClient,
		`SELECT json_extract_scalar('{"region":"us-east-1"}', '$.region') AS region_val`,
		"s3://"+athenaResultBucket+"/presto-json/")
	if r.failed {
		if strings.Contains(r.failReason, "json_extract_scalar") &&
			(strings.Contains(r.failReason, "does not exist") ||
				strings.Contains(r.failReason, "not found") ||
				strings.Contains(r.failReason, "Unknown")) {
			t.Errorf("FIDELITY GAP: cold-tier.md §4 uses json_extract_scalar (Presto/Trino syntax) "+
				"but floci Athena (DuckDB v1.5.2) does not have this function. "+
				"DuckDB error: %s. "+
				"DuckDB equivalent: json_extract_string(). "+
				"Local validation requires Trino; the §4 template uses Trino syntax on real AWS.",
				r.failReason)
		} else {
			t.Errorf("FIDELITY GAP: json_extract_scalar query failed with unexpected error: %s", r.failReason)
		}
	} else {
		t.Logf("NOTE: json_extract_scalar SUCCEEDED on floci (unexpected). Rows: %v", r.allRows)
	}
}

// ---------------------------------------------------------------------------
// Sub-test: Glue catalog bridge — §4 template WITH tenant_id predicate.
// Validates whether DuckDB queries can reference Glue-catalogued tables.
// EXPECTED: FAIL — Glue catalog is NOT bridged to DuckDB in floci.
// ---------------------------------------------------------------------------

func testGlueBridgeTemplateWithTenant(t *testing.T, ctx context.Context, athClient *athena.Client) {
	t.Helper()

	// The exact §4 template from cold-tier.md (simplified — no optional predicates).
	sql := fmt.Sprintf(
		`SELECT ts, id, service, level, message, labels
		 FROM %s.log_events
		 WHERE tenant_id = '%s'
		   AND dt BETWEEN '%s' AND '%s'
		 ORDER BY ts DESC
		 LIMIT 100`,
		athenaGlueDB, tenantAlpha, athenaDT, athenaDT)

	r := runAthenaQuery(t, ctx, athClient, sql, "s3://"+athenaResultBucket+"/tmpl-with-tenant/")
	if r.failed {
		if strings.Contains(r.failReason, "does not exist") ||
			strings.Contains(r.failReason, "not found") ||
			strings.Contains(r.failReason, "Catalog Error") {
			t.Errorf("FIDELITY GAP (Glue bridge): cold-tier.md §4 query template "+
				"(SELECT … FROM %s.log_events WHERE tenant_id='%s' AND dt BETWEEN …) "+
				"FAILS on floci. Reason: DuckDB's catalog is entirely independent of floci's "+
				"Glue emulation — the Glue bridge that real Athena provides does not exist in "+
				"floci DuckDB. Error: %s",
				athenaGlueDB, tenantAlpha, r.failReason)
		} else {
			t.Errorf("FIDELITY GAP: §4 template query failed unexpectedly: %s", r.failReason)
		}
	} else {
		t.Logf("NOTE: §4 template WITH tenant_id= SUCCEEDED on floci (unexpected — "+
			"this would mean Glue bridge exists). Rows: %v", r.allRows)
	}
}

// ---------------------------------------------------------------------------
// Sub-test: Glue catalog bridge — §4 template WITHOUT tenant_id predicate.
// On REAL AWS Athena, `projection.tenant_id.type = injected` makes this fail
// with "Column tenant_id is declared as type INJECTED, must provide equality
// predicate". On floci, it fails for the WRONG reason (Glue bridge absent).
// EXPECTED: FAIL — but NOT because of injected-projection enforcement.
// ---------------------------------------------------------------------------

func testGlueBridgeTemplateWithoutTenant(t *testing.T, ctx context.Context, athClient *athena.Client) {
	t.Helper()

	// §4 template with tenant_id= OMITTED — the case that injected projection
	// must reject on real AWS.
	sql := fmt.Sprintf(
		`SELECT ts, id, service, level, message, labels
		 FROM %s.log_events
		 WHERE dt BETWEEN '%s' AND '%s'
		 ORDER BY ts DESC
		 LIMIT 100`,
		athenaGlueDB, athenaDT, athenaDT)

	r := runAthenaQuery(t, ctx, athClient, sql, "s3://"+athenaResultBucket+"/tmpl-no-tenant/")
	if r.failed {
		isProjectionError := strings.Contains(r.failReason, "INJECTED") ||
			strings.Contains(r.failReason, "injected") ||
			strings.Contains(r.failReason, "partition projection") ||
			strings.Contains(r.failReason, "predicate required")
		isGlueBridgeError := strings.Contains(r.failReason, "does not exist") ||
			strings.Contains(r.failReason, "Catalog Error")

		switch {
		case isProjectionError:
			t.Logf("NOTE: floci DOES enforce injected projection (unexpected). "+
				"Error: %s", r.failReason)
		case isGlueBridgeError:
			t.Errorf("FIDELITY GAP (injected projection NOT enforced): "+
				"§4 template without tenant_id= fails on floci, but for the WRONG reason. "+
				"Expected: 'Column tenant_id is declared as INJECTED, equality predicate required' "+
				"(real AWS Athena partition-projection enforcement). "+
				"Actual: Glue bridge error (same as with tenant_id= — DuckDB does not know "+
				"about the table at all). "+
				"CONCLUSION: injected projection is NOT enforced by floci. The guarantee that "+
				"a query OMITTING tenant_id= is REFUSED can only be validated on real AWS Athena. "+
				"Local guard: app-side SQL fitness function (cold-tier.md §4 NFR-6) that "+
				"rejects any generated SQL lacking 'tenant_id = <ctx>' before submission. "+
				"Error: %s", r.failReason)
		default:
			t.Errorf("FIDELITY GAP: §4 template without tenant_id= failed unexpectedly: %s",
				r.failReason)
		}
	} else {
		t.Errorf("FIDELITY GAP (severe): §4 template WITHOUT tenant_id= SUCCEEDED on floci. "+
			"This means floci scanned across all tenants' data with no tenant predicate — "+
			"a complete isolation failure. Rows: %v", r.allRows)
	}
}

// ---------------------------------------------------------------------------
// Sub-test: summary assertion for injected projection enforcement.
// This sub-test makes the "NOT ENFORCED" verdict explicit and unambiguous.
// It runs AFTER the Glue-bridge sub-tests and records the combined finding.
// EXPECTED: FAIL — injected projection not enforced by floci.
// ---------------------------------------------------------------------------

func testInjectedProjectionEnforcement(t *testing.T, ctx context.Context, athClient *athena.Client) {
	t.Helper()

	// Both the "with tenant_id=" and "without tenant_id=" queries fail with
	// IDENTICAL Glue-bridge errors in GlueBridge_TemplateWithTenant and
	// GlueBridge_TemplateWithoutTenant. This confirms injected projection
	// is not enforced: the failure is at the catalog layer, not the projection layer.

	// Run one final confirmation: a bare query with no predicate at all.
	sql := fmt.Sprintf("SELECT count(*) AS n FROM %s.log_events", athenaGlueDB)
	r := runAthenaQuery(t, ctx, athClient, sql, "s3://"+athenaResultBucket+"/inj-proj/")

	// Regardless of whether this fails (Glue bridge) or succeeds, the verdict is:
	if r.failed {
		// If it fails for a Glue reason (same as all other template queries), that
		// confirms projection is not the enforcement layer.
		t.Errorf("FIDELITY GAP (injected-projection enforcement ABSENT): "+
			"On real AWS Athena, `projection.tenant_id.type = injected` requires an "+
			"equality predicate on tenant_id — a query without it is rejected at query "+
			"compile time with a specific projection error. "+
			"On floci: ANY query referencing a Glue-catalogued table fails with a Glue "+
			"bridge error BEFORE partition projection is even evaluated. "+
			"VERDICT: the injected-projection defense-in-depth (cold-tier.md §3) CANNOT "+
			"be validated against floci. It requires real AWS Athena. "+
			"LOCAL GUARD: the app-side SQL fitness function (cold-tier.md §4 NFR-6) that "+
			"asserts every generated SQL contains 'tenant_id = <ctx>' before submission. "+
			"This is the ENFORCED local backstop; injected projection is deferred to a "+
			"real-AWS CI smoke test. "+
			"Query error (Glue bridge, not projection): %s", r.failReason)
	} else {
		// If it somehow succeeded (Glue bridge present in some future floci),
		// check if projection enforced.
		rows := r.dataRows()
		t.Logf("NOTE: bare COUNT(*) with NO tenant predicate SUCCEEDED on floci. "+
			"Rows: %v. This warrants re-evaluation of injected-projection enforcement.", rows)
	}
}

// ---------------------------------------------------------------------------
// Glue table setup for §14 spike (partition projection + §2 schema).
// ---------------------------------------------------------------------------

func setupAthenaGlueTable(t *testing.T, ctx context.Context, glueClient *glue.Client) {
	t.Helper()

	_, err := glueClient.CreateDatabase(ctx, &glue.CreateDatabaseInput{
		DatabaseInput: &glutypes.DatabaseInput{
			Name:        aws.String(athenaGlueDB),
			Description: aws.String("Spike isolated Glue DB (issue #14)"),
		},
	})
	if err != nil && !isAlreadyExists(err) {
		t.Fatalf("Glue CreateDatabase: %v", err)
	}

	// Idempotent cleanup so re-runs are clean.
	_, _ = glueClient.DeleteTable(ctx, &glue.DeleteTableInput{
		DatabaseName: aws.String(athenaGlueDB),
		Name:         aws.String("log_events"),
	})

	cols := []glutypes.Column{
		{Name: aws.String("tenant_id"), Type: aws.String("string")},
		{Name: aws.String("ts"), Type: aws.String("bigint")},
		{Name: aws.String("id"), Type: aws.String("string")},
		{Name: aws.String("service"), Type: aws.String("string")},
		{Name: aws.String("level"), Type: aws.String("string")},
		{Name: aws.String("message"), Type: aws.String("string")},
		{Name: aws.String("labels"), Type: aws.String("string")},
		{Name: aws.String("trace_id"), Type: aws.String("string")},
		{Name: aws.String("span_id"), Type: aws.String("string")},
		{Name: aws.String("raw"), Type: aws.String("string")},
	}
	partKeys := []glutypes.Column{
		{Name: aws.String("tenant_id"), Type: aws.String("string")},
		{Name: aws.String("dt"), Type: aws.String("string")},
		{Name: aws.String("hour"), Type: aws.String("string")},
	}
	locationTmpl := fmt.Sprintf(
		"s3://%s/logs/tenant_id=${tenant_id}/dt=${dt}/hour=${hour}/", athenaDataBucket)
	projParams := map[string]string{
		"EXTERNAL":                    "TRUE",
		"projection.enabled":          "true",
		"projection.tenant_id.type":   "injected",
		"projection.dt.type":          "date",
		"projection.dt.format":        "yyyy-MM-dd",
		"projection.dt.range":         "2026-01-01,NOW",
		"projection.dt.interval":      "1",
		"projection.dt.interval.unit": "DAYS",
		"projection.hour.type":        "integer",
		"projection.hour.range":       "0,23",
		"projection.hour.digits":      "2",
		"storage.location.template":   locationTmpl,
	}
	_, err = glueClient.CreateTable(ctx, &glue.CreateTableInput{
		DatabaseName: aws.String(athenaGlueDB),
		TableInput: &glutypes.TableInput{
			Name:        aws.String("log_events"),
			Description: aws.String("Cold archive log_events (spike #14)"),
			StorageDescriptor: &glutypes.StorageDescriptor{
				Columns:  cols,
				Location: aws.String(fmt.Sprintf("s3://%s/logs/", athenaDataBucket)),
				InputFormat:  aws.String("org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"),
				OutputFormat: aws.String("org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"),
				SerdeInfo: &glutypes.SerDeInfo{
					SerializationLibrary: aws.String(
						"org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"),
					Parameters: map[string]string{"parquet.compression": "SNAPPY"},
				},
			},
			PartitionKeys: partKeys,
			TableType:     aws.String("EXTERNAL_TABLE"),
			Parameters:    projParams,
		},
	})
	if err != nil {
		t.Fatalf("Glue CreateTable for Athena spike: %v", err)
	}
	t.Logf("Glue table %s.log_events created with projection.tenant_id.type=injected", athenaGlueDB)
}

// ---------------------------------------------------------------------------
// Parquet writer helper.
// ---------------------------------------------------------------------------

// writeParquetToS3 encodes rows as Parquet (SNAPPY via parquet-go defaults)
// and uploads to floci S3 under the given key.
func writeParquetToS3(t *testing.T, ctx context.Context, s3Client *s3.Client,
	bucket, key string, rows []coldLogRecord) {
	t.Helper()

	var buf bytes.Buffer
	w := parquetgo.NewGenericWriter[coldLogRecord](&buf)
	if _, err := w.Write(rows); err != nil {
		t.Fatalf("parquet write rows: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("parquet close: %v", err)
	}

	_, err := s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(buf.Bytes()),
		ContentType: aws.String("application/octet-stream"),
	})
	if err != nil {
		t.Fatalf("S3 PutObject %s/%s: %v", bucket, key, err)
	}
	t.Logf("Parquet seeded: s3://%s/%s (%d bytes, %d rows)", bucket, key, buf.Len(), len(rows))
}

// ---------------------------------------------------------------------------
// Athena query runner + result type.
// ---------------------------------------------------------------------------

// athenaResult holds the outcome of a single query execution.
type athenaResult struct {
	failed     bool
	failReason string
	allRows    [][]string // raw rows including the header row
}

// dataRows returns allRows with the header row stripped.
func (r *athenaResult) dataRows() [][]string {
	if len(r.allRows) < 1 {
		return nil
	}
	return r.allRows[1:]
}

// runAthenaQuery submits sql to floci Athena, polls until terminal, and
// returns an athenaResult. It never fatalf's — the caller decides severity.
func runAthenaQuery(t *testing.T, ctx context.Context, athClient *athena.Client,
	sql, outputLoc string) athenaResult {
	t.Helper()

	startOut, err := athClient.StartQueryExecution(ctx, &athena.StartQueryExecutionInput{
		QueryString: aws.String(sql),
		ResultConfiguration: &athtypes.ResultConfiguration{
			OutputLocation: aws.String(outputLoc),
		},
	})
	if err != nil {
		return athenaResult{failed: true, failReason: fmt.Sprintf("StartQueryExecution: %v", err)}
	}
	qid := aws.ToString(startOut.QueryExecutionId)

	// Poll with a generous timeout; DuckDB startup can take a few seconds.
	const maxWait = 120 * time.Second
	const pollInterval = 500 * time.Millisecond
	deadline := time.Now().Add(maxWait)
	var state athtypes.QueryExecutionState
	var stateReason string
	for time.Now().Before(deadline) {
		time.Sleep(pollInterval)
		getOut, err := athClient.GetQueryExecution(ctx, &athena.GetQueryExecutionInput{
			QueryExecutionId: aws.String(qid),
		})
		if err != nil {
			return athenaResult{failed: true, failReason: fmt.Sprintf("GetQueryExecution: %v", err)}
		}
		state = getOut.QueryExecution.Status.State
		if getOut.QueryExecution.Status.StateChangeReason != nil {
			stateReason = *getOut.QueryExecution.Status.StateChangeReason
		}
		if state == athtypes.QueryExecutionStateSucceeded ||
			state == athtypes.QueryExecutionStateFailed ||
			state == athtypes.QueryExecutionStateCancelled {
			break
		}
	}

	if state != athtypes.QueryExecutionStateSucceeded {
		return athenaResult{failed: true, failReason: stateReason}
	}

	resOut, err := athClient.GetQueryResults(ctx, &athena.GetQueryResultsInput{
		QueryExecutionId: aws.String(qid),
	})
	if err != nil {
		return athenaResult{failed: true, failReason: fmt.Sprintf("GetQueryResults: %v", err)}
	}

	// Decode rows into [][]string.
	var rows [][]string
	for _, row := range resOut.ResultSet.Rows {
		var cells []string
		for _, cell := range row.Data {
			cells = append(cells, aws.ToString(cell.VarCharValue))
		}
		rows = append(rows, cells)
	}
	return athenaResult{allRows: rows}
}
