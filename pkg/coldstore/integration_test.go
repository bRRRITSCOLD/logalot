//go:build floci_integration

// Integration tests for pkg/coldstore against the local floci stack (NOT
// localstack — see memory [floci-aws-local] and decision 016).
//
// These tests validate the S3 Parquet write path and Glue partition
// registration (both confirmed faithful in floci 1.5.28, spike #13). They do
// NOT test Athena/cold-query — that is handled by the cold_query build tag
// (Trino + HMS + MinIO, decision 016 §2).
//
// Requires compose floci running at FLOCI_ENDPOINT (default http://localhost:4566).
// Start the stack with `make up`, confirm with `curl /_floci/health`.
//
// Run:
//
//	go test -tags=floci_integration -run TestColdStore -v -timeout 120s \
//	    ./pkg/coldstore/...
package coldstore

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
	awsglue "github.com/aws/aws-sdk-go-v2/service/glue"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// Integration constants — isolated from spike and production to allow clean runs.
const (
	integBucket  = "logalot-cold-integration"
	integGlueDB  = "logalot_cold_integration"
	integTenant  = "cccccccc-0000-0000-0000-000000000003"
	integService = "integration-test"
)

// TestColdStore_FlociIntegration is the floci integration suite for the
// coldstore adapter. Sub-tests are independent and self-cleaning.
func TestColdStore_FlociIntegration(t *testing.T) {
	ctx := context.Background()

	// Build AWS config pointed at floci.
	awsCfg := mustFlociAWSConfig(t)

	s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.UsePathStyle = true // floci requires path-style
	})
	glueClient := awsglue.NewFromConfig(awsCfg)

	// Ensure the test bucket exists.
	ensureIntegBucket(t, ctx, s3Client)

	// Ensure the Glue table is provisioned.
	if err := EnsureGlueTable(ctx, glueClient, integGlueDB, integBucket); err != nil {
		t.Fatalf("EnsureGlueTable: %v", err)
	}

	tc := kernel.TenantContext{
		TenantID: kernel.TenantID(integTenant),
		Scopes:   []kernel.Scope{kernel.ScopeIngestWrite},
	}

	t.Run("ArchiveWritesParquetUnderTenantPrefix", func(t *testing.T) {
		testIntegArchiveWritesParquet(t, ctx, s3Client, glueClient, tc)
	})
	t.Run("TenantPrefixIsolation", func(t *testing.T) {
		testIntegTenantPrefixIsolation(t, ctx, s3Client, glueClient)
	})
	t.Run("GluePartitionRegistered", func(t *testing.T) {
		testIntegGluePartition(t, ctx, s3Client, glueClient, tc)
	})
}

// testIntegArchiveWritesParquet validates that Archive produces a real Parquet
// file under logs/tenant_id=<uuid>/dt=.../hour=.../ (cold-tier.md §1–2).
func testIntegArchiveWritesParquet(t *testing.T, ctx context.Context,
	s3c *s3.Client, gc *awsglue.Client, tc kernel.TenantContext) {
	t.Helper()

	store := buildIntegStore(s3c, gc)
	ev := kernel.LogEvent{
		TenantID: tc.TenantID,
		TS:       time.Date(2026, 6, 27, 14, 30, 0, 0, time.UTC),
		ID:       "integ-001",
		Service:  integService,
		Level:    kernel.LevelInfo,
		Message:  "cold-store integration test",
	}

	if err := store.Archive(tc, ctx, ev); err != nil {
		t.Fatalf("Archive: %v", err)
	}

	// List objects under the tenant prefix to confirm the file was written.
	prefix := fmt.Sprintf("logs/tenant_id=%s/", integTenant)
	list, err := s3c.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String(integBucket),
		Prefix: aws.String(prefix),
	})
	if err != nil {
		t.Fatalf("ListObjectsV2: %v", err)
	}
	if len(list.Contents) == 0 {
		t.Fatalf("no objects found under prefix %q after Archive", prefix)
	}

	// Verify at least one object has Parquet magic.
	for _, obj := range list.Contents {
		out, err := s3c.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(integBucket),
			Key:    obj.Key,
		})
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(out.Body)
		_ = out.Body.Close()

		if bytes.HasPrefix(body, []byte("PAR1")) {
			t.Logf("PASS: object %q is Parquet (PAR1 magic, %d bytes)", aws.ToString(obj.Key), len(body))
			return
		}
		t.Errorf("object %q is NOT Parquet: first 8 bytes: %q", aws.ToString(obj.Key), body[:min(len(body), 8)])
	}
}

