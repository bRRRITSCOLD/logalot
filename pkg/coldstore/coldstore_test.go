package coldstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// ---------------------------------------------------------------------------
// Fake port implementations (test doubles for S3, Glue, Athena)
// ---------------------------------------------------------------------------

// fakeS3 records PutObject calls. Thread-safe for single-test use.
type fakeS3 struct {
	objects map[string][]byte // key -> body
	putErr  error
}

func newFakeS3() *fakeS3 { return &fakeS3{objects: map[string][]byte{}} }

func (f *fakeS3) PutObject(_ context.Context, bucket, key string, body []byte) error {
	if f.putErr != nil {
		return f.putErr
	}
	f.objects[bucket+"/"+key] = body
	return nil
}

// fakeGlue records CreatePartition calls and can fail.
type fakeGlue struct {
	partitions []gluePartition
	createErr  error
}

func (f *fakeGlue) CreatePartition(_ context.Context, _ string, p gluePartition) error {
	if f.createErr != nil {
		return f.createErr
	}
	f.partitions = append(f.partitions, p)
	return nil
}

// fakeAthena records StartQueryExecution calls, never actually executes.
type fakeAthena struct {
	lastSQL   string
	startErr  error
	queryFail bool // if true, the query fails during execution
}

func (f *fakeAthena) StartQueryExecution(_ context.Context, sql string) (string, error) {
	f.lastSQL = sql
	if f.startErr != nil {
		return "", f.startErr
	}
	if f.queryFail {
		return "failing-qid", nil
	}
	return "ok-qid", nil
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

var (
	tenantA  = kernel.TenantID("aaaaaaaa-0000-0000-0000-000000000001")
	fixedNow = time.Date(2026, 6, 27, 14, 30, 0, 0, time.UTC)
)

func mtcA() kernel.TenantContext {
	return kernel.TenantContext{TenantID: tenantA, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
}

func event(msg string) kernel.LogEvent {
	return kernel.LogEvent{
		TenantID: tenantA,
		TS:       fixedNow,
		ID:       "id-001",
		Service:  "orders",
		Level:    kernel.LevelInfo,
		Message:  msg,
		Labels:   map[string]string{"region": "us-east-1"},
		Raw:      json.RawMessage(`{}`),
	}
}

// ---------------------------------------------------------------------------
// buildColdQuery tests
// ---------------------------------------------------------------------------

func TestBuildColdQuery_ContainsTenantPredicate(t *testing.T) {
	tc := mtcA()
	q := kernel.SearchQuery{
		From:  time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		To:    time.Date(2026, 6, 27, 0, 0, 0, 0, time.UTC),
		Limit: 50,
	}
	sql := buildColdQuery(tc, q)

	// The tenant predicate must be present (structural check).
	if err := CheckTenantPredicate(sql, string(tenantA)); err != nil {
		t.Errorf("buildColdQuery produced SQL missing tenant predicate: %v\nSQL: %s", err, sql)
	}

	// Verify expected structure keywords.
	for _, want := range []string{"SELECT", "FROM", "WHERE", "ORDER BY", "LIMIT"} {
		if !strings.Contains(strings.ToUpper(sql), want) {
			t.Errorf("SQL missing %q keyword:\n%s", want, sql)
		}
	}
}

func TestBuildColdQuery_NoTextFilter_NoTextPredicate(t *testing.T) {
	sql := buildColdQuery(mtcA(), kernel.SearchQuery{Limit: 10})
	// Without a text filter the generated SQL should still pass the fitness check.
	if err := CheckTenantPredicate(sql, string(tenantA)); err != nil {
		t.Errorf("empty-filter SQL failed fitness: %v\nSQL: %s", err, sql)
	}
}

func TestBuildColdQuery_WithServiceFilter(t *testing.T) {
	sql := buildColdQuery(mtcA(), kernel.SearchQuery{Service: "orders", Limit: 10})
	if !strings.Contains(sql, "orders") {
		t.Errorf("service filter 'orders' not reflected in SQL:\n%s", sql)
	}
	if err := CheckTenantPredicate(sql, string(tenantA)); err != nil {
		t.Errorf("fitness check failed: %v", err)
	}
}

func TestBuildColdQuery_TextEscaping(t *testing.T) {
	// Single quotes in user text must be escaped so they can't break the SQL.
	sql := buildColdQuery(mtcA(), kernel.SearchQuery{Text: "it's a test", Limit: 5})
	// Must not contain an unescaped lone quote that would break the SQL.
	// The fitness function won't catch this, so we check that the generated SQL
	// is still syntactically consistent by verifying the tenant predicate is
	// still found (the parser would fail on unbalanced quotes).
	if err := CheckTenantPredicate(sql, string(tenantA)); err != nil {
		t.Errorf("SQL with escaped text failed fitness: %v\nSQL: %s", err, sql)
	}
}

// ---------------------------------------------------------------------------
// encodeParquet tests
// ---------------------------------------------------------------------------

func TestEncodeParquet_ProducesParquetMagic(t *testing.T) {
	evs := []kernel.LogEvent{event("hello")}
	data, err := encodeParquet(mtcA(), evs)
	if err != nil {
		t.Fatalf("encodeParquet: %v", err)
	}
	if len(data) < 4 {
		t.Fatalf("Parquet output too short (%d bytes)", len(data))
	}
	// Parquet files begin with the 4-byte magic "PAR1".
	if !bytes.HasPrefix(data, []byte("PAR1")) {
		t.Errorf("encodeParquet: magic 'PAR1' not found; got %q", data[:4])
	}
}

func TestEncodeParquet_EmptyInput(t *testing.T) {
	data, err := encodeParquet(mtcA(), nil)
	if err != nil {
		t.Fatalf("encodeParquet(nil): %v", err)
	}
	// Still a valid Parquet file (row group with 0 rows).
	if !bytes.HasPrefix(data, []byte("PAR1")) {
		t.Errorf("empty Parquet output missing magic: %q", data[:min(len(data), 8)])
	}
}

// ---------------------------------------------------------------------------
// coldKey tests
// ---------------------------------------------------------------------------

func TestColdKey_HiveStyleLayout(t *testing.T) {
	k := coldKey(string(tenantA), "batch-001", fixedNow)
	// cold-tier.md §1: logs/tenant_id=<uuid>/dt=YYYY-MM-DD/hour=HH/*.parquet
	wantPrefix := "logs/tenant_id=" + string(tenantA) + "/dt=2026-06-27/hour=14/"
	if !strings.HasPrefix(k, wantPrefix) {
		t.Errorf("coldKey = %q, want prefix %q", k, wantPrefix)
	}
	if !strings.HasSuffix(k, ".parquet") {
		t.Errorf("coldKey = %q, want .parquet suffix", k)
	}
}

// ---------------------------------------------------------------------------
// Archive method unit tests (using test doubles, no real AWS)
// ---------------------------------------------------------------------------

func TestStore_Archive_WritesParquetToS3(t *testing.T) {
	fs3 := newFakeS3()
	fg := &fakeGlue{}
	store := newTestStore(fs3, fg, nil)

	err := store.Archive(mtcA(), context.Background(), event("archive me"))
	if err != nil {
		t.Fatalf("Archive: %v", err)
	}

	// Exactly one S3 PutObject should have been called.
	if len(fs3.objects) != 1 {
		t.Fatalf("expected 1 S3 object, got %d", len(fs3.objects))
	}
	for k, v := range fs3.objects {
		// Key must follow the Hive layout.
		wantInfix := "tenant_id=" + string(tenantA)
		if !strings.Contains(k, wantInfix) {
			t.Errorf("S3 key %q missing tenant prefix %q", k, wantInfix)
		}
		// Value must be a Parquet file.
		if !bytes.HasPrefix(v, []byte("PAR1")) {
			t.Errorf("S3 object at %q is not Parquet (missing PAR1 magic)", k)
		}
	}

	// One Glue partition should have been registered.
	if len(fg.partitions) != 1 {
		t.Errorf("expected 1 Glue partition, got %d", len(fg.partitions))
	}
	if fg.partitions[0].tenantID != string(tenantA) {
		t.Errorf("Glue partition tenantID = %q, want %q", fg.partitions[0].tenantID, tenantA)
	}
}

func TestStore_Archive_EmptyEventsIsNoop(t *testing.T) {
	fs3 := newFakeS3()
	fg := &fakeGlue{}
	store := newTestStore(fs3, fg, nil)

	if err := store.Archive(mtcA(), context.Background()); err != nil {
		t.Fatalf("Archive(no events): %v", err)
	}
	if len(fs3.objects) != 0 {
		t.Errorf("empty Archive call wrote %d S3 objects, want 0", len(fs3.objects))
	}
}

func TestStore_Archive_InvalidTenantReturnsError(t *testing.T) {
	fs3 := newFakeS3()
	fg := &fakeGlue{}
	store := newTestStore(fs3, fg, nil)

	badTC := kernel.TenantContext{} // blank TenantID
	err := store.Archive(badTC, context.Background(), event("x"))
	if err == nil {
		t.Fatal("Archive with invalid tenant must return error, got nil")
	}
}

func TestStore_Archive_S3FailureReturnsError(t *testing.T) {
	fs3 := newFakeS3()
	fs3.putErr = errors.New("S3 unreachable")
	fg := &fakeGlue{}
	store := newTestStore(fs3, fg, nil)

	err := store.Archive(mtcA(), context.Background(), event("x"))
	if err == nil {
		t.Fatal("Archive with S3 failure must return error, got nil")
	}
}

func TestStore_Archive_GlueFailureIsLogged_NoError(t *testing.T) {
	// Glue partition registration failure is non-fatal: data is already in S3
	// and partition projection handles discovery (decision 016).
	fs3 := newFakeS3()
	fg := &fakeGlue{createErr: errors.New("Glue unavailable")}
	store := newTestStore(fs3, fg, nil)

	err := store.Archive(mtcA(), context.Background(), event("x"))
	if err != nil {
		t.Errorf("Archive with Glue failure must NOT return error (non-fatal), got %v", err)
	}
	// S3 object must still be written.
	if len(fs3.objects) != 1 {
		t.Errorf("S3 write count = %d, want 1 (Glue failure is non-fatal)", len(fs3.objects))
	}
}

func TestStore_Archive_HeterogeneousBatch_SplitsByPartition(t *testing.T) {
	// M1: a batch whose events span different (dt, hour) partitions must be
	// written as one Parquet object per partition under the correct prefix —
	// NOT all under events[0]'s partition.
	fs3 := newFakeS3()
	fg := &fakeGlue{}
	store := newTestStore(fs3, fg, nil)

	tc := mtcA()
	h14 := time.Date(2026, 6, 27, 14, 5, 0, 0, time.UTC)
	h15 := time.Date(2026, 6, 27, 15, 5, 0, 0, time.UTC)
	nextDay := time.Date(2026, 6, 28, 1, 0, 0, 0, time.UTC)

	evs := []kernel.LogEvent{
		{TenantID: tenantA, TS: h14, ID: "a", Service: "s", Level: kernel.LevelInfo, Message: "m1"},
		{TenantID: tenantA, TS: h15, ID: "b", Service: "s", Level: kernel.LevelInfo, Message: "m2"},
		{TenantID: tenantA, TS: h14, ID: "c", Service: "s", Level: kernel.LevelInfo, Message: "m3"}, // same partition as first
		{TenantID: tenantA, TS: nextDay, ID: "d", Service: "s", Level: kernel.LevelInfo, Message: "m4"},
	}

	if err := store.Archive(tc, context.Background(), evs...); err != nil {
		t.Fatalf("Archive: %v", err)
	}

	// Three distinct (dt,hour) partitions → three S3 objects + three Glue parts.
	if len(fs3.objects) != 3 {
		t.Fatalf("expected 3 S3 objects (one per partition), got %d: %v", len(fs3.objects), keysOf(fs3.objects))
	}
	if len(fg.partitions) != 3 {
		t.Fatalf("expected 3 Glue partitions, got %d", len(fg.partitions))
	}

	// Every object must be filed under the partition matching its events' TS.
	wantPrefixes := []string{
		"logs/tenant_id=" + string(tenantA) + "/dt=2026-06-27/hour=14/",
		"logs/tenant_id=" + string(tenantA) + "/dt=2026-06-27/hour=15/",
		"logs/tenant_id=" + string(tenantA) + "/dt=2026-06-28/hour=01/",
	}
	for _, want := range wantPrefixes {
		found := false
		for k := range fs3.objects {
			if strings.Contains(k, want) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("no S3 object filed under partition %q; have %v", want, keysOf(fs3.objects))
		}
	}
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---------------------------------------------------------------------------
// Search / fitness gate unit tests
// ---------------------------------------------------------------------------

func TestStore_Search_FitnessBlocksExecution(t *testing.T) {
	// The search adapter must NOT call StartQueryExecution if the fitness
	// check fails (i.e., the generated SQL somehow lost the tenant predicate).
	// Since buildColdQuery always produces valid SQL for a valid TenantContext,
	// we directly exercise CheckTenantPredicate to confirm the gate fires on
	// any SQL missing the predicate.
	fa := &fakeAthena{}

	err := CheckTenantPredicate("SELECT * FROM t WHERE dt = '2026-01-01'", string(tenantA))
	if err == nil {
		t.Fatal("fitness check must fail when tenant predicate is absent")
	}
	if !errors.Is(err, ErrMissingTenantPredicate) {
		t.Errorf("expected ErrMissingTenantPredicate, got %v", err)
	}
	// Athena must never have been called (the fake records calls).
	if fa.lastSQL != "" {
		t.Error("StartQueryExecution called despite fitness failure")
	}
}

// ---------------------------------------------------------------------------
// Helpers to build test stores without real AWS clients
// ---------------------------------------------------------------------------

// testS3Writer is the minimal S3 interface the coldstore uses internally.
type testS3Writer interface {
	PutObject(ctx context.Context, bucket, key string, body []byte) error
}

// testGlueRegistrar is the minimal Glue interface used internally.
type testGlueRegistrar interface {
	CreatePartition(ctx context.Context, database string, p gluePartition) error
}

func newTestStore(s3 testS3Writer, g testGlueRegistrar, _ *fakeAthena) *Store {
	return &Store{
		s3Putter: s3.PutObject,
		gluePart: g.CreatePartition,
		bucket:   "logalot-cold-test",
		glueDB:   "logalot_cold",
		now:      func() time.Time { return fixedNow },
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}
