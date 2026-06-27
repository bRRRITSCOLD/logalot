package httpx

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
)

const (
	keyTenant     = kernel.TenantID("11111111-1111-1111-1111-111111111111")
	foreignTenant = kernel.TenantID("99999999-9999-9999-9999-999999999999")
)

// stubAuth maps a presented credential to a fixed TenantContext, exactly as the
// real auth package produces one from a key — so the HTTP layer can be proven to
// subscribe to the AUTHENTICATOR's tenant without standing up Postgres/Redis.
type stubAuth struct {
	tc  kernel.TenantContext
	err error
}

func (s stubAuth) Authenticate(_ context.Context, _ kernel.Credential) (kernel.TenantContext, error) {
	return s.tc, s.err
}

// recordingBus is a kernel.TailBus that records the tenant Subscribe was called
// with (proving channel-from-context) and how many times — so a test can assert
// NO subscribe happens on a bad credential. It returns a channel the test feeds.
type recordingBus struct {
	mu         sync.Mutex
	subscribed []kernel.TenantContext
	ch         chan kernel.LogEvent
}

func newRecordingBus() *recordingBus { return &recordingBus{ch: make(chan kernel.LogEvent)} }

func (b *recordingBus) Publish(kernel.TenantContext, context.Context, kernel.LogEvent) error {
	return nil
}

func (b *recordingBus) Subscribe(tc kernel.TenantContext, _ context.Context) (<-chan kernel.LogEvent, error) {
	b.mu.Lock()
	b.subscribed = append(b.subscribed, tc)
	b.mu.Unlock()
	return b.ch, nil
}

func (b *recordingBus) subscribeCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subscribed)
}

func (b *recordingBus) lastTenant() (kernel.TenantID, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.subscribed) == 0 {
		return "", false
	}
	return b.subscribed[len(b.subscribed)-1].TenantID, true
}

func okTenant() kernel.TenantContext {
	return kernel.TenantContext{TenantID: keyTenant, Role: kernel.RoleMember}
}

// newTestServer wires the REAL app core over the given bus, behind the given
// authenticator — the full handler->app->bus path under test.
func newTestServer(t *testing.T, authr kernel.Authenticator, bus kernel.TailBus, ready func(context.Context) error) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := app.New(bus)
	h := NewHandler(svc, ready, log)
	srv := httptest.NewServer(NewRouter(h, authr, log))
	t.Cleanup(srv.Close)
	return srv
}

// openTail issues GET /v1/tail with the given Accept and Authorization, returning
// the live response (caller must Close). The request context is cancelled by the
// returned cancel so the server tears the stream down.
func openTail(t *testing.T, baseURL, accept, auth string) (*http.Response, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/tail", nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	return resp, cancel
}

func bearer() string { return "Bearer lgk_acme_keyid_secret" }

// TestTail_401OnMissingCredential_NoSubscribe is the load-bearing
// auth-before-subscribe test: a missing credential is rejected and NO subscribe
// happens on the bus.
func TestTail_401OnMissingCredential_NoSubscribe(t *testing.T) {
	bus := newRecordingBus()
	srv := newTestServer(t, stubAuth{tc: okTenant()}, bus, nil)

	resp, cancel := openTail(t, srv.URL, "text/event-stream", "")
	defer cancel()
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", resp.StatusCode)
	}
	if bus.subscribeCount() != 0 {
		t.Fatal("subscribe must NOT happen without a credential")
	}
}

func TestTail_401OnBadCredential_NoSubscribe(t *testing.T) {
	bus := newRecordingBus()
	srv := newTestServer(t, stubAuth{err: errors.New("auth: unknown api key")}, bus, nil)

	resp, cancel := openTail(t, srv.URL, "text/event-stream", bearer())
	defer cancel()
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", resp.StatusCode)
	}
	if bus.subscribeCount() != 0 {
		t.Fatal("subscribe must NOT happen on auth failure")
	}
}

func TestTail_406WhenNotEventStream(t *testing.T) {
	bus := newRecordingBus()
	srv := newTestServer(t, stubAuth{tc: okTenant()}, bus, nil)

	resp, cancel := openTail(t, srv.URL, "application/json", bearer())
	defer cancel()
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotAcceptable {
		t.Fatalf("status=%d, want 406 (requires text/event-stream)", resp.StatusCode)
	}
}

// TestTail_StreamsEventAsSSEFrameForAuthedTenant proves the end-to-end edge:
// proper SSE headers, the subscription is for the AUTHENTICATED tenant, and a
// published event is rendered as a `data:` frame.
func TestTail_StreamsEventAsSSEFrameForAuthedTenant(t *testing.T) {
	bus := newRecordingBus()
	srv := newTestServer(t, stubAuth{tc: okTenant()}, bus, nil)

	resp, cancel := openTail(t, srv.URL, "text/event-stream", bearer())
	defer cancel()
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type=%q, want text/event-stream", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control=%q, want no-cache", cc)
	}

	// The subscription must be for the authenticated tenant, not user input.
	waitFor(t, time.Second, func() bool { return bus.subscribeCount() == 1 })
	if got, _ := bus.lastTenant(); got != keyTenant {
		t.Fatalf("subscribed tenant=%q, want the authed tenant %q", got, keyTenant)
	}

	// Publish an event; expect a data: frame carrying it.
	bus.ch <- kernel.LogEvent{Level: kernel.LevelInfo, Service: "api", Message: "hello-sse", TS: time.Now()}

	line := readUntilData(t, resp.Body, 2*time.Second)
	if !strings.Contains(line, "hello-sse") {
		t.Fatalf("data frame = %q, want it to contain the event message", line)
	}
}

func TestHealthz(t *testing.T) {
	srv := newTestServer(t, stubAuth{tc: okTenant()}, newRecordingBus(), nil)
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
		srv := newTestServer(t, stubAuth{tc: okTenant()}, newRecordingBus(), func(context.Context) error { return nil })
		resp, err := http.Get(srv.URL + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("readyz status=%d, want 200", resp.StatusCode)
		}
	})
	t.Run("unavailable when redis is down", func(t *testing.T) {
		srv := newTestServer(t, stubAuth{tc: okTenant()}, newRecordingBus(), func(context.Context) error { return errors.New("redis down") })
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

// readUntilData reads SSE lines until a `data:` frame (skipping comment/heartbeat
// lines) or the deadline elapses.
func readUntilData(t *testing.T, body io.Reader, d time.Duration) string {
	t.Helper()
	type result struct{ line string }
	ch := make(chan result, 1)
	go func() {
		sc := bufio.NewScanner(body)
		for sc.Scan() {
			ln := sc.Text()
			if strings.HasPrefix(ln, "data:") {
				ch <- result{ln}
				return
			}
		}
		ch <- result{""}
	}()
	select {
	case r := <-ch:
		if r.line == "" {
			t.Fatal("stream closed before any data frame")
		}
		return r.line
	case <-time.After(d):
		t.Fatal("timed out waiting for a data frame")
		return ""
	}
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
}
