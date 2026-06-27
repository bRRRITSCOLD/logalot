package logstore

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	tenantA = kernel.TenantID("00000000-0000-0000-0000-00000000000a")
	tenantB = kernel.TenantID("00000000-0000-0000-0000-00000000000b")
)

// --- fake pgx tx seam -------------------------------------------------------

type execCall struct {
	sql  string
	args []any
}

// fakeTx records Exec calls and the commit/rollback outcome. It embeds pgx.Tx so
// it satisfies the interface; any method we do not override panics if called,
// which keeps the test honest about exactly which tx surface Append touches.
type fakeTx struct {
	pgx.Tx
	execs      []execCall
	execErr    error // returned by the INSERT exec (not the SET LOCAL)
	committed  bool
	rolledBack bool
}

func (f *fakeTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execs = append(f.execs, execCall{sql: sql, args: args})
	// The first exec is the SET LOCAL arming statement; only the INSERT may fail.
	if strings.HasPrefix(strings.TrimSpace(sql), "INSERT") && f.execErr != nil {
		return pgconn.CommandTag{}, f.execErr
	}
	return pgconn.CommandTag{}, nil
}

func (f *fakeTx) Commit(_ context.Context) error   { f.committed = true; return nil }
func (f *fakeTx) Rollback(_ context.Context) error { f.rolledBack = true; return nil }

type fakeDB struct {
	tx        *fakeTx
	beginErr  error
	beginSeen bool
}

func (d *fakeDB) Begin(_ context.Context) (pgx.Tx, error) {
	d.beginSeen = true
	if d.beginErr != nil {
		return nil, d.beginErr
	}
	return d.tx, nil
}

// --- tests ------------------------------------------------------------------

func TestAppend_ArmsRLSThenInserts(t *testing.T) {
	tx := &fakeTx{}
	db := &fakeDB{tx: tx}
	at := time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC)
	s := New(db, WithClock(func() time.Time { return at }))

	tc := kernel.TenantContext{TenantID: tenantA}
	ev := kernel.LogEvent{
		// A spoofed foreign tenant on the event MUST be ignored.
		TenantID: tenantB,
		TS:       at,
		Service:  "api",
		Level:    kernel.LevelWarn,
		Message:  "disk almost full",
		Labels:   map[string]string{"region": "us-east-1"},
		TraceID:  "trace-1",
		Raw:      json.RawMessage(`{"m":"disk almost full"}`),
	}
	if err := s.Append(tc, context.Background(), ev); err != nil {
		t.Fatalf("Append: %v", err)
	}

	if len(tx.execs) != 2 {
		t.Fatalf("expected 2 execs (SET LOCAL + INSERT), got %d", len(tx.execs))
	}
	// 1) the RLS arm carries tc's tenant.
	if tx.execs[0].sql != kernel.SetLocalTenantStmt {
		t.Errorf("first exec = %q, want SET LOCAL stmt", tx.execs[0].sql)
	}
	if got := tx.execs[0].args[0]; got != string(tenantA) {
		t.Errorf("arm tenant arg = %v, want %v", got, tenantA)
	}
	// 2) the INSERT into the parent table, tenant stamped from tc (not the event).
	ins := tx.execs[1]
	if !strings.HasPrefix(ins.sql, "INSERT INTO log_events (") {
		t.Errorf("insert sql = %q", ins.sql)
	}
	if got := ins.args[0]; got != string(tenantA) {
		t.Errorf("insert tenant arg = %v, want %v (event tenant must be ignored)", got, tenantA)
	}
	if got := ins.args[3]; got != string(kernel.LevelWarn) {
		t.Errorf("insert level arg = %v, want warn", got)
	}
	if got := ins.args[4]; got != "disk almost full" {
		t.Errorf("insert message arg = %v", got)
	}
	if !tx.committed {
		t.Error("expected commit on success")
	}
	if tx.rolledBack {
		t.Error("unexpected rollback on success")
	}
}

func TestAppend_RollsBackOnInsertError(t *testing.T) {
	boom := errors.New("connection reset")
	tx := &fakeTx{execErr: boom}
	db := &fakeDB{tx: tx}
	s := New(db)

	tc := kernel.TenantContext{TenantID: tenantA}
	err := s.Append(tc, context.Background(), kernel.LogEvent{Message: "x", Level: kernel.LevelInfo})
	if !errors.Is(err, boom) {
		t.Fatalf("Append err = %v, want wrapped %v", err, boom)
	}
	if !tx.rolledBack {
		t.Error("expected rollback on insert error")
	}
	if tx.committed {
		t.Error("must not commit on insert error")
	}
}

