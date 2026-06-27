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

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
)

// fakePaneler is an in-process Paneler that returns a canned response, letting
// handler tests exercise the parse → call → render path without a database.
type fakePaneler struct {
	gotTC kernel.TenantContext
	gotQ  app.PanelQuery
	data  *app.PanelData
	err   error
}

func (f *fakePaneler) Data(_ context.Context, tc kernel.TenantContext, q app.PanelQuery) (*app.PanelData, error) {
	f.gotTC = tc
	f.gotQ = q
	return f.data, f.err
}

// newPanelServer wires the real handler over a fakePaneler behind stub auth.
func newPanelServer(t *testing.T, authr kernel.Authenticator, panel Paneler) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := NewHandler(nil, nil, panel, nil, log)
	srv := httptest.NewServer(NewRouter(h, authr, log))
	t.Cleanup(srv.Close)
	return srv
}

func getPanelData(t *testing.T, baseURL, query, auth string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+"/v1/panel-data?"+query, nil)
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

const validUUID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"

// TestPanelData_400OnMissingSavedQueryId verifies the required parameter check.
func TestPanelData_400OnMissingSavedQueryId(t *testing.T) {
	fake := &fakePaneler{}
	srv := newPanelServer(t, stubAuth{tc: okTenant()}, fake)

	resp := getPanelData(t, srv.URL, "", bearer())
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400 (savedQueryId missing)", resp.StatusCode)
	}
	if fake.gotQ.SavedQueryID != "" {
		t.Error("panel must not be called when savedQueryId is absent")
	}
}

// TestPanelData_400OnNonUUIDSavedQueryId proves that a non-UUID value is rejected
// at the HTTP edge with 400 rather than reaching the DB and producing a 500 or a
// confusing 404. This covers issue #52.2 (UUID edge validation) and, together with
// issue #52.1 (errors.Is(err, pgx.ErrNoRows)), ensures a malformed savedQueryId
// can never surface as a 500 from a "invalid input syntax for type uuid" DB error.
//
// Note: the google/uuid library accepts both the canonical dashed form
// (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) and the compact 32-hex form, so 32-char
// hex strings are valid and return 404, not 400. Only genuinely un-parseable values
// (non-hex chars, wrong length after stripping dashes) are rejected here.
func TestPanelData_400OnNonUUIDSavedQueryId(t *testing.T) {
	cases := map[string]string{
		"short string":        "notauuid",
		"too long":            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-extra",
		"wrong format":        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaXXXX",
		"invalid uuid syntax": "invalid input syntax for type uuid",
		"partial uuid":        "aaaaaaaa-aaaa-aaaa-aaaa",
	}
	for name, badID := range cases {
		t.Run(name, func(t *testing.T) {
			fake := &fakePaneler{}
			srv := newPanelServer(t, stubAuth{tc: okTenant()}, fake)

			q := url.Values{}
			q.Set("savedQueryId", badID)
			resp := getPanelData(t, srv.URL, q.Encode(), bearer())
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("savedQueryId=%q: status=%d, want 400", badID, resp.StatusCode)
			}
			if fake.gotQ.SavedQueryID != "" {
				t.Errorf("savedQueryId=%q: panel must not be called on bad UUID", badID)
			}
		})
	}
}

// TestPanelData_200OnValidUUID proves that a proper UUID reaches the Paneler and
// returns the canned data.
func TestPanelData_200OnValidUUID(t *testing.T) {
	canned := &app.PanelData{
		TotalCount: 5,
		Buckets:    []app.Bucket{},
		RecentLogs: nil,
	}
	fake := &fakePaneler{data: canned}
	srv := newPanelServer(t, stubAuth{tc: okTenant()}, fake)

	q := url.Values{}
	q.Set("savedQueryId", validUUID)
	resp := getPanelData(t, srv.URL, q.Encode(), bearer())
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d, want 200", resp.StatusCode)
	}
	if fake.gotQ.SavedQueryID != validUUID {
		t.Errorf("paneler received savedQueryId=%q, want %q", fake.gotQ.SavedQueryID, validUUID)
	}
	// Tenancy must come from auth, never from the query param.
	if fake.gotTC.TenantID != keyTenant {
		t.Errorf("paneler tenant=%q, want authed tenant %q", fake.gotTC.TenantID, keyTenant)
	}
	var body app.PanelData
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.TotalCount != 5 {
		t.Errorf("TotalCount=%d, want 5", body.TotalCount)
	}
}

// TestPanelData_404WhenPanelerReturnsNil proves that a missing saved query yields 404.
func TestPanelData_404WhenPanelerReturnsNil(t *testing.T) {
	fake := &fakePaneler{data: nil}
	srv := newPanelServer(t, stubAuth{tc: okTenant()}, fake)

	q := url.Values{}
	q.Set("savedQueryId", validUUID)
	resp := getPanelData(t, srv.URL, q.Encode(), bearer())
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status=%d, want 404 (saved query not found)", resp.StatusCode)
	}
}

// TestPanelData_401OnMissingCredential proves auth is required.
func TestPanelData_401OnMissingCredential(t *testing.T) {
	fake := &fakePaneler{}
	srv := newPanelServer(t, stubAuth{tc: okTenant()}, fake)

	q := url.Values{}
	q.Set("savedQueryId", validUUID)
	resp := getPanelData(t, srv.URL, q.Encode(), "" /* no auth */)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", resp.StatusCode)
	}
	if fake.gotQ.SavedQueryID != "" {
		t.Error("panel must not be called without a credential")
	}
}

// TestPanelData_400OnBadParams exercises the remaining parameter validations.
func TestPanelData_400OnBadParams(t *testing.T) {
	cases := map[string]string{
		"bad from":      "savedQueryId=" + validUUID + "&from=not-a-time",
		"bad to":        "savedQueryId=" + validUUID + "&to=not-a-time",
		"from after to": "savedQueryId=" + validUUID + "&from=2026-06-28T00:00:00Z&to=2026-06-27T00:00:00Z",
		"bad buckets":   "savedQueryId=" + validUUID + "&buckets=0",
		"big buckets":   "savedQueryId=" + validUUID + "&buckets=101",
		"bad limit":     "savedQueryId=" + validUUID + "&recentLimit=0",
		"big limit":     "savedQueryId=" + validUUID + "&recentLimit=200",
	}
	for name, q := range cases {
		t.Run(name, func(t *testing.T) {
			fake := &fakePaneler{}
			srv := newPanelServer(t, stubAuth{tc: okTenant()}, fake)
			resp := getPanelData(t, srv.URL, q, bearer())
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("%s: status=%d, want 400", name, resp.StatusCode)
			}
			if fake.gotQ.SavedQueryID != "" {
				t.Fatalf("%s: panel must not be called on bad params", name)
			}
		})
	}
}
