//go:build floci_spike

// Reproducible integration spike for issue #13: validates floci Firehose→Parquet
// delivery and Glue cataloging fidelity against the cold-tier.md §1–3 design.
//
// Each sub-test is independent and self-cleaning. The suite records an honest
// pass/fail verdict. The Firehose sub-test FAILS by design: it controls for the
// IAM-role variable (creates a recognized delivery role), triggers floci's actual
// flush path (≥5 records), and then asserts the cold-tier requirements that floci's
// Firehose CANNOT meet — it delivers raw NDJSON (not Parquet) and writes the
// dynamic-partition placeholders LITERALLY (no !{...} substitution). See the
// findings doc for the source-level root cause.
//
// Requires compose floci running at FLOCI_ENDPOINT (default http://localhost:4566).
// Start the stack with `make up` and confirm health with `curl /_floci/health`.
//
// Run:
//
//	go test -tags=floci_spike -run TestColdTierFidelity -v -timeout 300s \
//	    ./tests/cold-tier-spike/...
package coldtierspike

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/firehose"
	firetypes "github.com/aws/aws-sdk-go-v2/service/firehose/types"
	"github.com/aws/aws-sdk-go-v2/service/glue"
	glutypes "github.com/aws/aws-sdk-go-v2/service/glue/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ---------------------------------------------------------------------------
// Constants that mirror cold-tier.md §1–3 design.
// ---------------------------------------------------------------------------

const (
	// coldBucket is isolated from production to allow clean state per run.
	coldBucket   = "logalot-cold-spike"
	glueDB       = "logalot_cold_spike"
	glueTable    = "log_events"
	streamName   = "logalot-cold-stream-spike"
	testTenantID = "a0000000-0000-0000-0000-000000000001"
	testDT       = "2026-06-27"
	testHour     = "21"
	locationTmpl = "s3://" + coldBucket + "/logs/tenant_id=${tenant_id}/dt=${dt}/hour=${hour}/"

	// firehoseRoleName is a delivery role with a Firehose trust policy + S3 write
	// policy. It is created so the Firehose FAIL cannot be attributed to a missing
	// or unauthorized role — the IAM-role confound is eliminated in-test.
	firehoseRoleName = "firehose-delivery-role-spike"
	firehoseRoleARN  = "arn:aws:iam::000000000000:role/" + firehoseRoleName

	// firehoseFlushCount is floci 1.5.28's hard-coded count-based flush threshold
	// (FirehoseService.DEFAULT_FLUSH_COUNT = 5). floci has NO time-based flush, so
	// fewer than this many records never reach S3. We send exactly this many to
	// guarantee floci's flush path runs and the FAIL reflects fidelity, not a
	// sub-threshold buffer.
	firehoseFlushCount = 5
)

// firehoseDynSuffix is the cold-tier.md §1 key layout expressed with real AWS
// Firehose dynamic-partitioning + timestamp expressions. Real Firehose substitutes
// these; floci writes them LITERALLY (see findings doc). A run-unique isolation
// segment is prepended at call time so leftover objects cannot pollute the result.
const firehoseDynSuffix = "tenant_id=!{partitionKeyFromQuery:tenant_id}/dt=!{timestamp:yyyy-MM-dd}/hour=!{timestamp:HH}/"

// ---------------------------------------------------------------------------
// Suite entry-point.
// ---------------------------------------------------------------------------

