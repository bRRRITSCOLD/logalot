package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeLogStore records Search calls and returns a fixed page.
type fakeLogStore struct {
	page    kernel.SearchPage
	err     error
	calls   []kernel.SearchQuery
	callTCs []kernel.TenantContext
}

func (f *fakeLogStore) Search(tc kernel.TenantContext, _ context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	f.calls = append(f.calls, q)
	f.callTCs = append(f.callTCs, tc)
	if f.err != nil {
		return kernel.SearchPage{}, f.err
	}
	return f.page, nil
}
func (f *fakeLogStore) Append(tc kernel.TenantContext, _ context.Context, _ ...kernel.LogEvent) error {
	return nil
}
func (f *fakeLogStore) Tail(tc kernel.TenantContext, _ context.Context, _ kernel.TailQuery) ([]kernel.LogEvent, error) {
	return nil, nil
}

var _ kernel.LogStore = (*fakeLogStore)(nil)

// fakeColdArchive records Search calls and returns a fixed page.
type fakeColdArchive struct {
	page  kernel.SearchPage
	err   error
	calls []kernel.SearchQuery
}

func (f *fakeColdArchive) Search(tc kernel.TenantContext, _ context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	f.calls = append(f.calls, q)
	if f.err != nil {
		return kernel.SearchPage{}, f.err
	}
	return f.page, nil
}
func (f *fakeColdArchive) Archive(tc kernel.TenantContext, _ context.Context, _ ...kernel.LogEvent) error {
	return nil
}

var _ kernel.ColdArchive = (*fakeColdArchive)(nil)

// tcA is a test tenant context.
var tcA = kernel.TenantContext{TenantID: "aaaaaaaa-0000-0000-0000-000000000001"}

// makeEvent builds a LogEvent for testing.
func makeEvent(id string, ts time.Time) kernel.LogEvent {
	return kernel.LogEvent{ID: id, TS: ts, Service: "svc", Level: kernel.LevelInfo, Message: "msg"}
}

// fixedNow is the reference "now" for all routing tests.
var fixedNow = time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

// hotCutoff30 is fixedNow − 30d.
var hotCutoff30 = fixedNow.Add(-30 * 24 * time.Hour)

// ---------------------------------------------------------------------------
// classifyTier — routing decision table
// ---------------------------------------------------------------------------

type tierCase struct {
	name     string
	from, to time.Time
	want     tier
}

func (tc tierCase) query() kernel.SearchQuery {
	return kernel.SearchQuery{From: tc.from, To: tc.to, Limit: 50}
}

var tierCases = []tierCase{
	// no bounds → hot only
	{name: "unbounded → hot", want: tierHot},
	// from and to both in hot window
	{
		name: "entirely hot",
		from: hotCutoff30.Add(time.Hour),
		to:   fixedNow,
		want: tierHot,
	},
	// from at boundary → hot
	{
		name: "from == hotCutoff → hot",
		from: hotCutoff30,
		to:   fixedNow,
		want: tierHot,
	},
	// from and to both before cutoff → cold only
	{
		name: "entirely cold",
		from: hotCutoff30.Add(-72 * time.Hour),
		to:   hotCutoff30.Add(-time.Hour),
		want: tierCold,
	},
	// to at boundary → cold
	{
		name: "to == hotCutoff → cold",
		from: hotCutoff30.Add(-48 * time.Hour),
		to:   hotCutoff30,
		want: tierCold,
	},
	// straddling: from in cold, to in hot
	{
		name: "straddling",
		from: hotCutoff30.Add(-24 * time.Hour),
		to:   hotCutoff30.Add(time.Hour),
		want: tierBoth,
	},
	// only from set, from is cold → both (open end = now, which is hot)
	{
		name: "from in cold, no to → both",
		from: hotCutoff30.Add(-24 * time.Hour),
		want: tierBoth,
	},
	// only from set, from is hot → hot
	{
		name: "from in hot, no to → hot",
		from: hotCutoff30.Add(time.Hour),
		want: tierHot,
	},
	// only to set, to is cold → cold
	{
		name: "no from, to in cold → cold",
		to:   hotCutoff30.Add(-time.Hour),
		want: tierCold,
	},
	// only to set, to is in hot → both (from is unbounded, extends into cold)
	{
		name: "no from, to in hot → both",
		to:   hotCutoff30.Add(time.Hour),
		want: tierBoth,
	},
}

