package httpx

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/app"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/ratelimit"
)

// durationSeconds renders whole seconds as a time.Duration for fake decisions.
func durationSeconds(s int) time.Duration { return time.Duration(s) * time.Second }

// newTestServerRL wires the full handler→app→broker path behind auth + the given
// rate limiter, returning the server URL.
func newTestServerRL(t *testing.T, authr kernel.Authenticator, broker kernel.Broker, lim ratelimit.Limiter, failOpen bool) string {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := app.New(broker)
	h := NewHandler(svc, nil, log)
	srv := httptest.NewServer(NewRouter(h, authr, RateLimit{Limiter: lim, FailOpen: failOpen}, log))
	t.Cleanup(srv.Close)
	return srv.URL
}

// fakeLimiter is a hand-built ratelimit.Limiter for HTTP-layer tests. It keeps a
// per-tenant remaining counter (proving the middleware passes the AUTHENTICATED
// tenant through to the limiter) and can be forced to error to exercise fail-open
// vs fail-closed without standing up Redis.
type fakeLimiter struct {
	mu        sync.Mutex
	remaining map[kernel.TenantID]int
	retry     int // seconds reported on denial
	err       error
	seen      []kernel.TenantID // tenants the middleware asked about, in order
}

func newFakeLimiter(err error) *fakeLimiter {
	return &fakeLimiter{remaining: map[kernel.TenantID]int{}, retry: 2, err: err}
}

func (f *fakeLimiter) allowN(id kernel.TenantID, n int) { f.remaining[id] = n }

func (f *fakeLimiter) Allow(tc kernel.TenantContext, _ context.Context) (ratelimit.Decision, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen = append(f.seen, tc.TenantID)
	if f.err != nil {
		return ratelimit.Decision{}, f.err
	}
	if f.remaining[tc.TenantID] > 0 {
		f.remaining[tc.TenantID]--
		return ratelimit.Decision{Allowed: true}, nil
	}
	return ratelimit.Decision{
		Allowed:    false,
		RetryAfter: durationSeconds(f.retry),
	}, nil
}

func newRateLimitedServer(t *testing.T, lim ratelimit.Limiter, failOpen bool) (*recordingBroker, string) {
	t.Helper()
	rb := &recordingBroker{}
	srv := newTestServerRL(t, stubAuth{tc: okTenant()}, rb, lim, failOpen)
	return rb, srv
}

func TestRateLimit_AllowsUnderLimitThenPublishes(t *testing.T) {
	lim := newFakeLimiter(nil)
	lim.allowN(keyTenant, 1)
	rb, url := newRateLimitedServer(t, lim, true)

	resp := post(t, url+"/v1/ingest", "application/json", bearer(), `{"message":"hi"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status=%d, want 202 under the limit", resp.StatusCode)
	}
	if len(rb.snapshot()) != 1 {
		t.Fatalf("published %d, want 1 (under-limit request must reach publish)", len(rb.snapshot()))
	}
}

func TestRateLimit_429WithRetryAfterOverLimit(t *testing.T) {
	lim := newFakeLimiter(nil) // 0 remaining => immediate denial
	rb, url := newRateLimitedServer(t, lim, true)

	resp := post(t, url+"/v1/ingest", "application/json", bearer(), `{"message":"hi"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status=%d, want 429 over the limit", resp.StatusCode)
	}
	if ra := resp.Header.Get("Retry-After"); ra != "2" {
		t.Fatalf("Retry-After=%q, want %q", ra, "2")
	}
	if len(rb.snapshot()) != 0 {
		t.Fatal("a throttled request must NOT publish")
	}
}

func TestRateLimit_FailOpenAdmitsOnLimiterError(t *testing.T) {
	lim := newFakeLimiter(errors.New("redis down"))
	rb, url := newRateLimitedServer(t, lim, true) // fail-open

	resp := post(t, url+"/v1/ingest", "application/json", bearer(), `{"message":"hi"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status=%d, want 202 (fail-open admits when limiter errors)", resp.StatusCode)
	}
	if len(rb.snapshot()) != 1 {
		t.Fatal("fail-open must let the request reach publish")
	}
}

func TestRateLimit_FailClosedRejectsOnLimiterError(t *testing.T) {
	lim := newFakeLimiter(errors.New("redis down"))
	rb, url := newRateLimitedServer(t, lim, false) // fail-closed

	resp := post(t, url+"/v1/ingest", "application/json", bearer(), `{"message":"hi"}`)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status=%d, want 503 (fail-closed rejects when limiter errors)", resp.StatusCode)
	}
	if len(rb.snapshot()) != 0 {
		t.Fatal("fail-closed must not publish when the limiter is down")
	}
}

// The HTTP-layer isolation proof: the middleware keys the limiter by the
// AUTHENTICATED tenant. Tenant A is exhausted (429) while tenant B (a different
// authenticated context) still passes — and the limiter only ever saw the
// authenticated tenant id, never a body value.
func TestRateLimit_PerTenantIsolationAtHTTPLayer(t *testing.T) {
	lim := newFakeLimiter(nil)
	lim.allowN(keyTenant, 0)     // tenant A: throttled
	lim.allowN(foreignTenant, 1) // tenant B: one allowed

	rbA := &recordingBroker{}
	urlA := newTestServerRL(t, stubAuth{tc: okTenant()}, rbA, lim, true)
	rbB := &recordingBroker{}
	tcB := kernel.TenantContext{TenantID: foreignTenant, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
	urlB := newTestServerRL(t, stubAuth{tc: tcB}, rbB, lim, true)

	respA := post(t, urlA+"/v1/ingest", "application/json", bearer(), `{"message":"a"}`)
	defer func() { _ = respA.Body.Close() }()
	respB := post(t, urlB+"/v1/ingest", "application/json", bearer(), `{"message":"b"}`)
	defer func() { _ = respB.Body.Close() }()

	if respA.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("tenant A status=%d, want 429", respA.StatusCode)
	}
	if respB.StatusCode != http.StatusAccepted {
		t.Fatalf("tenant B status=%d, want 202 — A's limit must not throttle B", respB.StatusCode)
	}
	// The limiter must have been keyed only by the authenticated tenants.
	for _, id := range lim.seen {
		if id != keyTenant && id != foreignTenant {
			t.Fatalf("limiter saw unexpected tenant %q (must be the authenticated tenant only)", id)
		}
	}
}
