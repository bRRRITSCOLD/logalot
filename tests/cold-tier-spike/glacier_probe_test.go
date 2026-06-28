//go:build floci_spike

// Reproducible probe for issue #15 part (b): floci Glacier / S3 lifecycle support.
//
// Probes three questions:
//  1. Does PutBucketLifecycleConfiguration accept a Glacier transition rule, and does
//     GetBucketLifecycleConfiguration round-trip it?
//  2. Does PutObject with StorageClass=GLACIER store and return a GLACIER storage class?
//  3. Does RestoreObject acknowledge or act on a restore request (Glacier retrieval)?
//
// This test records honest verdicts — PASS means the API round-trips the field;
// STUB means the call succeeds but floci silently ignores the semantic.
// There is no expected PASS/FAIL orientation here: we record what we find.
//
// Run against compose floci (make up first):
//
//	go test -tags=floci_spike -run TestGlacierLifecycleProbe -v -timeout 120s \
//	    ./tests/cold-tier-spike/...
package coldtierspike

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const glacierProbeBucket = "logalot-glacier-probe"

// TestGlacierLifecycleProbe is the issue #15 probe for floci Glacier / S3 lifecycle
// support. Each sub-test is independent and self-cleaning.
func TestGlacierLifecycleProbe(t *testing.T) {
	ctx := context.Background()
	cfg := mustFlociConfig(t)

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true
	})

	ensureBucket(t, ctx, s3Client, glacierProbeBucket)

	t.Run("LifecycleConfigRoundTrip", func(t *testing.T) {
		testLifecycleConfigRoundTrip(t, ctx, s3Client)
	})
	t.Run("StorageClassGlacierPutObject", func(t *testing.T) {
		testStorageClassGlacierPutObject(t, ctx, s3Client)
	})
	t.Run("RestoreObjectStub", func(t *testing.T) {
		testRestoreObjectStub(t, ctx, s3Client)
	})
}

// ---------------------------------------------------------------------------
// Probe 1: PutBucketLifecycleConfiguration with a Glacier transition rule.
// Does floci accept the call and round-trip the transition?
// ---------------------------------------------------------------------------

func testLifecycleConfigRoundTrip(t *testing.T, ctx context.Context, s3Client *s3.Client) {
	t.Helper()

	// Put a lifecycle rule that transitions objects to GLACIER after 30 days.
	// This mirrors the eventual cold-tier tiering trigger: "cold storage cost
	// becomes material → introduce S3 lifecycle-to-Glacier" (ADR-0005 §revisit).
	ruleID := fmt.Sprintf("glacier-transition-probe-%d", time.Now().UnixNano())
	_, putErr := s3Client.PutBucketLifecycleConfiguration(ctx, &s3.PutBucketLifecycleConfigurationInput{
		Bucket: aws.String(glacierProbeBucket),
		LifecycleConfiguration: &s3types.BucketLifecycleConfiguration{
			Rules: []s3types.LifecycleRule{
				{
					ID:     aws.String(ruleID),
					Status: s3types.ExpirationStatusEnabled,
					Filter: &s3types.LifecycleRuleFilter{
						Prefix: aws.String("logs/"),
					},
					Transitions: []s3types.Transition{
						{
							Days:         aws.Int32(30),
							StorageClass: s3types.TransitionStorageClassGlacier,
						},
					},
				},
			},
		},
	})
	if putErr != nil {
		// If floci returns an unsupported error, that itself is the finding.
		t.Logf("PROBE (LifecycleConfig): PutBucketLifecycleConfiguration error: %v", putErr)
		if isNotImplemented(putErr) {
			t.Logf("VERDICT: floci returns NotImplemented/UnsupportedOperation for " +
				"PutBucketLifecycleConfiguration — lifecycle API NOT supported.")
		} else {
			t.Errorf("PutBucketLifecycleConfiguration unexpected error: %v", putErr)
		}
		return
	}
	t.Logf("PROBE (LifecycleConfig): PutBucketLifecycleConfiguration succeeded (no error)")

	// Get the configuration back and check whether the Glacier transition survived.
	getOut, getErr := s3Client.GetBucketLifecycleConfiguration(ctx, &s3.GetBucketLifecycleConfigurationInput{
		Bucket: aws.String(glacierProbeBucket),
	})
	if getErr != nil {
		t.Logf("PROBE (LifecycleConfig): GetBucketLifecycleConfiguration error: %v", getErr)
		if isNotImplemented(getErr) {
			t.Logf("VERDICT: floci returns NotImplemented for GetBucketLifecycleConfiguration " +
				"even after a successful Put — likely stored but not round-tripped.")
		} else {
			t.Errorf("GetBucketLifecycleConfiguration unexpected error: %v", getErr)
		}
		return
	}

	// Inspect the round-tripped rules.
	foundRule := false
	foundTransition := false
	for _, rule := range getOut.Rules {
		if aws.ToString(rule.ID) == ruleID {
			foundRule = true
			for _, tr := range rule.Transitions {
				if tr.StorageClass == s3types.TransitionStorageClassGlacier {
					foundTransition = true
				}
			}
		}
	}

	switch {
	case foundRule && foundTransition:
		t.Logf("VERDICT LifecycleConfig: ROUND-TRIP PASS — rule ID %q survived with "+
			"StorageClass=GLACIER transition. floci stores and returns the lifecycle "+
			"configuration. (Whether floci ENFORCES the transition at object level is "+
			"a separate question probed in StorageClassGlacierPutObject.)", ruleID)
	case foundRule && !foundTransition:
		t.Logf("VERDICT LifecycleConfig: PARTIAL — rule %q survived but the "+
			"StorageClass=GLACIER transition was dropped. Rules returned: %d",
			ruleID, len(getOut.Rules))
	default:
		t.Logf("VERDICT LifecycleConfig: RULE NOT FOUND after round-trip. "+
			"Rules returned: %d", len(getOut.Rules))
	}
}

