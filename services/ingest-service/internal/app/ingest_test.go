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
type fakeBroker struct {
	published []kernel.Envelope
	failAt    int // 1-based index at which Publish returns failErr; 0 = never
	failErr   error
}

func (f *fakeBroker) Publish(tc kernel.TenantContext, _ context.Context, env kernel.Envelope) error {
	if f.failAt != 0 && len(f.published)+1 == f.failAt {
		return f.failErr
	}
	// Mirror the real adapter: tenant is authoritative from tc.
	env.TenantID = tc.TenantID
	f.published = append(f.published, env)
	return nil
}

func (f *fakeBroker) Consume(kernel.TenantContext, context.Context, kernel.EnvelopeHandler) error {
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
// enqueued envelope uses the KEY's tenant.
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