// TestColdTierFidelity is the top-level suite for issue #13 spike findings.
// Sub-tests probe each layer of the Firehose→Parquet + Glue cataloging path.
func TestColdTierFidelity(t *testing.T) {
	ctx := context.Background()
	cfg := mustFlociConfig(t)

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true // required for path-style S3 with custom endpoints
	})
	fhClient := firehose.NewFromConfig(cfg)
	glueClient := glue.NewFromConfig(cfg)
	iamClient := iam.NewFromConfig(cfg)

	ensureBucket(t, ctx, s3Client, coldBucket)
	ensureGlueDB(t, ctx, glueClient, glueDB)

	// Run Glue and direct-S3 tests first (the direct-write fallback path).
	// These are expected to PASS. Firehose is last (expected FAIL).
	t.Run("GlueCatalogFidelity", func(t *testing.T) {
		testGlueCatalogFidelity(t, ctx, glueClient)
	})
	t.Run("DirectS3WriteKeyLayout", func(t *testing.T) {
		testDirectS3WriteKeyLayout(t, ctx, s3Client)
	})
	t.Run("GlueExplicitPartitionRegistration", func(t *testing.T) {
		testGlueExplicitPartition(t, ctx, glueClient)
	})
	// This sub-test FAILS by design — see findings doc §3. It controls for the
	// IAM-role variable, triggers floci's real flush path, and asserts the
	// cold-tier requirements floci's Firehose cannot meet (Parquet + partitioning).
	t.Run("FirehoseDeliveryFidelity", func(t *testing.T) {
		testFirehoseDeliveryFidelity(t, ctx, fhClient, s3Client, iamClient)
	})
}

// ---------------------------------------------------------------------------
// Sub-test: Glue catalog fidelity — schema, projection properties, external table.
// Validates cold-tier.md §3 DDL round-trip.
// EXPECTED: PASS.
// ---------------------------------------------------------------------------