func TestClassifyTier(t *testing.T) {
	for _, tc := range tierCases {
		t.Run(tc.name, func(t *testing.T) {
			hot := &fakeLogStore{}
			cold := &fakeColdArchive{}
			ts := NewTieredSearcher(hot, cold, 30, true, WithTieredClock(func() time.Time { return fixedNow }))

			got := ts.classifyTier(tc.query())
			if got != tc.want {
				t.Errorf("classifyTier: got %v, want %v (from=%v, to=%v, cutoff=%v)",
					got, tc.want, tc.from, tc.to, hotCutoff30)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Flag-off: when enabled=false, ALWAYS routes to hot
// ---------------------------------------------------------------------------

func TestTieredSearcher_FlagOff_AlwaysHot(t *testing.T) {
	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{makeEvent("e1", fixedNow)}}}
	cold := &fakeColdArchive{}

	ts := NewTieredSearcher(hot, cold, 30, false /* flag OFF */,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	// A query entirely in cold territory — flag is off, so hot must be called.
	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(-48 * time.Hour),
		To:    hotCutoff30.Add(-time.Hour),
		Limit: 10,
	}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(cold.calls) != 0 {
		t.Errorf("cold was called %d time(s) with flag off — want 0", len(cold.calls))
	}
	if len(hot.calls) != 1 {
		t.Errorf("hot was called %d time(s) with flag off — want 1", len(hot.calls))
	}
	if len(page.Events) == 0 {
		t.Error("expected events from hot store")
	}
}

func TestTieredSearcher_FlagOff_NilCold_AlwaysHot(t *testing.T) {
	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{makeEvent("e1", fixedNow)}}}

	// cold=nil, enabled=false — should never panic
	ts := NewTieredSearcher(hot, nil, 30, false,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	_, err := ts.Search(tcA, context.Background(), kernel.SearchQuery{Limit: 10})
	if err != nil {
		t.Fatalf("Search with nil cold and flag off: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Hot-only routing
// ---------------------------------------------------------------------------

func TestTieredSearcher_HotOnly_NoColdCall(t *testing.T) {
	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{makeEvent("e1", fixedNow)}}}
	cold := &fakeColdArchive{}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(time.Hour),
		To:    fixedNow,
		Limit: 10,
	}
	_, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(cold.calls) != 0 {
		t.Errorf("cold called for hot-only query: %d call(s)", len(cold.calls))
	}
	if len(hot.calls) != 1 {
		t.Errorf("hot called %d time(s), want 1", len(hot.calls))
	}
}

// ---------------------------------------------------------------------------
// Cold-only routing
// ---------------------------------------------------------------------------

func TestTieredSearcher_ColdOnly_NoHotCall(t *testing.T) {
	hot := &fakeLogStore{}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{makeEvent("c1", hotCutoff30.Add(-time.Hour))}}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(-48 * time.Hour),
		To:    hotCutoff30.Add(-time.Hour),
		Limit: 10,
	}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hot.calls) != 0 {
		t.Errorf("hot called for cold-only query: %d call(s)", len(hot.calls))
	}
	if len(page.Events) == 0 {
		t.Error("expected events from cold store")
	}
}

// ---------------------------------------------------------------------------
// Straddling (union + dedupe)
// ---------------------------------------------------------------------------

func TestTieredSearcher_Straddle_CallsBothTiers(t *testing.T) {
	hotEvt := makeEvent("h1", hotCutoff30.Add(time.Hour))
	coldEvt := makeEvent("c1", hotCutoff30.Add(-time.Hour))
	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{hotEvt}}}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{coldEvt}}}

	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(-24 * time.Hour),
		To:    hotCutoff30.Add(24 * time.Hour),
		Limit: 50,
	}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hot.calls) != 1 {
		t.Errorf("hot calls = %d, want 1", len(hot.calls))
	}
	if len(cold.calls) != 1 {
		t.Errorf("cold calls = %d, want 1", len(cold.calls))
	}
	if len(page.Events) != 2 {
		t.Errorf("union returned %d events, want 2", len(page.Events))
	}
}

