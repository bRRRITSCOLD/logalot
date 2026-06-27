package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/app"
)

const (
	keyTenant     = kernel.TenantID("11111111-1111-1111-1111-111111111111")
	foreignTenant = kernel.TenantID("99999999-9999-9999-9999-999999999999")
)

// stubAuth is a realistic kernel.Authenticator: it maps a presented credential to
// a fixed TenantContext, exactly as the real auth package produces one from a key.
// The HTTP layer can therefore prove it uses the AUTHENTICATOR's tenant, not the
// body, without standing up Postgres/Redis.
type stubAuth struct {
	tc  kernel.TenantContext
	err error
}

func (s stubAuth) Authenticate(_ context.Context, _ kernel.Credential) (kernel.TenantContext, error) {
	return s.tc, s.err
}

// recordingBroker captures published envelopes so a test can assert exactly what
// was enqueued. err (when set) simulates a broker failure / unconfirmed publish.
type recordingBroker struct {
	mu        sync.Mutex
	published []kernel.Envelope
	err       error
}

func (b *recordingBroker) Publish(tc kernel.TenantContext, _ context.Context, env kernel.Envelope) error {
	if b.err != nil {
		return b.err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	env.TenantID = tc.TenantID // mirror the real adapter's authoritative overwrite
	b.published = append(b.published, env)
	return nil
}

func (b *recordingBroker) Consume(kernel.TenantContext, context.Context, kernel.EnvelopeHandler) error {
	return nil
}

func (b *recordingBroker) snapshot() []kernel.Envelope {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]kernel.Envelope(nil), b.published...)
}

func okTenant() kernel.TenantContext {
	return kernel.TenantContext{TenantID: keyTenant, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
}

// newTestServer wires the real app core over the given broker, behind the given
// authenticator — i.e. the full handler→app→broker path under test.
func newTestServer(t *testing.T, authr kernel.Authenticator, broker kernel.Broker, ready func(context.Context) error) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := app.New(broker)
	h := NewHandler(svc, ready, log)
	srv := httptest.NewServer(NewRouter(h, authr, log))
	t.Cleanup(srv.Close)
	return srv
}

func post(t *testing.T, url, contentType, auth, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func bearer() string { return "Bearer lgk_acme_keyid_secret" }

func TestIngest_202OnGoodPublish(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), `{"message":"hello","level":"info"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status=%d, want 202", resp.StatusCode)
	}
	var out struct {
		Accepted int `json:"accepted"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Accepted != 1 {
		t.Errorf("accepted=%d, want 1", out.Accepted)
	}
	if got := rb.snapshot(); len(got) != 1 {
		t.Fatalf("broker published %d, want 1", len(got))
	}
}

func TestIngest_401OnMissingKey(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", "", `{"message":"hi"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", resp.StatusCode)
	}
	if len(rb.snapshot()) != 0 {
		t.Error("nothing should be published without a credential")
	}
}

func TestIngest_401OnBadKey(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{err: errors.New("auth: unknown api key")}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), `{"message":"hi"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", resp.StatusCode)
	}
	if len(rb.snapshot()) != 0 {
		t.Error("nothing should be published on auth failure")
	}
}

func TestIngest_403WhenMissingScope(t *testing.T) {
	rb := &recordingBroker{}
	// Valid tenant but no ingest:write scope.
	tc := kernel.TenantContext{TenantID: keyTenant}
	srv := newTestServer(t, stubAuth{tc: tc}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), `{"message":"hi"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", resp.StatusCode)
	}
}

func TestIngest_400OnMalformedJSON(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), `{"message":`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", resp.StatusCode)
	}
	if len(rb.snapshot()) != 0 {
		t.Error("malformed body must not publish")
	}
}

func TestIngest_400OnMissingMessage(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), `{"level":"info"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400 (message required)", resp.StatusCode)
	}
}

func TestIngest_400OnInvalidLevel(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), `{"message":"hi","level":"loud"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400 (invalid level)", resp.StatusCode)
	}
}

func TestIngest_415OnUnsupportedMediaType(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "text/plain", bearer(), `message=hi`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("status=%d, want 415", resp.StatusCode)
	}
}

func TestIngest_5xxWhenBrokerFails(t *testing.T) {
	rb := &recordingBroker{err: errors.New("broker: publish nacked")}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), `{"message":"hi"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 500 || resp.StatusCode > 599 {
		t.Fatalf("status=%d, want a 5xx (no false 202 on broker failure)", resp.StatusCode)
	}
}

// The load-bearing security test: a foreign tenant_id in the BODY must be ignored;
// the enqueued envelope must carry the KEY's tenant.
func TestIngest_TenantFromKeyNotBody(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	body := `{"tenant_id":"` + string(foreignTenant) + `","message":"steal"}`
	resp := post(t, srv.URL+"/v1/ingest", "application/json", bearer(), body)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status=%d, want 202", resp.StatusCode)
	}
	got := rb.snapshot()
	if len(got) != 1 {
		t.Fatalf("published %d, want 1", len(got))
	}
	if got[0].TenantID != keyTenant {
		t.Fatalf("enqueued tenant_id=%q, want the key's tenant %q (body must be ignored)", got[0].TenantID, keyTenant)
	}
	if got[0].TenantID == foreignTenant {
		t.Fatal("envelope tenant was taken from the body — cross-tenant spoof")
	}
}

func TestIngest_NDJSONBulk(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	body := strings.Join([]string{
		`{"message":"one","level":"info"}`,
		`{"message":"two"}`,
		``, // blank separator line tolerated
		`{"message":"three","service":"api"}`,
	}, "\n")
	resp := post(t, srv.URL+"/v1/ingest", "application/x-ndjson", bearer(), body)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status=%d, want 202", resp.StatusCode)
	}
	var out struct {
		Accepted int `json:"accepted"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Accepted != 3 {
		t.Errorf("accepted=%d, want 3", out.Accepted)
	}
	if got := rb.snapshot(); len(got) != 3 {
		t.Fatalf("broker published %d, want 3", len(got))
	}
}

func TestIngest_NDJSONRejectsBadLine(t *testing.T) {
	rb := &recordingBroker{}
	srv := newTestServer(t, stubAuth{tc: okTenant()}, rb, nil)

	body := "{\"message\":\"ok\"}\n{\"oops\":true}\n"
	resp := post(t, srv.URL+"/v1/ingest", "application/x-ndjson", bearer(), body)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400 (second line missing message)", resp.StatusCode)
	}
	if len(rb.snapshot()) != 0 {
		t.Error("a bulk batch with an invalid line must publish nothing (validate before enqueue)")
	}
}

func TestHealthz(t *testing.T) {
	srv := newTestServer(t, stubAuth{tc: okTenant()}, &recordingBroker{}, nil)
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz status=%d, want 200", resp.StatusCode)
	}
}

func TestReadyz(t *testing.T) {
	t.Run("ready when checks pass", func(t *testing.T) {
		srv := newTestServer(t, stubAuth{tc: okTenant()}, &recordingBroker{}, func(context.Context) error { return nil })
		resp, err := http.Get(srv.URL + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("readyz status=%d, want 200", resp.StatusCode)
		}
	})
	t.Run("unavailable when a dependency is down", func(t *testing.T) {
		srv := newTestServer(t, stubAuth{tc: okTenant()}, &recordingBroker{}, func(context.Context) error { return errors.New("broker down") })
		resp, err := http.Get(srv.URL + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("readyz status=%d, want 503", resp.StatusCode)
		}
	})
}