// ---------------------------------------------------------------------------
// Probe 2: PutObject with StorageClass=GLACIER.
// Does floci accept it and return GLACIER in HeadObject?
// ---------------------------------------------------------------------------

func testStorageClassGlacierPutObject(t *testing.T, ctx context.Context, s3Client *s3.Client) {
	t.Helper()

	key := fmt.Sprintf("probe/glacier-sc-%d.txt", time.Now().UnixNano())
	body := []byte("glacier storage class probe — issue #15")

	_, putErr := s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:       aws.String(glacierProbeBucket),
		Key:          aws.String(key),
		Body:         strings.NewReader(string(body)),
		StorageClass: s3types.StorageClassGlacier,
		ContentType:  aws.String("text/plain"),
	})
	if putErr != nil {
		t.Logf("PROBE (StorageClass=GLACIER): PutObject error: %v", putErr)
		if isNotImplemented(putErr) {
			t.Logf("VERDICT StorageClass: floci rejects StorageClass=GLACIER at PutObject " +
				"— NOT supported.")
		} else {
			t.Errorf("PutObject(StorageClass=GLACIER) unexpected error: %v", putErr)
		}
		return
	}
	t.Logf("PROBE (StorageClass=GLACIER): PutObject accepted (no error). Key: %s", key)

	// HeadObject to check what storage class floci returns.
	headOut, headErr := s3Client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(glacierProbeBucket),
		Key:    aws.String(key),
	})
	if headErr != nil {
		t.Logf("PROBE (StorageClass=GLACIER): HeadObject error: %v", headErr)
		return
	}

	returnedSC := string(headOut.StorageClass)
	if returnedSC == "" {
		returnedSC = "(empty / S3-standard-implied)"
	}

	if headOut.StorageClass == s3types.StorageClassGlacier {
		t.Logf("VERDICT StorageClass: ROUND-TRIP PASS — floci returned StorageClass=GLACIER " +
			"on HeadObject. The storage class field is stored and returned. " +
			"(DEEP_ARCHIVE or GLACIER_IR not probed — same API path.)")
	} else {
		t.Logf("VERDICT StorageClass: STORAGE CLASS NOT PRESERVED — PutObject with "+
			"StorageClass=GLACIER succeeded but HeadObject returned StorageClass=%q. "+
			"floci accepts the call but ignores the storage class field.", returnedSC)
	}

	// GetObject to ensure the object is immediately readable (not gated behind restore).
	getOut, getErr := s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(glacierProbeBucket),
		Key:    aws.String(key),
	})
	if getErr != nil {
		t.Logf("PROBE (StorageClass=GLACIER): GetObject error (may require RestoreObject "+
			"if Glacier is enforced): %v", getErr)
		t.Logf("VERDICT StorageClass: Glacier IS enforced — GetObject fails until restored.")
		return
	}
	_ = getOut.Body.Close()
	t.Logf("PROBE (StorageClass=GLACIER): GetObject succeeded immediately — no restore required. " +
		"floci treats GLACIER objects as immediately readable (no real archive tiering enforced).")
}

// ---------------------------------------------------------------------------
// Probe 3: RestoreObject — documented as a stub in floci docs/services/s3.md.
// Confirm the behavior: call succeeds but returns a stub response.
// ---------------------------------------------------------------------------

func testRestoreObjectStub(t *testing.T, ctx context.Context, s3Client *s3.Client) {
	t.Helper()

	// Write a regular object first — RestoreObject only makes sense on a GLACIER object.
	key := fmt.Sprintf("probe/restore-stub-%d.txt", time.Now().UnixNano())
	_, putErr := s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:       aws.String(glacierProbeBucket),
		Key:          aws.String(key),
		Body:         strings.NewReader("restore stub probe"),
		StorageClass: s3types.StorageClassGlacier,
	})
	if putErr != nil {
		t.Logf("PROBE (RestoreObject): PutObject (GLACIER) failed — skipping RestoreObject probe: %v", putErr)
		return
	}

	_, restoreErr := s3Client.RestoreObject(ctx, &s3.RestoreObjectInput{
		Bucket: aws.String(glacierProbeBucket),
		Key:    aws.String(key),
		RestoreRequest: &s3types.RestoreRequest{
			Days: aws.Int32(1),
			GlacierJobParameters: &s3types.GlacierJobParameters{
				Tier: s3types.TierBulk,
			},
		},
	})

	switch {
	case restoreErr == nil:
		t.Logf("VERDICT RestoreObject: STUB PASS — floci accepted RestoreObject without error. " +
			"Per floci docs/services/s3.md: 'RestoreObject is acknowledged but only returns a " +
			"stub response without executing restoration logic.' This confirms: there is no real " +
			"Glacier restore pipeline.")
	case isNotImplemented(restoreErr):
		t.Logf("VERDICT RestoreObject: NOT IMPLEMENTED — floci returned an error for RestoreObject: %v", restoreErr)
	default:
		t.Logf("VERDICT RestoreObject: error %v", restoreErr)
	}
}

// isNotImplemented returns true if the error indicates an unimplemented or unsupported operation.
func isNotImplemented(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "NotImplemented") ||
		strings.Contains(s, "UnsupportedOperation") ||
		strings.Contains(s, "not implemented") ||
		strings.Contains(s, "not supported")
}
