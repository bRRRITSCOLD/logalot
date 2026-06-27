//go:build integration

// End-to-end live-tail integration test: a real Gin SSE server over the real
// pkg/tailbus Redis adapter in a random-port testcontainer (the host runs a
// conflicting redis). Gated behind the `integration` tag:
//
//	go test -tags=integration ./...
//
// It proves what fakes cannot:
//   - an authenticated SSE client receives an event published to its tail
//     channel within 2s (the ADR-0006 latency target), and
//   - two-tenant isolation: a connection authenticated as tenant A receives ONLY
//     tenant A's events when events are published to BOTH tail:A and tail:B —
//     the channel is derived from the verified TenantContext, so B's stream is
//     physically unreachable from A's connection.
//
// The publisher uses the real tailbus.Publish to simulate the processor. Auth is
// stubbed (the real RLS-backed Authenticator needs Postgres; its path is covered
// by unit tests and pkg/auth's own integration tests). The isolation guarantee
// here flows entirely from the channel-from-context derivation, not from auth.
package httpx

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/tailbus"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
	"github.com/redis/go-redis/v9"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

func startRedis(t *testing.T) *redis.Client {
	t.Helper()
	ctx := context.Background()
	c, err := tcredis.Run(ctx, "redis:7-alpine")
	if err != nil {
		t.Fatalf("start redis: %v", err)
	}
	t.Cleanup(func() { _ = c.Terminate(ctx) })
	connStr, err := c.ConnectionString(ctx)
	if err != nil {
		t.Fatalf("redis connection string: %v", err)
	}
	opts, err := redis.ParseURL(connStr)
	if err != nil {
		t.Fatalf("parse redis url: %v", err)
	}
	rc := redis.NewClient(opts)
	t.Cleanup(func() { _ = rc.Close() })
	if err := rc.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	return rc
}

// tailServer wires a real query-service SSE server over a real tailbus.Bus,
// authenticated as the given tenant.
func tailServer(t *testing.T, rc *redis.Client, tenant kernel.TenantID) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := tailbus.New(rc)
	svc := app.New(bus, app.WithLogger(log))
	h := NewHandler(svc, nil, nil, log)
	srv := httptest.NewServer(NewRouter(h, stubAuth{tc: kernel.TenantContext{TenantID: tenant, Role: kernel.RoleMember}}, log))
	t.Cleanup(srv.Close)
	return srv
}

// collectMessages reads SSE `data:` frames off body into out until ctx is done.
func collectMessages(body io.Reader, out chan<- string) {
	sc := bufio.NewScanner(body)
	for sc.Scan() {
		ln := sc.Text()
		if msg, ok := strings.CutPrefix(ln, "data: "); ok {
			out <- msg
		}
	}
}

func TestIntegration_TailReceivesPublishedEventWithin2s(t *testing.T) {
	rc := startRedis(t)
	srv := tailServer(t, rc, keyTenant)

	resp, cancel := openTail(t, srv.URL, "text/event-stream", bearer())
	defer cancel()
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d, want 200", resp.StatusCode)
	}

	frames := make(chan string, 8)
	go collectMessages(resp.Body, frames)

	// Give the SUBSCRIBE a moment to register before publishing (pub/sub drops
	// messages with no subscriber).
	time.Sleep(200 * time.Millisecond)

	// Simulate the processor publishing to tail:{keyTenant}.
	bus := tailbus.New(rc)
	pubTC := kernel.TenantContext{TenantID: keyTenant}
	if err := bus.Publish(pubTC, context.Background(), kernel.LogEvent{
		Level: kernel.LevelInfo, Service: "api", Message: "live-tail-hello", TS: time.Now(),
	}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case msg := <-frames:
		if !strings.Contains(msg, "live-tail-hello") {
			t.Fatalf("received frame %q, want it to contain the published message", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive the event within 2s (ADR-0006 latency target)")
	}
}

// TestIntegration_TwoTenantIsolation is the load-bearing multi-tenancy proof: a
// connection authenticated as tenant A receives ONLY A's events even when events
// are published to BOTH tail:A and tail:B.
func TestIntegration_TwoTenantIsolation(t *testing.T) {
	rc := startRedis(t)

	tenantAID := keyTenant
	tenantBID := foreignTenant

	srvA := tailServer(t, rc, tenantAID)

	respA, cancelA := openTail(t, srvA.URL, "text/event-stream", bearer())
	defer cancelA()
	defer func() { _ = respA.Body.Close() }()
	if respA.StatusCode != http.StatusOK {
		t.Fatalf("A status=%d, want 200", respA.StatusCode)
	}

	framesA := make(chan string, 16)
	go collectMessages(respA.Body, framesA)

	time.Sleep(200 * time.Millisecond) // let A's SUBSCRIBE register

	bus := tailbus.New(rc)
	ctx := context.Background()
	// Publish B's secret to tail:B and A's event to tail:A.
	if err := bus.Publish(kernel.TenantContext{TenantID: tenantBID}, ctx, kernel.LogEvent{
		Level: kernel.LevelError, Service: "b-svc", Message: "TENANT-B-SECRET", TS: time.Now(),
	}); err != nil {
		t.Fatalf("publish B: %v", err)
	}
	if err := bus.Publish(kernel.TenantContext{TenantID: tenantAID}, ctx, kernel.LogEvent{
		Level: kernel.LevelInfo, Service: "a-svc", Message: "tenant-a-event", TS: time.Now(),
	}); err != nil {
		t.Fatalf("publish A: %v", err)
	}

	// A must receive its own event...
	select {
	case msg := <-framesA:
		if strings.Contains(msg, "TENANT-B-SECRET") {
			t.Fatalf("CROSS-TENANT LEAK: A received B's event: %q", msg)
		}
		if !strings.Contains(msg, "tenant-a-event") {
			t.Fatalf("A received unexpected frame %q, want its own event", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("A did not receive its own event")
	}

	// ...and must NEVER receive B's, even given extra time.
	select {
	case msg := <-framesA:
		if strings.Contains(msg, "TENANT-B-SECRET") {
			t.Fatalf("CROSS-TENANT LEAK: A received B's event: %q", msg)
		}
	case <-time.After(500 * time.Millisecond):
		// No further frame — correct: B's event never crossed the channel boundary.
	}
}
