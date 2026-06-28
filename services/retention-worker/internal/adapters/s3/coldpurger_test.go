package s3

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeS3 is an in-memory S3 fake. ListObjectsV2 returns listed objects whose
// keys start with the requested prefix. DeleteObjects tracks deleted keys.
type fakeS3 struct {
	// Keys is the set of all simulated S3 object keys.
	keys    []string
	deleted []string
	listErr error
	delErr  error
}

func (f *fakeS3) ListObjectsV2(_ context.Context, params *s3.ListObjectsV2Input, _ ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	prefix := aws.ToString(params.Prefix)
	var contents []types.Object
	for _, k := range f.keys {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			contents = append(contents, types.Object{Key: aws.String(k)})
		}
	}
	return &s3.ListObjectsV2Output{
		Contents:    contents,
		IsTruncated: aws.Bool(false),
	}, nil
}

func (f *fakeS3) DeleteObjects(_ context.Context, params *s3.DeleteObjectsInput, _ ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	if f.delErr != nil {
		return nil, f.delErr
	}
	for _, obj := range params.Delete.Objects {
		f.deleted = append(f.deleted, aws.ToString(obj.Key))
	}
	return &s3.DeleteObjectsOutput{}, nil
}

// ---------------------------------------------------------------------------
// parseDtFromKey
// ---------------------------------------------------------------------------

var parseDtTests = []struct {
	name   string
	key    string
	wantOK bool
	wantDt string // YYYY-MM-DD
}{
	{
		name:   "valid hive key",
		key:    "logs/tenant_id=abc/dt=2026-01-15/hour=10/batch.parquet",
		wantOK: true, wantDt: "2026-01-15",
	},
	{
		name:   "valid key no trailing slash",
		key:    "logs/tenant_id=abc/dt=2025-12-31",
		wantOK: true, wantDt: "2025-12-31",
	},
	{
		name:   "no dt= segment",
		key:    "logs/tenant_id=abc/metadata.json",
		wantOK: false,
	},
	{
		name:   "malformed date",
		key:    "logs/tenant_id=abc/dt=2026-99-99/hour=00/x.parquet",
		wantOK: false,
	},
	{
		name:   "short date",
		key:    "logs/tenant_id=abc/dt=2026-1-1/hour=00/x.parquet",
		wantOK: false,
	},
	{
		name:   "empty key",
		key:    "",
		wantOK: false,
	},
}

