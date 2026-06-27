//go:build floci_spike

// Reproducible integration spike for issue #13: validates floci Firehose→Parquet
// delivery and Glue cataloging fidelity against the cold-tier.md §1–3 design.
//
// Each sub-test is independent and self-cleaning. The suite records an honest
// pass/fail verdict — a FAIL here is the expected, documented result for Firehose.
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
)

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

	ensureBucket(t, ctx, s3Client, coldBucket)
	ensureGlueDB(t, ctx, glueClient, glueDB)

	// Run Glue and direct-S3 tests first (non-Firehose fallback path).
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
	// This sub-test FAILS by design. See findings doc §3.
	t.Run("FirehoseS3Delivery", func(t *testing.T) {
		testFirehoseS3Delivery(t, ctx, fhClient, s3Client)
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
// Sub-test: Firehose → S3 delivery (the primary cold-tier path).
//
// EXPECTED RESULT: FAIL.
// floci 1.5.28 community edition accepts PutRecord / PutRecordBatch (returns
// valid RecordIds) but never delivers to S3. No flush event appears in the
// floci container log even after 90s with a 1-second buffer interval.
// See docs/data/spikes/013-firehose-glue-fidelity.md §3 for full evidence.
// ---------------------------------------------------------------------------

func testFirehoseS3Delivery(t *testing.T, ctx context.Context,
	fhClient *firehose.Client, s3Client *s3.Client) {
	t.Helper()

	// Clean up prior runs.
	_, _ = fhClient.DeleteDeliveryStream(ctx, &firehose.DeleteDeliveryStreamInput{
		DeliveryStreamName: aws.String(streamName),
	})
	time.Sleep(2 * time.Second)

	// Create stream: minimal buffer (1s / 1MB) so we do not wait for the default 60s.
	_, err := fhClient.CreateDeliveryStream(ctx, &firehose.CreateDeliveryStreamInput{
		DeliveryStreamName: aws.String(streamName),
		DeliveryStreamType: firetypes.DeliveryStreamTypeDirectPut,
		ExtendedS3DestinationConfiguration: &firetypes.ExtendedS3DestinationConfiguration{
			RoleARN:   aws.String("arn:aws:iam::000000000000:role/firehose-role"),
			BucketARN: aws.String("arn:aws:s3:::" + coldBucket),
			Prefix:    aws.String("logs/firehose/"),
			BufferingHints: &firetypes.BufferingHints{
				SizeInMBs:         aws.Int32(1),
				IntervalInSeconds: aws.Int32(1),
			},
			CompressionFormat: firetypes.CompressionFormatUncompressed,
		},
	})
	if err != nil {
		t.Fatalf("Firehose CreateDeliveryStream: %v", err)
	}

	// Wait for ACTIVE status.
	if err := waitFirehoseActive(ctx, fhClient, streamName, 30*time.Second); err != nil {
		t.Fatalf("stream never became ACTIVE: %v", err)
	}
	t.Log("Firehose stream is ACTIVE")

	// Put 3 records (raw JSON bytes — the SDK base64-encodes them for the wire).
	batch := []firetypes.Record{
		{Data: []byte(`{"tenant_id":"` + testTenantID + `","ts":"2026-06-27T21:30:00.000Z","id":"b1-0001","service":"orders","level":"warn","message":"firehose-spike-1"}`)},
		{Data: []byte(`{"tenant_id":"` + testTenantID + `","ts":"2026-06-27T21:31:00.000Z","id":"b1-0002","service":"orders","level":"info","message":"firehose-spike-2"}`)},
		{Data: []byte(`{"tenant_id":"` + testTenantID + `","ts":"2026-06-27T21:32:00.000Z","id":"b1-0003","service":"auth","level":"error","message":"firehose-spike-3"}`)},
	}
	batchOut, err := fhClient.PutRecordBatch(ctx, &firehose.PutRecordBatchInput{
		DeliveryStreamName: aws.String(streamName),
		Records:            batch,
	})
	if err != nil {
		t.Fatalf("Firehose PutRecordBatch: %v", err)
	}
	t.Logf("PutRecordBatch accepted: FailedPutCount=%d", aws.ToInt32(batchOut.FailedPutCount))

	// Poll S3 for any object under logs/firehose/. Window = 90s >> 1s buffer.
	const pollWindow = 90 * time.Second
	const pollInterval = 5 * time.Second
	t.Logf("Polling s3://%s/logs/firehose/ for Firehose-delivered objects (window=%s)...",
		coldBucket, pollWindow)

	deadline := time.Now().Add(pollWindow)
	for time.Now().Before(deadline) {
		list, err := s3Client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket: aws.String(coldBucket),
			Prefix: aws.String("logs/firehose/"),
		})
		if err != nil {
			t.Fatalf("S3 ListObjectsV2: %v", err)
		}
		if len(list.Contents) > 0 {
			// Firehose DID deliver — document what landed.
			t.Logf("PASS: Firehose delivered %d object(s) to S3 within %s",
				len(list.Contents), time.Since(deadline.Add(-pollWindow)).Round(time.Second))
			for _, obj := range list.Contents {
				t.Logf("  key=%q size=%d lastModified=%s",
					aws.ToString(obj.Key), obj.Size, obj.LastModified)
			}
			return
		}
		t.Logf("  no objects yet (elapsed %s)", time.Since(deadline.Add(-pollWindow)).Round(time.Second))
		time.Sleep(pollInterval)
	}

	// Nothing arrived. This is the expected negative result. Mark it explicitly.
	t.Fatal(
		"FAIL (expected per spike findings): floci Firehose accepted PutRecordBatch " +
			"(FailedPutCount=0) but delivered 0 objects to S3 within 90s with a 1-second " +
			"buffer interval. The Firehose→S3 delivery loop is a stub in floci 1.5.28 " +
			"community edition — it returns valid RecordIds but never flushes to S3. " +
			"Trigger: switch ColdArchive to processor direct-write + explicit ADD PARTITION. " +
			"See docs/data/spikes/013-firehose-glue-fidelity.md for full findings and recommendation.",
	)
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