func testGlueCatalogFidelity(t *testing.T, ctx context.Context, glueClient *glue.Client) {
	t.Helper()

	// Clean up from previous runs so the test is idempotent.
	_, _ = glueClient.DeleteTable(ctx, &glue.DeleteTableInput{
		DatabaseName: aws.String(glueDB),
		Name:         aws.String(glueTable),
	})

	// Data columns: mirror log_events from cold-tier.md §2.
	cols := []glutypes.Column{
		{Name: aws.String("tenant_id"), Type: aws.String("string")},
		{Name: aws.String("ts"), Type: aws.String("timestamp")},
		{Name: aws.String("id"), Type: aws.String("string")},
		{Name: aws.String("service"), Type: aws.String("string")},
		{Name: aws.String("level"), Type: aws.String("string")},
		{Name: aws.String("message"), Type: aws.String("string")},
		{Name: aws.String("labels"), Type: aws.String("string")},
		{Name: aws.String("trace_id"), Type: aws.String("string")},
		{Name: aws.String("span_id"), Type: aws.String("string")},
		{Name: aws.String("raw"), Type: aws.String("string")},
	}

	// Partition keys (Hive-style, cold-tier.md §1 + §3).
	partKeys := []glutypes.Column{
		{Name: aws.String("tenant_id"), Type: aws.String("string")},
		{Name: aws.String("dt"), Type: aws.String("string")},
		{Name: aws.String("hour"), Type: aws.String("string")},
	}

	// Partition projection properties from cold-tier.md §3.
	projParams := map[string]string{
		"EXTERNAL":                    "TRUE",
		"projection.enabled":          "true",
		"projection.tenant_id.type":   "injected", // the defense-in-depth enforcement property
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

	_, err := glueClient.CreateTable(ctx, &glue.CreateTableInput{
		DatabaseName: aws.String(glueDB),
		TableInput: &glutypes.TableInput{
			Name:        aws.String(glueTable),
			Description: aws.String("Cold archive of log events (spike isolation)"),
			StorageDescriptor: &glutypes.StorageDescriptor{
				Columns:  cols,
				Location: aws.String("s3://" + coldBucket + "/logs/"),
				InputFormat: aws.String(
					"org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"),
				OutputFormat: aws.String(
					"org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"),
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
		t.Fatalf("Glue CreateTable: %v", err)
	}

	// Round-trip via GetTable and assert every key property.
	got, err := glueClient.GetTable(ctx, &glue.GetTableInput{
		DatabaseName: aws.String(glueDB),
		Name:         aws.String(glueTable),
	})
	if err != nil {
		t.Fatalf("Glue GetTable: %v", err)
	}
	tbl := got.Table

	if aws.ToString(tbl.TableType) != "EXTERNAL_TABLE" {
		t.Errorf("TableType = %q, want EXTERNAL_TABLE", aws.ToString(tbl.TableType))
	}

	if len(tbl.PartitionKeys) != 3 {
		t.Errorf("PartitionKeys count = %d, want 3", len(tbl.PartitionKeys))
	} else {
		for i, want := range []string{"tenant_id", "dt", "hour"} {
			if got := aws.ToString(tbl.PartitionKeys[i].Name); got != want {
				t.Errorf("PartitionKeys[%d].Name = %q, want %q", i, got, want)
			}
		}
	}

	// The critical partition projection properties (cold-tier.md §3).
	for key, want := range map[string]string{
		"projection.enabled":        "true",
		"projection.tenant_id.type": "injected",
		"projection.dt.type":        "date",
		"projection.hour.type":      "integer",
		"storage.location.template": locationTmpl,
	} {
		if got, ok := tbl.Parameters[key]; !ok || got != want {
			t.Errorf("table.Parameters[%q] = %q (ok=%v), want %q", key, got, ok, want)
		}
	}

	// Schema: 10 columns, first = tenant_id, last = raw.
	if n := len(tbl.StorageDescriptor.Columns); n != 10 {
		t.Errorf("column count = %d, want 10", n)
	} else {
		if got := aws.ToString(tbl.StorageDescriptor.Columns[0].Name); got != "tenant_id" {
			t.Errorf("Columns[0] = %q, want tenant_id", got)
		}
		if got := aws.ToString(tbl.StorageDescriptor.Columns[9].Name); got != "raw" {
			t.Errorf("Columns[9] = %q, want raw", got)
		}
	}

	t.Logf("PASS: Glue external table round-trips correctly: " +
		"10 columns, partitionKeys=[tenant_id,dt,hour], " +
		"projection.tenant_id.type=injected, storage.location.template correct")
}

// ---------------------------------------------------------------------------
// Sub-test: direct S3 write with the designed Hive-style key layout.
// Validates cold-tier.md §1 (key layout) for the processor direct-write fallback.
// EXPECTED: PASS.
// ---------------------------------------------------------------------------

func testDirectS3WriteKeyLayout(t *testing.T, ctx context.Context, s3Client *s3.Client) {
	t.Helper()

	key := fmt.Sprintf("logs/tenant_id=%s/dt=%s/hour=%s/direct-write-spike-001.parquet",
		testTenantID, testDT, testHour)

	// We write a JSON sentinel rather than real Parquet bytes. The fidelity under
	// test is the S3 key layout and round-trip, not the Parquet encoding.
	payload := []byte(`{"tenant_id":"` + testTenantID + `","message":"direct-write-spike-payload"}`)

	_, err := s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(coldBucket),
		Key:    aws.String(key),
		Body:   bytes.NewReader(payload),
	})
	if err != nil {
		t.Fatalf("S3 PutObject: %v", err)
	}

	out, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(coldBucket),
		Key:    aws.String(key),
	})
	if err != nil {
		t.Fatalf("S3 GetObject: %v", err)
	}
	defer func() { _ = out.Body.Close() }()

	body, _ := io.ReadAll(out.Body)
	if !bytes.Equal(body, payload) {
		t.Errorf("round-trip body mismatch: got %q, want %q", body, payload)
	}

	// Assert the key follows Hive-style path segments (cold-tier.md §1).
	wantPrefix := fmt.Sprintf("logs/tenant_id=%s/dt=%s/hour=%s/", testTenantID, testDT, testHour)
	if !strings.HasPrefix(key, wantPrefix) {
		t.Errorf("key %q does not start with Hive-style prefix %q", key, wantPrefix)
	}

	t.Logf("PASS: S3 direct write + read under Hive-style key %q round-trips correctly (cold-tier.md §1)", key)
}

