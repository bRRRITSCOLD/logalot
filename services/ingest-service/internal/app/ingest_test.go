package app

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// fakeBroker is a kernel.Broker test double that records published envelopes and
// can be told to fail after N successful publishes.
//
// M1 (issue #35): the fake does NOT overwrite env.TenantID from tc. That was a
// defensive mirror of what the real adapter does, but it masked the app-core's
// own responsibility: app.Ingest must stamp env.TenantID from tc.TenantID before
// calling Publish. Without the overwrite here, the test proves the app sets it.
type fakeBroker struct {
	published []kernel.Envelope
	failAt    int // 1-based index at which Publish returns failErr; 0 = never
	failErr   error
}

func (f *fakeBroker) Publish(_ kernel.TenantContext, _ context.Context, env kernel.Envelope) error {
	if f.failAt != 0 && len(f.published)+1 == f.failAt {
		return f.failErr
	}
	f.published = append(f.published, env)
	return nil
}

func (f *fakeBroker) Consume(kernel.TenantContext, context.Context, kernel.EnvelopeHandler) error {
	return errors.New("not used")
}

// slowBroker simulates a stalled broker that blocks for delay before each
// Publish, respecting ctx cancellation. Used to test the publish-timeout path.
type slowBroker struct {
	delay time.Duration
}

func (b *slowBroker) Publish(_ kernel.TenantContext, ctx context.Context, _ kernel.Envelope) error {
	select {
	case <-time.After(b.delay):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *slowBroker) Consume(kernel.TenantContext, context.Context, kernel.EnvelopeHandler) error {
	return errors.New("not used")
}

const tenantKey = kernel.TenantID("11111111-1111-1111-1111-111111111111")

func tcFor(id kernel.TenantID) kernel.TenantContext {
	return kernel.TenantContext{TenantID: id, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
}

func TestIngest_PublishesEnvelopePerRaw(t *testing.T) {
	fb := &fakeBroker{}
	at := time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC)
	s := New(fb, WithClock(func() time.Time { return at }))

	raws := []json.RawMessage{
		json.RawMessage(`{"message":"a"}`),
		json.RawMessage(`{"message":"b"}`),
	}
	n, err := s.Ingest(tcFor(tenantKey), context.Background(), raws)
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if n != 2 {
		t.Fatalf("published=%d, want 2", n)
	}
	if len(fb.published) != 2 {
		t.Fatalf("broker saw %d, want 2", len(fb.published))
	}
	for i, env := range fb.published {
		if env.TenantID != tenantKey {
			t.Errorf("env[%d].TenantID=%q, want %q", i, env.TenantID, tenantKey)
		}
		if !env.ReceivedAt.Equal(at) {
			t.Errorf("env[%d].ReceivedAt=%v, want %v", i, env.ReceivedAt, at)
		}
	}
}

// The load-bearing security property: a tenant_id in the BODY is ignored; the
// enqueued envelope uses the KEY's tenant. This test proves app.Ingest is
// responsible for stamping env.TenantID (the fakeBroker no longer mirrors the
// overwrite, so only the app-core's own assignment makes this pass — issue #35-M1).
func TestIngest_TenantComesFromKeyNotBody(t *testing.T) {
	fb := &fakeBroker{}
	s := New(fb)

	const foreign = kernel.TenantID("99999999-9999-9999-9999-999999999999")
	raw := json.RawMessage(`{"tenant_id":"` + string(foreign) + `","message":"steal"}`)

	if _, err := s.Ingest(tcFor(tenantKey), context.Background(), []json.RawMessage{raw}); err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if len(fb.published) != 1 {
		t.Fatalf("published %d envelopes, want 1", len(fb.published))
	}
	if got := fb.published[0].TenantID; got != tenantKey {
		t.Fatalf("enqueued tenant_id=%q, want the key's tenant %q (body must be ignored)", got, tenantKey)
	}
	// The foreign id may still ride inside Raw (it is opaque), but it must NOT be
	// the envelope's authoritative tenant.
	if fb.published[0].TenantID == foreign {
		t.Fatal("envelope tenant was taken from the body — cross-tenant spoof")
	}
}

func TestIngest_ReturnsErrorAndCountOnBrokerFailure(t *testing.T) {
	wantErr := errors.New("broker down")
	fb := &fakeBroker{failAt: 2, failErr: wantErr}
	s := New(fb)

	raws := []json.RawMessage{
		json.RawMessage(`{"message":"ok"}`),
		json.RawMessage(`{"message":"boom"}`),
		json.RawMessage(`{"message":"never"}`),
	}
	n, err := s.Ingest(tcFor(tenantKey), context.Background(), raws)
	if !errors.Is(err, wantErr) {
		t.Fatalf("err=%v, want %v", err, wantErr)
	}
	if n != 1 {
		t.Fatalf("published=%d, want 1 (fast-fail at second)", n)
	}
}

func TestIngest_RejectsInvalidTenantContext(t *testing.T) {
	fb := &fakeBroker{}
	s := New(fb)
	if _, err := s.Ingest(kernel.TenantContext{}, context.Background(), []json.RawMessage{json.RawMessage(`{}`)}); err == nil {
		t.Fatal("expected error for empty tenant context (fail closed)")
	}
	if len(fb.published) != 0 {
		t.Fatal("nothing should be published without a valid tenant")
	}
}

// TestIngest_PublishTimeout asserts the issue-#35-I1 invariant: a stalled broker
// that blocks beyond the publish timeout returns an error instead of blocking the
// request goroutine indefinitely. The timeout surfaces as ctx.Err() (deadline
// exceeded) which the transport maps to 503 via the existing error path.
func TestIngest_PublishTimeout(t *testing.T) {
	slow := &slowBroker{delay: time.Hour} // blocks forever without a timeout
	s := New(slow, WithPublishTimeout(5*time.Millisecond))

	_, err := s.Ingest(tcFor(tenantKey), context.Background(), []json.RawMessage{json.RawMessage(`{"message":"x"}`)})
	if err == nil {
		t.Fatal("expected a timeout error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err=%v, want context.DeadlineExceeded", err)
	}
}

// TestIngest_PublishTimeoutZeroDisablesTimeout verifies that WithPublishTimeout(0)
// disables the deadline (opt-out for tests that provide their own ctx deadline).
func TestIngest_PublishTimeoutZeroDisablesTimeout(t *testing.T) {
	slow := &slowBroker{delay: 5 * time.Millisecond} // short delay, will succeed
	s := New(slow, WithPublishTimeout(0))

	_, err := s.Ingest(tcFor(tenantKey), context.Background(), []json.RawMessage{json.RawMessage(`{"message":"x"}`)})
	if err != nil {
		t.Fatalf("WithPublishTimeout(0) should disable the timeout; got err=%v", err)
	}
}
