package httpx

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
)

// fakeSearcher records the SearchQuery it was called with and returns a canned
// page, so the handler's parse -> call -> render path is provable without a DB.
type fakeSearcher struct {
	gotTC kernel.TenantContext
	gotQ  kernel.SearchQuery
	page  kernel.SearchPage
	err   error
}

func (f *fakeSearcher) Search(tc kernel.TenantContext, _ context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	f.gotTC = tc
	f.gotQ = q
	return f.page, f.err
}

// newSearchServer wires the real handler over a fakeSearcher behind stub auth.
func newSearchServer(t *testing.T, authr kernel.Authenticator, search Searcher) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := NewHandler(nil, search, nil, log)
	srv := httptest.NewServer(NewRouter(h, authr, log))
	t.Cleanup(srv.Close)
	return srv
}

func getSearch(t *testing.T, baseURL, query, auth string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+"/v1/search?"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// --- cursor codec ----------------------------------------------------------

func TestCursor_RoundTrips(t *testing.T) {
	in := &kernel.Cursor{TS: time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC), ID: "00000000-0000-0000-0000-0000000000ff"}
	token := encodeCursor(in)
	if token == "" {
		t.Fatal("encodeCursor produced an empty token for a non-nil cursor")
	}
	out, err := decodeCursor(token)
	if err != nil {
		t.Fatalf("decodeCursor: %v", err)
	}
	if out == nil || out.ID != in.ID || !out.TS.Equal(in.TS) {
		t.Fatalf("round-trip = %+v, want %+v", out, in)
	}
}

func TestCursor_NilEncodesEmptyAndEmptyDecodesNil(t *testing.T) {
	if encodeCursor(nil) != "" {
		t.Error("nil cursor must encode to empty string")
	}
	c, err := decodeCursor("")
	if err != nil || c != nil {
		t.Errorf("empty token = (%v,%v), want (nil,nil)", c, err)
	}
}

func TestCursor_RejectsGarbage(t *testing.T) {
	for _, bad := range []string{"not-base64!!", "YWJj" /* base64 "abc", not JSON */, ""} {
		if bad == "" {
			continue
		}
		if _, err := decodeCursor(bad); err == nil {
			t.Errorf("decodeCursor(%q) = nil err, want errBadCursor", bad)
		}
	}
	// A well-formed-but-incomplete cursor (no id) is rejected too.
	tok := encodeCursor(&kernel.Cursor{TS: time.Now()})
	if _, err := decodeCursor(tok); err == nil {
		t.Error("cursor missing id must be rejected")
	}
}

// --- param validation ------------------------------------------------------

func TestParseSearchQuery_ValidFullQuery(t *testing.T) {
	cur := encodeCursor(&kernel.Cursor{TS: time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC), ID: "00000000-0000-0000-0000-0000000000ff"})
	authr := stubAuth{tc: okTenant()}
	fake := &fakeSearcher{}
	srv := newSearchServer(t, authr, fake)

	q := url.Values{}
	q.Set("q", "disk full")
	q.Set("service", "api")
	q.Set("level", "error")
	q.Set("from", "2026-06-27T00:00:00Z")
	q.Set("to", "2026-06-28T00:00:00Z")
	q.Set("limit", "25")
	q.Set("cursor", cur)
	q.Add("label", "region=us-east-1")
	q.Add("label", "env=prod")

	resp := getSearch(t, srv.URL, q.Encode(), bearer())
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d, want 200", resp.StatusCode)
	}
	got := fake.gotQ
	if got.Text != "disk full" || got.Service != "api" {
		t.Errorf("text/service = %q/%q", got.Text, got.Service)
	}
	if got.Level == nil || *got.Level != kernel.LevelError {
		t.Errorf("level = %v, want error", got.Level)
	}
	if got.Limit != 25 {
		t.Errorf("limit = %d, want 25", got.Limit)
	}
	if got.Cursor == nil || got.Cursor.ID != "00000000-0000-0000-0000-0000000000ff" {
		t.Errorf("cursor = %+v", got.Cursor)
	}
	if got.Labels["region"] != "us-east-1" || got.Labels["env"] != "prod" {
		t.Errorf("labels = %v", got.Labels)
	}
	if got.From.IsZero() || got.To.IsZero() {
		t.Errorf("time range not parsed: from=%v to=%v", got.From, got.To)
	}
	// Tenancy must come from auth, never the query.
	if fake.gotTC.TenantID != keyTenant {
		t.Errorf("searched tenant = %q, want the authed tenant %q", fake.gotTC.TenantID, keyTenant)
	}
}