// ---------------------------------------------------------------------------
// Sub-test: explicit Glue partition registration (the ADD PARTITION fallback).
// Validates that Glue accepts per-write partition metadata for the fallback path.
// EXPECTED: PASS.
// ---------------------------------------------------------------------------

func testGlueExplicitPartition(t *testing.T, ctx context.Context, glueClient *glue.Client) {
	t.Helper()

	// Ensure the table is present (can run after GlueCatalogFidelity).
	_, err := glueClient.GetTable(ctx, &glue.GetTableInput{
		DatabaseName: aws.String(glueDB),
		Name:         aws.String(glueTable),
	})
	if err != nil {
		t.Skipf("table %s.%s not present; run GlueCatalogFidelity first: %v", glueDB, glueTable, err)
	}

	// Idempotent cleanup.
	_, _ = glueClient.DeletePartition(ctx, &glue.DeletePartitionInput{
		DatabaseName:    aws.String(glueDB),
		TableName:       aws.String(glueTable),
		PartitionValues: []string{testTenantID, testDT, testHour},
	})

	partLoc := fmt.Sprintf("s3://%s/logs/tenant_id=%s/dt=%s/hour=%s/",
		coldBucket, testTenantID, testDT, testHour)

	_, err = glueClient.CreatePartition(ctx, &glue.CreatePartitionInput{
		DatabaseName: aws.String(glueDB),
		TableName:    aws.String(glueTable),
		PartitionInput: &glutypes.PartitionInput{
			Values: []string{testTenantID, testDT, testHour},
			StorageDescriptor: &glutypes.StorageDescriptor{
				Columns: []glutypes.Column{
					{Name: aws.String("tenant_id"), Type: aws.String("string")},
					{Name: aws.String("ts"), Type: aws.String("timestamp")},
					{Name: aws.String("id"), Type: aws.String("string")},
					{Name: aws.String("service"), Type: aws.String("string")},
					{Name: aws.String("level"), Type: aws.String("string")},
					{Name: aws.String("message"), Type: aws.String("string")},
					{Name: aws.String("labels"), Type: aws.String("string")},
					{Name: aws.String("trace_id"), Type: aws.String("string")},
					{Name: aws.String("span_id"), Type: aws.String("string")},
					{Name: aws.String("raw"), Type: aws.String("string")},
				},
				Location: aws.String(partLoc),
				InputFormat: aws.String(
					"org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"),
				OutputFormat: aws.String(
					"org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"),
				SerdeInfo: &glutypes.SerDeInfo{
					SerializationLibrary: aws.String(
						"org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"),
					Parameters: map[string]string{"parquet.compression": "SNAPPY"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Glue CreatePartition: %v", err)
	}

	got, err := glueClient.GetPartition(ctx, &glue.GetPartitionInput{
		DatabaseName:    aws.String(glueDB),
		TableName:       aws.String(glueTable),
		PartitionValues: []string{testTenantID, testDT, testHour},
	})
	if err != nil {
		t.Fatalf("Glue GetPartition: %v", err)
	}
	p := got.Partition
	if len(p.Values) != 3 || p.Values[0] != testTenantID || p.Values[1] != testDT || p.Values[2] != testHour {
		t.Errorf("partition Values = %v, want [%s %s %s]", p.Values, testTenantID, testDT, testHour)
	}
	if aws.ToString(p.StorageDescriptor.Location) != partLoc {
		t.Errorf("partition Location = %q, want %q",
			aws.ToString(p.StorageDescriptor.Location), partLoc)
	}

	t.Logf("PASS: Glue CreatePartition + GetPartition round-trips partition "+
		"[tenant_id=%s dt=%s hour=%s] at %s",
		testTenantID, testDT, testHour, partLoc)
}

// ---------------------------------------------------------------------------
// Sub-test: Firehose → S3 delivery fidelity (the primary cold-tier path).
//
// EXPECTED RESULT: FAIL — but for fidelity reasons, NOT non-delivery.
//
// This test settles the IAM-role confound raised in review: an unauthorized or
// missing delivery role would produce zero S3 objects with no caller-visible
// error, which is indistinguishable from a delivery stub. So we:
//
//  1. Create a recognized IAM delivery role (Firehose trust + S3 write policy),
//     eliminating the role variable.
//  2. Configure the stream with the cold-tier.md design: Parquet conversion
//     (DataFormatConversionConfiguration referencing the Glue table) and the
//     §1 dynamic-partition prefix.
//  3. Assert the DescribeDeliveryStream SHAPE — floci collapses the extended
//     config to a plain S3DestinationDescription, the first fidelity signal.
//  4. Send EXACTLY firehoseFlushCount (5) records to trigger floci's hard-coded
//     count-based flush (there is NO time-based flush in floci 1.5.28), so we
//     observe its real delivery, then assert the cold-tier requirements:
//       (a) the object is Parquet  → floci writes raw NDJSON       → FAIL
//       (b) the key has the substituted tenant_id=/dt=/hour= path  → floci
//           writes the !{...} placeholders LITERALLY               → FAIL
//
// Root cause (floci source, FirehoseService.java @ tag 1.5.28): flush() writes
// raw NDJSON via s3Service.putObject and resolvePrefix only substitutes
// {year}/{month}/{day}/{hour}, never the real-Firehose !{...} expressions, and
// no Parquet/DataFormatConversion path exists. See findings doc §3.
// ---------------------------------------------------------------------------

func testFirehoseDeliveryFidelity(t *testing.T, ctx context.Context,
	fhClient *firehose.Client, s3Client *s3.Client, iamClient *iam.Client) {
	t.Helper()

	// --- (1) Eliminate the IAM-role confound: create a recognized delivery role.
	ensureFirehoseRole(t, ctx, iamClient)

	// Run-unique isolation segment so leftover objects from prior runs / manual
	// probing cannot pollute the scan. The §1 dynamic-partition layout follows it.
	runPrefix := fmt.Sprintf("logs/_fh_fidelity_%d/", time.Now().UnixNano())
	streamPrefix := runPrefix + firehoseDynSuffix

	// Clean up prior runs.
	_, _ = fhClient.DeleteDeliveryStream(ctx, &firehose.DeleteDeliveryStreamInput{
		DeliveryStreamName: aws.String(streamName),
	})
	time.Sleep(2 * time.Second)

	// --- (2) Create the stream per cold-tier.md: Parquet conversion + §1 prefix.
	_, err := fhClient.CreateDeliveryStream(ctx, &firehose.CreateDeliveryStreamInput{
		DeliveryStreamName: aws.String(streamName),
		DeliveryStreamType: firetypes.DeliveryStreamTypeDirectPut,
		ExtendedS3DestinationConfiguration: &firetypes.ExtendedS3DestinationConfiguration{
			RoleARN:   aws.String(firehoseRoleARN), // the recognized role
			BucketARN: aws.String("arn:aws:s3:::" + coldBucket),
			Prefix:    aws.String(streamPrefix),
			BufferingHints: &firetypes.BufferingHints{
				SizeInMBs:         aws.Int32(1),
				IntervalInSeconds: aws.Int32(1),
			},
			CompressionFormat: firetypes.CompressionFormatUncompressed,
			// cold-tier.md §2: convert the JSON stream to Parquet against the
			// Glue table schema. Real Firehose honours this; floci ignores it.
			DataFormatConversionConfiguration: &firetypes.DataFormatConversionConfiguration{
				Enabled: aws.Bool(true),
				InputFormatConfiguration: &firetypes.InputFormatConfiguration{
					Deserializer: &firetypes.Deserializer{HiveJsonSerDe: &firetypes.HiveJsonSerDe{}},
				},
				OutputFormatConfiguration: &firetypes.OutputFormatConfiguration{
					Serializer: &firetypes.Serializer{
						ParquetSerDe: &firetypes.ParquetSerDe{
							Compression: firetypes.ParquetCompressionSnappy,
						},
					},
				},
				SchemaConfiguration: &firetypes.SchemaConfiguration{
					RoleARN:      aws.String(firehoseRoleARN),
					DatabaseName: aws.String(glueDB),
					TableName:    aws.String(glueTable),
					Region:       aws.String("us-east-1"),
					VersionId:    aws.String("LATEST"),
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Firehose CreateDeliveryStream: %v", err)
	}

	if err := waitFirehoseActive(ctx, fhClient, streamName, 30*time.Second); err != nil {
		t.Fatalf("stream never became ACTIVE: %v", err)
	}
	t.Log("Firehose stream is ACTIVE (recognized role attached; IAM-role confound eliminated)")

	// --- (3) Assert the Describe SHAPE: floci drops the extended/Parquet config.
	desc, err := fhClient.DescribeDeliveryStream(ctx, &firehose.DescribeDeliveryStreamInput{
		DeliveryStreamName: aws.String(streamName),
	})
	if err != nil {
		t.Fatalf("Firehose DescribeDeliveryStream: %v", err)
	}
	dests := desc.DeliveryStreamDescription.Destinations
	if len(dests) == 1 {
		d := dests[0]
		hasExtended := d.ExtendedS3DestinationDescription != nil
		hasPlainS3 := d.S3DestinationDescription != nil
		t.Logf("Describe shape: ExtendedS3DestinationDescription present=%v, "+
			"S3DestinationDescription present=%v", hasExtended, hasPlainS3)
		if !hasExtended {
			t.Errorf("FIDELITY GAP (Describe): floci did not round-trip the "+
				"ExtendedS3DestinationConfiguration (Parquet conversion + role). "+
				"Describe returned S3DestinationDescription=%v / Extended=%v — the "+
				"DataFormatConversionConfiguration is silently dropped.",
				hasPlainS3, hasExtended)
		}
	}

	// --- (4) Send exactly the flush threshold to trigger floci's real delivery.
	batch := make([]firetypes.Record, 0, firehoseFlushCount)
	for i := 0; i < firehoseFlushCount; i++ {
		// Raw JSON bytes — the SDK base64-encodes them for the wire.
		rec := fmt.Sprintf(
			`{"tenant_id":%q,"ts":"2026-06-27T21:30:00.000Z","id":"fh-%04d","service":"orders","level":"warn","message":"firehose-fidelity-%d"}`,
			testTenantID, i, i)
		batch = append(batch, firetypes.Record{Data: []byte(rec)})
	}
	batchOut, err := fhClient.PutRecordBatch(ctx, &firehose.PutRecordBatchInput{
		DeliveryStreamName: aws.String(streamName),
		Records:            batch,
	})
	if err != nil {
		t.Fatalf("Firehose PutRecordBatch: %v", err)
	}
	t.Logf("PutRecordBatch accepted %d records (== flush threshold): FailedPutCount=%d",
		firehoseFlushCount, aws.ToInt32(batchOut.FailedPutCount))

	// Poll for THIS run's delivered object under the run-unique prefix (floci
	// honours the bucket + prefix, so it lands under runPrefix with the LITERAL
	// placeholder segment). Scanning by runPrefix isolates us from any leftover or
	// direct-write objects. Window is short because floci flushes synchronously on
	// the threshold-crossing PutRecordBatch.
	const pollWindow = 30 * time.Second
	const pollInterval = 3 * time.Second
	t.Logf("Polling s3://%s/%s for this run's flushed object (window=%s)...",
		coldBucket, runPrefix, pollWindow)

	var delivered *firehoseObject
	start := time.Now()
	for time.Since(start) < pollWindow {
		obj := findFirehoseFlush(t, ctx, s3Client, runPrefix)
		if obj != nil {
			delivered = obj
			break
		}
		time.Sleep(pollInterval)
	}

	if delivered == nil {
		// With a recognized role AND ≥5 records, non-delivery would mean a true
		// stub. We did not observe that — but if a future floci changes behaviour,
		// this fatal documents it as still-unusable.
		t.Fatal(
			"FAIL: with a recognized delivery role and exactly the flush-count " +
				"records, floci delivered 0 objects to S3. Either way the Firehose " +
				"path is unusable for the cold tier; use the direct-write fallback. " +
				"See docs/data/spikes/013-firehose-glue-fidelity.md.")
		return
	}

	t.Logf("floci DID deliver: key=%q size=%d (delivery works — so the FAIL below "+
		"is a FIDELITY gap, not a stub and not the IAM role)", delivered.key, delivered.size)

	// (4a) cold-tier.md §2 requires Parquet. floci writes raw NDJSON.
	if !bytes.HasPrefix(delivered.body, []byte("PAR1")) {
		preview := delivered.body
		if len(preview) > 80 {
			preview = preview[:80]
		}
		t.Errorf("FIDELITY GAP (format): cold-tier.md §2 requires Parquet "+
			"(magic 'PAR1'); floci delivered non-Parquet content. First bytes: %q. "+
			"floci's DataFormatConversionConfiguration is a no-op — it writes raw "+
			"NDJSON, which the Glue Parquet serde cannot read.", preview)
	}

	// (4b) cold-tier.md §1 requires the substituted tenant_id=/dt=/hour= path.
	// floci writes the real-Firehose !{...} expressions literally.
	if strings.Contains(delivered.key, "!{") {
		t.Errorf("FIDELITY GAP (partitioning): cold-tier.md §1 requires the key "+
			"…/tenant_id=<uuid>/dt=<date>/hour=<HH>/…; floci wrote the dynamic-"+
			"partition expressions LITERALLY: %q. The data is unreachable as Hive "+
			"partitions — Glue/Athena cannot discover it.", delivered.key)
	}

	// Both assertions are expected to fail; surface the recommendation once.
	t.Logf("VERDICT: floci Firehose delivers but is NON-FAITHFUL (NDJSON not Parquet; " +
		"placeholders not substituted; count-only flush, no time flush). " +
		"Recommendation: ColdArchive uses processor direct-write Parquet + explicit " +
		"CreatePartition. See docs/data/spikes/013-firehose-glue-fidelity.md §6.")
}

// firehoseObject is a delivered S3 object captured for fidelity assertions.
type firehoseObject struct {
	key  string
	size int64
	body []byte
}

// findFirehoseFlush scans the run-unique prefix for the Firehose flush object
// (floci writes it as <streamPrefix><uuid>.json). Returns the first match with its
// body, or nil. The runPrefix isolates this run from leftover/direct-write objects.
func findFirehoseFlush(t *testing.T, ctx context.Context, s3Client *s3.Client, runPrefix string) *firehoseObject {
	t.Helper()
	list, err := s3Client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String(coldBucket),
		Prefix: aws.String(runPrefix),
	})
	if err != nil {
		t.Fatalf("S3 ListObjectsV2: %v", err)
	}
	for _, obj := range list.Contents {
		key := aws.ToString(obj.Key)
		out, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(coldBucket),
			Key:    aws.String(key),
		})
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(out.Body)
		_ = out.Body.Close()
		return &firehoseObject{key: key, size: aws.ToInt64(obj.Size), body: body}
	}
	return nil
}

// ensureFirehoseRole creates an IAM role with a Firehose trust policy and an
// inline S3-write policy, so a missing/unauthorized role cannot be the cause of
// any delivery failure. Idempotent.
func ensureFirehoseRole(t *testing.T, ctx context.Context, iamClient *iam.Client) {
	t.Helper()
	const trust = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"firehose.amazonaws.com"},"Action":"sts:AssumeRole"}]}`
	_, err := iamClient.CreateRole(ctx, &iam.CreateRoleInput{
		RoleName:                 aws.String(firehoseRoleName),
		AssumeRolePolicyDocument: aws.String(trust),
		Description:              aws.String("Firehose→S3 delivery role (spike #13 confound control)"),
	})
	if err != nil && !isAlreadyExists(err) {
		t.Fatalf("IAM CreateRole: %v", err)
	}
	policy := fmt.Sprintf(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:GetBucketLocation","s3:ListBucket","s3:AbortMultipartUpload"],"Resource":["arn:aws:s3:::%s","arn:aws:s3:::%s/*"]}]}`,
		coldBucket, coldBucket)
	_, err = iamClient.PutRolePolicy(ctx, &iam.PutRolePolicyInput{
		RoleName:       aws.String(firehoseRoleName),
		PolicyName:     aws.String("firehose-s3-write"),
		PolicyDocument: aws.String(policy),
	})
	if err != nil {
		t.Fatalf("IAM PutRolePolicy: %v", err)
	}
	t.Logf("IAM role %q ready (Firehose trust + S3 write) — role confound eliminated",
		firehoseRoleName)
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// mustFlociConfig builds an AWS SDK config pointed at compose floci.
// Reads FLOCI_ENDPOINT (default http://localhost:4566), AWS_REGION (default
// us-east-1), AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (default "test"/"test").
func mustFlociConfig(t *testing.T) aws.Config {
	t.Helper()

	envOr := func(key, def string) string {
		if v, ok := os.LookupEnv(key); ok && v != "" {
			return v
		}
		return def
	}

	endpoint := envOr("FLOCI_ENDPOINT", "http://localhost:4566")
	region := envOr("AWS_REGION", "us-east-1")
	accessKey := envOr("AWS_ACCESS_KEY_ID", "test")
	secretKey := envOr("AWS_SECRET_ACCESS_KEY", "test")

	t.Logf("floci endpoint: %s region: %s", endpoint, region)

	ep := aws.Endpoint{ //nolint:staticcheck // SDK v2 custom endpoint pattern
		URL:               endpoint,
		SigningRegion:     region,
		HostnameImmutable: true,
	}

	cfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithRegion(region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			accessKey, secretKey, "")),
		config.WithEndpointResolver( //nolint:staticcheck
			aws.EndpointResolverFunc( //nolint:staticcheck
				func(service, reg string) (aws.Endpoint, error) { //nolint:staticcheck
					return ep, nil
				}),
		),
	)
	if err != nil {
		t.Fatalf("aws config: %v", err)
	}
	return cfg
}