func TestTieredSearcher_Straddle_SplitsQueryAtCutoff(t *testing.T) {
	// Hot query should have From=hotCutoff; cold query should have To=hotCutoff.
	hot := &fakeLogStore{}
	cold := &fakeColdArchive{}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	from := hotCutoff30.Add(-48 * time.Hour)
	to := hotCutoff30.Add(48 * time.Hour)
	q := kernel.SearchQuery{From: from, To: to, Limit: 50}
	_, _ = ts.Search(tcA, context.Background(), q)

	// Hot query should start at hotCutoff.
	if len(hot.calls) != 1 {
		t.Fatalf("expected 1 hot call, got %d", len(hot.calls))
	}
	if !hot.calls[0].From.Equal(hotCutoff30) {
		t.Errorf("hot query From = %v, want hotCutoff %v", hot.calls[0].From, hotCutoff30)
	}
	if !hot.calls[0].To.Equal(to) {
		t.Errorf("hot query To = %v, want original To %v", hot.calls[0].To, to)
	}

	// Cold query should end at hotCutoff.
	if len(cold.calls) != 1 {
		t.Fatalf("expected 1 cold call, got %d", len(cold.calls))
	}
	if !cold.calls[0].From.Equal(from) {
		t.Errorf("cold query From = %v, want original From %v", cold.calls[0].From, from)
	}
	if !cold.calls[0].To.Equal(hotCutoff30) {
		t.Errorf("cold query To = %v, want hotCutoff %v", cold.calls[0].To, hotCutoff30)
	}
}

func TestTieredSearcher_Straddle_DedupeOnID(t *testing.T) {
	// The same event (same id) appears in BOTH hot and cold (overlap window).
	// It must appear only once in the union.
	sharedTS := hotCutoff30.Add(time.Minute) // in the overlap zone
	shared := makeEvent("shared-id", sharedTS)
	hotOnly := makeEvent("hot-only", hotCutoff30.Add(time.Hour))
	coldOnly := makeEvent("cold-only", hotCutoff30.Add(-time.Hour))

	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{shared, hotOnly}}}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{shared, coldOnly}}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(-24 * time.Hour),
		To:    fixedNow,
		Limit: 50,
	}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	// Must have 3 distinct events (shared counted once).
	if len(page.Events) != 3 {
		t.Errorf("union+dedupe returned %d events, want 3 (shared deduped)", len(page.Events))
	}
	// Check no duplicate id.
	seen := make(map[string]int)
	for _, ev := range page.Events {
		seen[ev.ID]++
	}
	for id, count := range seen {
		if count > 1 {
			t.Errorf("event id %q appears %d times after dedupe", id, count)
		}
	}
}

func TestTieredSearcher_Straddle_EmptyIDColdRows_AllSurvive(t *testing.T) {
	// C1/M1 REGRESSION: cold-tier parquet rows currently carry an EMPTY id
	// (logstore Append does not backfill the DB-assigned UUID, and the cold-tee
	// archives the same id-less event). A dedupe keyed on id alone would
	// collapse ALL cold rows into one — silent data loss. They must ALL survive.
	coldTS1 := hotCutoff30.Add(-time.Hour)
	coldTS2 := hotCutoff30.Add(-2 * time.Hour)
	coldTS3 := hotCutoff30.Add(-3 * time.Hour)
	hotEvt := makeEvent("h1", hotCutoff30.Add(time.Hour))

	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{hotEvt}}}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{
		makeEvent("", coldTS1), // empty id — all cold rows look like this today
		makeEvent("", coldTS2),
		makeEvent("", coldTS3),
	}}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(-24 * time.Hour),
		To:    fixedNow,
		Limit: 50,
	}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	// 3 empty-id cold rows + 1 hot row = 4. None of the empty-id rows may collapse.
	if len(page.Events) != 4 {
		t.Errorf("empty-id cold rows collapsed: got %d events, want 4 (3 cold + 1 hot)", len(page.Events))
	}
	emptyIDCount := 0
	for _, ev := range page.Events {
		if ev.ID == "" {
			emptyIDCount++
		}
	}
	if emptyIDCount != 3 {
		t.Errorf("expected all 3 empty-id cold rows to survive, got %d", emptyIDCount)
	}
}