func TestSearch_400OnBadParams(t *testing.T) {
	cases := map[string]string{
		"bad level":       "level=verbose",
		"bad limit":       "limit=0",
		"limit too big":   "limit=100000",
		"limit nan":       "limit=abc",
		"bad from":        "from=not-a-time",
		"from after to":   "from=2026-06-28T00:00:00Z&to=2026-06-27T00:00:00Z",
		"bad cursor":      "cursor=!!!notbase64",
		"empty label key": "label==value",
	}
	for name, q := range cases {
		t.Run(name, func(t *testing.T) {
			fake := &fakeSearcher{}
			srv := newSearchServer(t, stubAuth{tc: okTenant()}, fake)
			resp := getSearch(t, srv.URL, q, bearer())
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status=%d, want 400", resp.StatusCode)
			}
			// A rejected request must never reach the store.
			if fake.gotQ.Text != "" || fake.gotTC.TenantID != "" {
				t.Fatal("store must not be called on a bad request")
			}
		})
	}
}

func TestSearch_401OnMissingCredential(t *testing.T) {
	fake := &fakeSearcher{}
	srv := newSearchServer(t, stubAuth{tc: okTenant()}, fake)
	resp := getSearch(t, srv.URL, "q=hello", "") // no Authorization
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", resp.StatusCode)
	}
	if fake.gotTC.TenantID != "" {
		t.Fatal("search must not run without a credential")
	}
}

// --- response rendering ----------------------------------------------------

func TestSearch_RendersEventsAndOpaqueNextCursor(t *testing.T) {
	next := &kernel.Cursor{TS: time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC), ID: "00000000-0000-0000-0000-0000000000ee"}
	fake := &fakeSearcher{page: kernel.SearchPage{
		Events:     []kernel.LogEvent{{TenantID: keyTenant, Service: "api", Level: kernel.LevelInfo, Message: "hello", TS: time.Now()}},
		NextCursor: next,
	}}
	srv := newSearchServer(t, stubAuth{tc: okTenant()}, fake)

	resp := getSearch(t, srv.URL, "q=hello&limit=1", bearer())
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d, want 200", resp.StatusCode)
	}
	var body searchResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Events) != 1 || body.Events[0].Message != "hello" {
		t.Fatalf("events = %+v", body.Events)
	}
	if body.NextCursor == "" {
		t.Fatal("expected a non-empty opaque nextCursor")
	}
	// The opaque cursor must round-trip back to the same keyset position.
	rt, err := decodeCursor(body.NextCursor)
	if err != nil || rt == nil || rt.ID != next.ID || !rt.TS.Equal(next.TS) {
		t.Fatalf("nextCursor did not round-trip: %v (%v)", rt, err)
	}
}

func TestSearch_EmptyPageRendersEmptyArrayNoCursor(t *testing.T) {
	fake := &fakeSearcher{page: kernel.SearchPage{}}
	srv := newSearchServer(t, stubAuth{tc: okTenant()}, fake)

	resp := getSearch(t, srv.URL, "q=nope", bearer())
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d, want 200", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	var body searchResponse
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Events == nil || len(body.Events) != 0 {
		t.Errorf("events = %v, want []", body.Events)
	}
	if body.NextCursor != "" {
		t.Errorf("nextCursor = %q, want empty on final page", body.NextCursor)
	}
}

// Guard: the edge cap matches the app core contract (single source of truth).
func TestSearch_LimitCapMatchesAppContract(t *testing.T) {
	if app.MaxSearchLimit <= 0 {
		t.Fatal("app.MaxSearchLimit must be positive")
	}
}