func TestAppend_EmptyIsNoOp(t *testing.T) {
	db := &fakeDB{tx: &fakeTx{}}
	s := New(db)
	if err := s.Append(kernel.TenantContext{TenantID: tenantA}, context.Background()); err != nil {
		t.Fatalf("Append empty: %v", err)
	}
	if db.beginSeen {
		t.Error("empty Append must not open a transaction")
	}
}

func TestAppend_FailsClosedOnInvalidTenant(t *testing.T) {
	db := &fakeDB{tx: &fakeTx{}}
	s := New(db)
	err := s.Append(kernel.TenantContext{TenantID: "not-a-uuid"}, context.Background(),
		kernel.LogEvent{Message: "x"})
	if !errors.Is(err, kernel.ErrInvalidTenantID) {
		t.Fatalf("err = %v, want ErrInvalidTenantID", err)
	}
	if db.beginSeen {
		t.Error("must not open a tx for an invalid tenant")
	}
}

func TestBuildInsert_MultiRowLayoutAndDefaults(t *testing.T) {
	now := time.Date(2026, 6, 27, 0, 0, 0, 0, time.UTC)
	events := []kernel.LogEvent{
		{Service: "a", Level: kernel.LevelInfo, Message: "one", TS: now},
		// second row: zero TS -> default now; empty level -> info; nil labels -> {}
		{Service: "b", Message: "two"},
	}
	sql, args, err := buildInsert(tenantA, now, events)
	if err != nil {
		t.Fatalf("buildInsert: %v", err)
	}
	// Two value tuples, 9 columns each => 18 placeholders, last is $18.
	if !strings.Contains(sql, "$18::jsonb)") {
		t.Errorf("expected 18 placeholders for 2 rows, sql=%q", sql)
	}
	if strings.Count(sql, "::log_level") != 2 {
		t.Errorf("expected a log_level cast per row, sql=%q", sql)
	}
	if len(args) != 18 {
		t.Fatalf("args len = %d, want 18", len(args))
	}
	// Row 2 level defaulted to info (index 9+3 = 12).
	if got := args[12]; got != string(kernel.LevelInfo) {
		t.Errorf("row2 level = %v, want info default", got)
	}
	// Row 2 TS defaulted to now (index 9+1 = 10).
	if got := args[10].(time.Time); !got.Equal(now) {
		t.Errorf("row2 ts = %v, want now default %v", got, now)
	}
	// Row 2 labels defaulted to {} jsonb (index 9+5 = 14).
	if got := string(args[14].([]byte)); got != "{}" {
		t.Errorf("row2 labels = %s, want {}", got)
	}
}

func TestBuildInsert_NullsEmptyTraceSpan(t *testing.T) {
	now := time.Now()
	_, args, err := buildInsert(tenantA, now, []kernel.LogEvent{
		{Message: "x", Level: kernel.LevelInfo}, // no trace/span
	})
	if err != nil {
		t.Fatalf("buildInsert: %v", err)
	}
	if args[6] != nil { // trace_id
		t.Errorf("empty trace_id should be NULL, got %v", args[6])
	}
	if args[7] != nil { // span_id
		t.Errorf("empty span_id should be NULL, got %v", args[7])
	}
}

func TestSearch_FailsClosedOnInvalidTenant(t *testing.T) {
	db := &fakeDB{tx: &fakeTx{}}
	s := New(db)
	_, err := s.Search(kernel.TenantContext{TenantID: "not-a-uuid"}, context.Background(), kernel.SearchQuery{})
	if !errors.Is(err, kernel.ErrInvalidTenantID) {
		t.Fatalf("Search err = %v, want ErrInvalidTenantID", err)
	}
	if db.beginSeen {
		t.Error("must not open a tx for an invalid tenant")
	}
}