func ensureBucket(t *testing.T, ctx context.Context, s3Client *s3.Client, bucket string) {
	t.Helper()
	_, err := s3Client.CreateBucket(ctx, &s3.CreateBucketInput{
		Bucket: aws.String(bucket),
	})
	if err != nil && !isAlreadyExists(err) {
		t.Fatalf("ensure bucket %q: %v", bucket, err)
	}
}

func ensureGlueDB(t *testing.T, ctx context.Context, glueClient *glue.Client, dbName string) {
	t.Helper()
	_, err := glueClient.CreateDatabase(ctx, &glue.CreateDatabaseInput{
		DatabaseInput: &glutypes.DatabaseInput{
			Name:        aws.String(dbName),
			Description: aws.String("Spike isolated Glue DB (issue #13)"),
		},
	})
	if err != nil && !isAlreadyExists(err) {
		t.Fatalf("ensure Glue DB %q: %v", dbName, err)
	}
}

func waitFirehoseActive(ctx context.Context, fhClient *firehose.Client, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		desc, err := fhClient.DescribeDeliveryStream(ctx, &firehose.DescribeDeliveryStreamInput{
			DeliveryStreamName: aws.String(name),
		})
		if err != nil {
			return fmt.Errorf("DescribeDeliveryStream: %w", err)
		}
		if desc.DeliveryStreamDescription.DeliveryStreamStatus == firetypes.DeliveryStreamStatusActive {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("stream %q not ACTIVE after %s", name, timeout)
}

func isAlreadyExists(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "AlreadyExists") ||
		strings.Contains(s, "BucketAlreadyExists") ||
		strings.Contains(s, "BucketAlreadyOwnedByYou")
}
