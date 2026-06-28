// Package s3 holds the S3 cold-purger adapter. It deletes expired Parquet
// objects from the tenant's cold prefix using ListObjectsV2 + DeleteObjects.
//
// TENANT ISOLATION INVARIANT (ADR-0002, cold-tier.md §1):
//
//	The S3 prefix is ALWAYS constructed as
//	    logs/tenant_id=<tenantID>/
//	where tenantID comes from retention_policies.tenant_id in the DB — a
//	verified UUID, never from user input. The leading "logs/tenant_id=<uuid>/"
//	segment is the structural cold-isolation boundary: a bug in one tenant's
//	cold_days cannot reach another tenant's objects because the object key is
//	compared against the prefix AFTER the tenant segment is set.
package s3

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/bRRRITSCOLD/logalot/services/retention-worker/internal/app"
)

const (
	// maxDeleteBatch is the S3 DeleteObjects maximum objects per request.
	maxDeleteBatch = 1000
)

// Purger implements app.ColdPurger using the AWS S3 API. On floci, it
// targets the endpoint specified by the service configuration (endpoint :4566,
// image floci/floci — per memory note).
//
// NOTE: The Purger does NOT use Athena or Glue; it operates purely on S3
// object keys. Deleting expired prefixes does not require deregistering Glue
// partitions because partition projection (cold-tier.md §3) discovers
// prefixes dynamically — if the prefix doesn't exist, the query simply returns
// no rows.
type Purger struct {
	client s3Client
	bucket string
}

// s3Client is the narrow interface the purger depends on. In production this
// is a *s3.Client; in unit tests it is a fake.
type s3Client interface {
	ListObjectsV2(ctx context.Context, params *s3.ListObjectsV2Input, optFns ...func(*s3.Options)) (*s3.ListObjectsV2Output, error)
	DeleteObjects(ctx context.Context, params *s3.DeleteObjectsInput, optFns ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error)
}

// compile-time proof the adapter satisfies the app port.
var _ app.ColdPurger = (*Purger)(nil)

// New builds a Purger over a real S3 client. bucket is the cold-tier bucket
// (e.g. "logalot-cold"). The client must be configured with the correct
// endpoint and credentials (floci for local dev, real AWS for production).
func New(client *s3.Client, bucket string) *Purger {
	return &Purger{client: client, bucket: bucket}
}

// newWithFake builds a Purger over an injected fake (tests only).
func newWithFake(fake s3Client, bucket string) *Purger {
	return &Purger{client: fake, bucket: bucket}
}

// PurgeExpiredPrefixes deletes all S3 objects in the tenant's cold prefix
// whose dt partition is strictly before cutoffDate.
//
// Algorithm:
//  1. List all objects under logs/tenant_id=<tenantID>/ (paginated).
//  2. For each object, parse the dt= segment from its key.
//  3. Collect keys whose dt < cutoffDate.
//  4. Delete in batches of 1000 (S3 DeleteObjects max).
//
// Security: tenantID is a UUID from the DB (retention_policies.tenant_id).
// It is used as a path element only — never interpreted as code.
// The prefix is always "logs/tenant_id=<uuid>/", so listing can only return
// objects belonging to that tenant.
func (p *Purger) PurgeExpiredPrefixes(ctx context.Context, tenantID string, cutoffDate time.Time) (int, error) {
	// Construct the tenant-scoped S3 prefix. tenant_id is the FIRST and
	// LEADING path element — this is the structural cold isolation boundary
	// (cold-tier.md §1). All listed objects are under this tenant's prefix.
	prefix := tenantColdPrefix(tenantID)

	var toDelete []types.ObjectIdentifier
	var continuationToken *string

	for {
		out, err := p.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(p.bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: continuationToken,
		})
		if err != nil {
			return 0, fmt.Errorf("coldpurger: list objects (tenant=%s): %w", tenantID, err)
		}

		for _, obj := range out.Contents {
			key := aws.ToString(obj.Key)
			dt, ok := parseDtFromKey(key)
			if !ok {
				// Non-date-keyed object under the prefix — skip, don't delete.
				continue
			}
			if dt.Before(cutoffDate) {
				toDelete = append(toDelete, types.ObjectIdentifier{
					Key: aws.String(key),
				})
			}
		}

		if !aws.ToBool(out.IsTruncated) {
			break
		}
		continuationToken = out.NextContinuationToken
	}

	if len(toDelete) == 0 {
		return 0, nil
	}

	deleted, err := p.deleteBatched(ctx, toDelete)
	return deleted, err
}

// deleteBatched submits toDelete to S3 DeleteObjects in batches of
// maxDeleteBatch (1000). Returns the total number of successfully deleted
// objects. A partial batch failure returns the count deleted so far plus the
// error.
func (p *Purger) deleteBatched(ctx context.Context, keys []types.ObjectIdentifier) (int, error) {
	deleted := 0
	for i := 0; i < len(keys); i += maxDeleteBatch {
		end := i + maxDeleteBatch
		if end > len(keys) {
			end = len(keys)
		}
		batch := keys[i:end]

		out, err := p.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(p.bucket),
			Delete: &types.Delete{
				Objects: batch,
				Quiet:   aws.Bool(true),
			},
		})
		if err != nil {
			return deleted, fmt.Errorf("coldpurger: delete batch [%d..%d]: %w", i, end, err)
		}
		if len(out.Errors) > 0 {
			// S3 reports per-key errors inside a 200 response when Quiet=false.
			// With Quiet=true we get errors here. Report the first one.
			e := out.Errors[0]
			return deleted, fmt.Errorf(
				"coldpurger: delete error for key %s: code=%s msg=%s",
				aws.ToString(e.Key), aws.ToString(e.Code), aws.ToString(e.Message))
		}
		deleted += len(batch)
	}
	return deleted, nil
}

// tenantColdPrefix returns the S3 key prefix for a tenant's cold objects.
// Format: logs/tenant_id=<uuid>/
//
// cold-tier.md §1: tenant_id is the LEADING partition element; every object
// under this prefix belongs to exactly this tenant. Never constructed from
// user input — tenantID is a verified UUID from the DB.
func tenantColdPrefix(tenantID string) string {
	return fmt.Sprintf("logs/tenant_id=%s/", tenantID)
}

// parseDtFromKey extracts the dt=YYYY-MM-DD segment from an S3 key. Returns
// the parsed date and true, or zero time and false if the key has no dt=
// segment or the date is malformed.
//
// Expected key format:
//
//	logs/tenant_id=<uuid>/dt=2026-01-15/hour=10/batch.parquet
//
// The function is intentionally lenient — keys without a dt= segment (e.g.
// metadata objects) are skipped rather than erroring.
func parseDtFromKey(key string) (time.Time, bool) {
	// Find the "/dt=" segment.
	const dtMarker = "/dt="
	idx := strings.Index(key, dtMarker)
	if idx < 0 {
		return time.Time{}, false
	}
	rest := key[idx+len(dtMarker):]
	// The date ends at the next "/" or end of string.
	dtStr := rest
	if slashIdx := strings.IndexByte(rest, '/'); slashIdx >= 0 {
		dtStr = rest[:slashIdx]
	}
	if len(dtStr) != 10 { // YYYY-MM-DD
		return time.Time{}, false
	}
	t, err := time.Parse("2006-01-02", dtStr)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}