func TestTieredSearcher_Straddle_EmptyIDSameTS_StillAllSurvive(t *testing.T) {
	// Adversarial: two empty-id cold rows with the SAME ts must BOTH survive
	// (an empty-id row is never placed in the seen set, so (ts, "") can never
	// dedupe another (ts, "")).
	sameTS := hotCutoff30.Add(-time.Hour)
	hot := &fakeLogStore{}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{
		makeEvent("", sameTS),
		makeEvent("", sameTS),
	}}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	q := kernel.SearchQuery{From: hotCutoff30.Add(-24 * time.Hour), To: fixedNow, Limit: 50}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(page.Events) != 2 {
		t.Errorf("two empty-id same-ts rows must both survive: got %d, want 2", len(page.Events))
	}
}

func TestTieredSearcher_Straddle_NonEmptyIDDedupe_StillWorks(t *testing.T) {
	// The (ts, id) dedupe still collapses a genuine duplicate with a real id
	// (the future state once hot/cold share a stable id). Verify it does not
	// regress when ids ARE present.
	dupTS := hotCutoff30.Add(time.Minute)
	dup := makeEvent("real-uuid", dupTS)
	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{dup}}}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{dup}}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	q := kernel.SearchQuery{From: hotCutoff30.Add(-24 * time.Hour), To: fixedNow, Limit: 50}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(page.Events) != 1 {
		t.Errorf("non-empty-id duplicate not deduped: got %d events, want 1", len(page.Events))
	}
}

func TestTieredSearcher_Straddle_SameIDDifferentTS_BothKept(t *testing.T) {
	// (ts, id) key: same id but different ts must NOT dedupe (they are distinct
	// (ts, id) tuples per cold-tier.md §5.2).
	id := "real-uuid"
	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{
		makeEvent(id, hotCutoff30.Add(time.Hour)),
	}}}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{
		makeEvent(id, hotCutoff30.Add(-time.Hour)),
	}}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	q := kernel.SearchQuery{From: hotCutoff30.Add(-24 * time.Hour), To: fixedNow, Limit: 50}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(page.Events) != 2 {
		t.Errorf("same-id different-ts rows must both be kept: got %d, want 2", len(page.Events))
	}
}

func TestTieredSearcher_Straddle_SortedTSDesc(t *testing.T) {
	ts1 := fixedNow.Add(-time.Hour)
	ts2 := hotCutoff30.Add(time.Hour)
	ts3 := hotCutoff30.Add(-time.Hour)
	ts4 := hotCutoff30.Add(-24 * time.Hour)

	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{
		makeEvent("e1", ts1),
		makeEvent("e2", ts2),
	}}}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{
		makeEvent("e3", ts3),
		makeEvent("e4", ts4),
	}}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(-48 * time.Hour),
		To:    fixedNow,
		Limit: 50,
	}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	// Must be sorted ts DESC: ts1 > ts2 > ts3 > ts4.
	want := []time.Time{ts1, ts2, ts3, ts4}
	if len(page.Events) != len(want) {
		t.Fatalf("got %d events, want %d", len(page.Events), len(want))
	}
	for i, ev := range page.Events {
		if !ev.TS.Equal(want[i]) {
			t.Errorf("event[%d] ts = %v, want %v", i, ev.TS, want[i])
		}
	}
}

func TestTieredSearcher_Straddle_LimitApplied(t *testing.T) {
	// If both tiers return many events, only Limit are returned.
	limit := 3
	var hotEvts, coldEvts []kernel.LogEvent
	for i := 0; i < 5; i++ {
		hotEvts = append(hotEvts, makeEvent("h"+string(rune('0'+i)), hotCutoff30.Add(time.Duration(i)*time.Hour)))
		coldEvts = append(coldEvts, makeEvent("c"+string(rune('0'+i)), hotCutoff30.Add(-time.Duration(i+1)*time.Hour)))
	}
	hot := &fakeLogStore{page: kernel.SearchPage{Events: hotEvts}}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: coldEvts}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)

	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(-48 * time.Hour),
		To:    fixedNow,
		Limit: limit,
	}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(page.Events) > limit {
		t.Errorf("union returned %d events, want at most %d", len(page.Events), limit)
	}
}

func TestTieredSearcher_Straddle_NoCursorReturned(t *testing.T) {
	hot := &fakeLogStore{page: kernel.SearchPage{
		Events:     []kernel.LogEvent{makeEvent("h1", hotCutoff30.Add(time.Hour))},
		NextCursor: &kernel.Cursor{TS: hotCutoff30, ID: "h1"},
	}}
	cold := &fakeColdArchive{}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	q := kernel.SearchQuery{
		From:  hotCutoff30.Add(-24 * time.Hour),
		To:    fixedNow,
		Limit: 50,
	}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	// Cross-tier pagination is not implemented; cursor must be nil.
	if page.NextCursor != nil {
		t.Errorf("straddle search returned a cursor (cross-tier pagination not supported yet)")
	}
}