func TestParseDtFromKey(t *testing.T) {
	for _, tc := range parseDtTests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseDtFromKey(tc.key)
			if ok != tc.wantOK {
				t.Fatalf("parseDtFromKey(%q) ok=%v, want %v", tc.key, ok, tc.wantOK)
			}
			if tc.wantOK {
				gotStr := got.UTC().Format("2006-01-02")
				if gotStr != tc.wantDt {
					t.Errorf("parseDtFromKey(%q) = %q, want %q", tc.key, gotStr, tc.wantDt)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// tenantColdPrefix — structural isolation test
// ---------------------------------------------------------------------------

func TestTenantColdPrefix_LeadingTenantSegment(t *testing.T) {
	tenantID := "aaaaaaaa-0000-0000-0000-000000000001"
	got := tenantColdPrefix(tenantID)
	want := "logs/tenant_id=aaaaaaaa-0000-0000-0000-000000000001/"
	if got != want {
		t.Errorf("tenantColdPrefix = %q, want %q", got, want)
	}
	// ISOLATION: prefix must not start with "/" (would be an absolute path on
	// some implementations), must contain tenant_id, and must be specific enough
	// that it cannot match a different tenant's prefix.
	if got[0] == '/' {
		t.Error("tenantColdPrefix must not start with /")
	}
	if !containsStr(got, tenantID) {
		t.Errorf("prefix %q does not contain tenant ID %q", got, tenantID)
	}
}

func TestTenantColdPrefix_DifferentTenantsNeverOverlap(t *testing.T) {
	a := tenantColdPrefix("aaaa0000-0000-0000-0000-000000000001")
	b := tenantColdPrefix("bbbb0000-0000-0000-0000-000000000002")
	if len(a) > len(b) && a[:len(b)] == b {
		t.Errorf("prefix A is a prefix of B: %q is prefix of %q", b, a)
	}
	if len(b) > len(a) && b[:len(a)] == a {
		t.Errorf("prefix B is a prefix of A: %q is prefix of %q", a, b)
	}
	if a == b {
		t.Errorf("two different tenants produced identical prefix: %q", a)
	}
}

// ---------------------------------------------------------------------------
// PurgeExpiredPrefixes — unit tests with fakeS3
// ---------------------------------------------------------------------------

func TestPurgeExpiredPrefixes_DeletesExpiredObjects(t *testing.T) {
	tenantID := "aaaaaaaa-0000-0000-0000-000000000001"
	cutoff := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

	fake := &fakeS3{
		keys: []string{
			// Expired (before cutoff 2026-06-01)
			fmt.Sprintf("logs/tenant_id=%s/dt=2026-05-31/hour=23/batch.parquet", tenantID),
			fmt.Sprintf("logs/tenant_id=%s/dt=2026-01-15/hour=10/batch.parquet", tenantID),
			// Not expired (on or after cutoff)
			fmt.Sprintf("logs/tenant_id=%s/dt=2026-06-01/hour=00/batch.parquet", tenantID),
			fmt.Sprintf("logs/tenant_id=%s/dt=2026-06-15/hour=12/batch.parquet", tenantID),
		},
	}
	p := newWithFake(fake, "logalot-cold")

	n, err := p.PurgeExpiredPrefixes(context.Background(), tenantID, cutoff)
	if err != nil {
		t.Fatalf("PurgeExpiredPrefixes: %v", err)
	}
	if n != 2 {
		t.Errorf("deleted %d objects, want 2", n)
	}
	for _, key := range fake.deleted {
		dt, ok := parseDtFromKey(key)
		if !ok {
			t.Errorf("deleted key has no dt= segment: %q", key)
			continue
		}
		if !dt.Before(cutoff) {
			t.Errorf("deleted non-expired key: dt=%v, cutoff=%v, key=%q", dt, cutoff, key)
		}
	}
}

func TestPurgeExpiredPrefixes_NeverTouchesDifferentTenantObjects(t *testing.T) {
	// SECURITY: objects under a DIFFERENT tenant's prefix must never be listed
	// or deleted, even if their dt is expired.
	tenantA := "aaaaaaaa-0000-0000-0000-000000000001"
	tenantB := "bbbbbbbb-0000-0000-0000-000000000002"
	cutoff := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

	fake := &fakeS3{
		keys: []string{
			// Expired objects for tenant A (should be deleted)
			fmt.Sprintf("logs/tenant_id=%s/dt=2026-05-31/hour=00/batch.parquet", tenantA),
			// Expired objects for tenant B (must NOT be deleted when purging A)
			fmt.Sprintf("logs/tenant_id=%s/dt=2026-05-31/hour=00/batch.parquet", tenantB),
		},
	}
	p := newWithFake(fake, "logalot-cold")

	// Purge only tenant A.
	_, err := p.PurgeExpiredPrefixes(context.Background(), tenantA, cutoff)
	if err != nil {
		t.Fatalf("PurgeExpiredPrefixes: %v", err)
	}

	for _, key := range fake.deleted {
		if containsStr(key, tenantB) {
			t.Errorf("SECURITY: deleted tenant B's object when purging tenant A: %q", key)
		}
	}
}

func TestPurgeExpiredPrefixes_NoExpiredObjects_ReturnsZero(t *testing.T) {
	tenantID := "aaaaaaaa-0000-0000-0000-000000000001"
	cutoff := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	fake := &fakeS3{
		keys: []string{
			fmt.Sprintf("logs/tenant_id=%s/dt=2026-06-15/hour=12/batch.parquet", tenantID),
		},
	}
	p := newWithFake(fake, "logalot-cold")

	n, err := p.PurgeExpiredPrefixes(context.Background(), tenantID, cutoff)
	if err != nil {
		t.Fatalf("PurgeExpiredPrefixes: %v", err)
	}
	if n != 0 {
		t.Errorf("deleted %d objects, want 0", n)
	}
}

func TestPurgeExpiredPrefixes_ListError_Propagates(t *testing.T) {
	fake := &fakeS3{listErr: fmt.Errorf("s3 list error")}
	p := newWithFake(fake, "logalot-cold")
	_, err := p.PurgeExpiredPrefixes(context.Background(), "some-tenant", time.Now())
	if err == nil {
		t.Fatal("expected error from list failure, got nil")
	}
}

func TestPurgeExpiredPrefixes_SkipsKeysWithoutDtSegment(t *testing.T) {
	tenantID := "aaaaaaaa-0000-0000-0000-000000000001"
	cutoff := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	fake := &fakeS3{
		keys: []string{
			fmt.Sprintf("logs/tenant_id=%s/metadata.json", tenantID),
		},
	}
	p := newWithFake(fake, "logalot-cold")
	n, err := p.PurgeExpiredPrefixes(context.Background(), tenantID, cutoff)
	if err != nil {
		t.Fatalf("PurgeExpiredPrefixes: %v", err)
	}
	if n != 0 {
		t.Errorf("deleted %d objects, want 0 (metadata should be skipped)", n)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func containsStr(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && func() bool {
		for i := 0; i <= len(s)-len(sub); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	}()
}