func TestBuildSearch_TenantOnlyMinimalQuery(t *testing.T) {
	sql, args, err := buildSearch(tenantA, kernel.SearchQuery{}, 51)
	if err != nil {
		t.Fatalf("buildSearch: %v", err)
	}
	// Tenant predicate is ALWAYS $1, bound from the context tenant — never absent.
	if !strings.Contains(sql, "WHERE tenant_id = $1::uuid") {
		t.Errorf("missing tenant predicate, sql=%q", sql)
	}
	if got := args[0]; got != string(tenantA) {
		t.Errorf("args[0] = %v, want tenant %v", got, tenantA)
	}
	// No optional filters => only tenant + the LIMIT placeholder are bound.
	if !strings.Contains(sql, "ORDER BY ts DESC, id DESC LIMIT $2") {
		t.Errorf("expected LIMIT $2 with no filters, sql=%q", sql)
	}
	if len(args) != 2 {
		t.Fatalf("args len = %d, want 2 (tenant, limit)", len(args))
	}
	if got := args[1]; got != 51 {
		t.Errorf("limit arg = %v, want 51 (fetchLimit)", got)
	}
	// A bare query must NOT leak any filter clauses.
	for _, frag := range []string{"websearch_to_tsquery", "labels @>", "service =", "level =", "(ts, id) <", "ts >=", "ts <"} {
		if strings.Contains(sql, frag) {
			t.Errorf("unexpected clause %q in minimal query, sql=%q", frag, sql)
		}
	}
}

func TestBuildSearch_AllFiltersBindInOrder(t *testing.T) {
	from := time.Date(2026, 6, 27, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 6, 28, 0, 0, 0, 0, time.UTC)
	lvl := kernel.LevelError
	cursorTS := time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC)
	q := kernel.SearchQuery{
		Text:    "disk full",
		Service: "api",
		Level:   &lvl,
		Labels:  map[string]string{"region": "us-east-1"},
		From:    from,
		To:      to,
		Cursor:  &kernel.Cursor{TS: cursorTS, ID: "00000000-0000-0000-0000-0000000000ff"},
	}
	sql, args, err := buildSearch(tenantA, q, 26)
	if err != nil {
		t.Fatalf("buildSearch: %v", err)
	}

	// Each filter produces its parameterized clause (never inlined user text).
	for _, frag := range []string{
		"WHERE tenant_id = $1::uuid",
		"AND ts >= $2",
		"AND ts < $3",
		"AND search @@ websearch_to_tsquery('english', $4)",
		"AND labels @> $5::jsonb",
		"AND service = $6",
		"AND level = $7::log_level",
		"AND (ts, id) < ($8, $9::uuid)",
		"ORDER BY ts DESC, id DESC LIMIT $10",
	} {
		if !strings.Contains(sql, frag) {
			t.Errorf("missing clause %q, sql=%q", frag, sql)
		}
	}

	// The FTS text is a bound ARG, not concatenated into the SQL (injection-safe).
	if strings.Contains(sql, "disk full") {
		t.Errorf("FTS text must be a bound parameter, not inlined; sql=%q", sql)
	}

	want := []any{
		string(tenantA),
		from.UTC(),
		to.UTC(),
		"disk full",
		[]byte(`{"region":"us-east-1"}`),
		"api",
		string(kernel.LevelError),
		cursorTS.UTC(),
		"00000000-0000-0000-0000-0000000000ff",
		26,
	}
	if len(args) != len(want) {
		t.Fatalf("args len = %d, want %d", len(args), len(want))
	}
	for i := range want {
		if b, ok := want[i].([]byte); ok {
			if string(args[i].([]byte)) != string(b) {
				t.Errorf("arg[%d] = %s, want %s", i, args[i].([]byte), b)
			}
			continue
		}
		if args[i] != want[i] {
			t.Errorf("arg[%d] = %v, want %v", i, args[i], want[i])
		}
	}
}

func TestPaginate_DerivesNextCursorOnlyWhenMore(t *testing.T) {
	mk := func(id string, ts time.Time) kernel.LogEvent {
		return kernel.LogEvent{ID: id, TS: ts}
	}
	t1 := time.Date(2026, 6, 27, 12, 0, 2, 0, time.UTC)
	t2 := time.Date(2026, 6, 27, 12, 0, 1, 0, time.UTC)
	t3 := time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC)

	// Over-fetched (limit+1): page is trimmed and the LAST KEPT row is the cursor.
	page, next := paginate([]kernel.LogEvent{mk("a", t1), mk("b", t2), mk("c", t3)}, 2)
	if len(page) != 2 {
		t.Fatalf("page len = %d, want 2 (trimmed to limit)", len(page))
	}
	if next == nil {
		t.Fatal("expected a next cursor when an extra row was fetched")
	}
	if next.ID != "b" || !next.TS.Equal(t2) {
		t.Errorf("next cursor = %+v, want last kept row (b,%v)", next, t2)
	}

	// Exactly limit (or fewer): final page, no cursor.
	page, next = paginate([]kernel.LogEvent{mk("a", t1), mk("b", t2)}, 2)
	if len(page) != 2 || next != nil {
		t.Errorf("final page: got len=%d next=%v, want len=2 next=nil", len(page), next)
	}
}