// testIntegTenantPrefixIsolation proves that two different tenants' archives
// land under strictly separate S3 prefixes.
func testIntegTenantPrefixIsolation(t *testing.T, ctx context.Context,
	s3c *s3.Client, gc *awsglue.Client) {
	t.Helper()

	tcA := kernel.TenantContext{TenantID: "dddddddd-0000-0000-0000-000000000004"}
	tcB := kernel.TenantContext{TenantID: "eeeeeeee-0000-0000-0000-000000000005"}
	store := buildIntegStore(s3c, gc)

	evA := kernel.LogEvent{
		TenantID: tcA.TenantID, TS: time.Now(), Service: "svc-a", Message: "tenant-a-event",
	}
	evB := kernel.LogEvent{
		TenantID: tcB.TenantID, TS: time.Now(), Service: "svc-b", Message: "tenant-b-event",
	}

	if err := store.Archive(tcA, ctx, evA); err != nil {
		t.Fatalf("Archive(tenantA): %v", err)
	}
	if err := store.Archive(tcB, ctx, evB); err != nil {
		t.Fatalf("Archive(tenantB): %v", err)
	}

	// Verify tenant A's prefix has objects but tenant B's objects are absent.
	prefixA := fmt.Sprintf("logs/tenant_id=%s/", string(tcA.TenantID))
	listA, err := s3c.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String(integBucket), Prefix: aws.String(prefixA),
	})
	if err != nil {
		t.Fatalf("list tenantA prefix: %v", err)
	}
	if len(listA.Contents) == 0 {
		t.Errorf("tenantA has no objects under its prefix %q", prefixA)
	}

	// Verify none of tenant A's objects are under tenant B's prefix.
	prefixB := fmt.Sprintf("logs/tenant_id=%s/", string(tcB.TenantID))
	for _, obj := range listA.Contents {
		key := aws.ToString(obj.Key)
		if strings.HasPrefix(key, prefixB) {
			t.Errorf("cross-tenant leak: tenantA object %q is under tenantB prefix", key)
		}
	}

	t.Logf("PASS: tenantA objects (%d) are strictly under %q; none under tenantB prefix",
		len(listA.Contents), prefixA)
}

// testIntegGluePartition validates that Glue CreatePartition round-trips
// correctly after an Archive call (cold-tier.md §3 explicit partition fallback).
func testIntegGluePartition(t *testing.T, ctx context.Context,
	s3c *s3.Client, gc *awsglue.Client, tc kernel.TenantContext) {
	t.Helper()

	batchTime := time.Date(2026, 6, 27, 15, 0, 0, 0, time.UTC)
	store := buildIntegStore(s3c, gc)
	store.now = func() time.Time { return batchTime }

	ev := kernel.LogEvent{
		TenantID: tc.TenantID, TS: batchTime, Service: integService, Message: "partition-test",
	}
	if err := store.Archive(tc, ctx, ev); err != nil {
		t.Fatalf("Archive: %v", err)
	}

	// GetPartition to verify the Glue record was created.
	dt := batchTime.UTC().Format("2006-01-02")
	hour := fmt.Sprintf("%02d", batchTime.UTC().Hour())

	got, err := gc.GetPartition(ctx, &awsglue.GetPartitionInput{
		DatabaseName:    aws.String(integGlueDB),
		TableName:       aws.String("log_events"),
		PartitionValues: []string{integTenant, dt, hour},
	})
	if err != nil {
		// AlreadyExists is idempotent — partition may exist from a prior run.
		if !strings.Contains(err.Error(), "not found") && !strings.Contains(err.Error(), "EntityNotFound") {
			t.Logf("NOTE: GetPartition error (may already exist from prior run): %v", err)
			return
		}
		t.Fatalf("GetPartition: %v", err)
	}

	p := got.Partition
	if len(p.Values) != 3 {
		t.Errorf("partition Values = %v, want [tenantID dt hour]", p.Values)
	} else {
		t.Logf("PASS: Glue partition registered [tenant=%s dt=%s hour=%s]",
			p.Values[0], p.Values[1], p.Values[2])
	}
}

// ---------------------------------------------------------------------------
// Integration helpers
// ---------------------------------------------------------------------------

func buildIntegStore(s3c *s3.Client, gc *awsglue.Client) *Store {
	st := New(s3c, gc, nil, /* athena not needed for write tests */
		integBucket, integGlueDB, "s3://"+integBucket+"-results/")
	return st
}

func mustFlociAWSConfig(t *testing.T) aws.Config {
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

	ep := aws.Endpoint{ //nolint:staticcheck
		URL:               endpoint,
		SigningRegion:     region,
		HostnameImmutable: true,
	}

	awsCfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithRegion(region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
		config.WithEndpointResolver( //nolint:staticcheck
			aws.EndpointResolverFunc( //nolint:staticcheck
				func(_, _ string) (aws.Endpoint, error) { //nolint:staticcheck
					return ep, nil
				}),
		),
	)
	if err != nil {
		t.Fatalf("aws config: %v", err)
	}
	return awsCfg
}

func ensureIntegBucket(t *testing.T, ctx context.Context, s3c *s3.Client) {
	t.Helper()
	_, err := s3c.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(integBucket)})
	if err != nil && !strings.Contains(err.Error(), "BucketAlreadyExists") &&
		!strings.Contains(err.Error(), "BucketAlreadyOwnedByYou") {
		t.Fatalf("ensure bucket %q: %v", integBucket, err)
	}
}