// ---------------------------------------------------------------------------
// Partial failure handling
// ---------------------------------------------------------------------------

func TestTieredSearcher_Straddle_HotError_ReturnsColdOnly(t *testing.T) {
	coldEvt := makeEvent("c1", hotCutoff30.Add(-time.Hour))
	hot := &fakeLogStore{err: errors.New("postgres down")}
	cold := &fakeColdArchive{page: kernel.SearchPage{Events: []kernel.LogEvent{coldEvt}}}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	q := kernel.SearchQuery{From: hotCutoff30.Add(-24 * time.Hour), To: fixedNow, Limit: 50}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search with hot error: %v", err)
	}
	if len(page.Events) != 1 {
		t.Errorf("got %d events from cold, want 1", len(page.Events))
	}
}

func TestTieredSearcher_Straddle_ColdError_ReturnsHotOnly(t *testing.T) {
	hotEvt := makeEvent("h1", hotCutoff30.Add(time.Hour))
	hot := &fakeLogStore{page: kernel.SearchPage{Events: []kernel.LogEvent{hotEvt}}}
	cold := &fakeColdArchive{err: errors.New("athena down")}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	q := kernel.SearchQuery{From: hotCutoff30.Add(-24 * time.Hour), To: fixedNow, Limit: 50}
	page, err := ts.Search(tcA, context.Background(), q)
	if err != nil {
		t.Fatalf("Search with cold error: %v", err)
	}
	if len(page.Events) != 1 {
		t.Errorf("got %d events from hot, want 1", len(page.Events))
	}
}

func TestTieredSearcher_Straddle_BothError_ReturnsError(t *testing.T) {
	hot := &fakeLogStore{err: errors.New("postgres down")}
	cold := &fakeColdArchive{err: errors.New("athena down")}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	q := kernel.SearchQuery{From: hotCutoff30.Add(-24 * time.Hour), To: fixedNow, Limit: 50}
	_, err := ts.Search(tcA, context.Background(), q)
	if err == nil {
		t.Fatal("expected error when both tiers fail, got nil")
	}
}

// ---------------------------------------------------------------------------
// Tenant context forwarding
// ---------------------------------------------------------------------------

func TestTieredSearcher_PassesTenantContextToHot(t *testing.T) {
	hot := &fakeLogStore{}
	cold := &fakeColdArchive{}
	ts := NewTieredSearcher(hot, cold, 30, true,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	q := kernel.SearchQuery{From: hotCutoff30.Add(time.Hour), To: fixedNow, Limit: 10}
	_, _ = ts.Search(tcA, context.Background(), q)

	if len(hot.callTCs) == 0 || hot.callTCs[0].TenantID != tcA.TenantID {
		t.Errorf("hot store did not receive correct tenant context")
	}
}

// ---------------------------------------------------------------------------
// Page-size defaults / caps
// ---------------------------------------------------------------------------

func TestTieredSearcher_AppliesDefaultLimit(t *testing.T) {
	hot := &fakeLogStore{}
	ts := NewTieredSearcher(hot, nil, 30, false,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	_, _ = ts.Search(tcA, context.Background(), kernel.SearchQuery{})
	if len(hot.calls) != 1 || hot.calls[0].Limit != DefaultSearchLimit {
		t.Errorf("Limit not defaulted: got %d, want %d", hot.calls[0].Limit, DefaultSearchLimit)
	}
}

func TestTieredSearcher_CapsOverSizeLimit(t *testing.T) {
	hot := &fakeLogStore{}
	ts := NewTieredSearcher(hot, nil, 30, false,
		WithTieredClock(func() time.Time { return fixedNow }),
	)
	_, _ = ts.Search(tcA, context.Background(), kernel.SearchQuery{Limit: MaxSearchLimit + 1})
	if len(hot.calls) != 1 || hot.calls[0].Limit != MaxSearchLimit {
		t.Errorf("Limit not capped: got %d, want %d", hot.calls[0].Limit, MaxSearchLimit)
	}
}
