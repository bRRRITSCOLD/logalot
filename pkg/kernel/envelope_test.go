package kernel

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestEnvelopeStableSerialization(t *testing.T) {
	env := Envelope{
		TenantID:   testTenantID,
		ReceivedAt: time.Date(2026, 6, 26, 12, 0, 0, 0, time.UTC),
		Raw:        json.RawMessage(`{"k":"v"}`),
	}
	const golden = `{"tenant_id":"11111111-1111-1111-1111-111111111111",` +
		`"received_at":"2026-06-26T12:00:00Z","raw":{"k":"v"}}`

	b, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != golden {
		t.Fatalf("serialization drift:\n got: %s\nwant: %s", b, golden)
	}

	var got Envelope
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.TenantID != env.TenantID || !got.ReceivedAt.Equal(env.ReceivedAt) || string(got.Raw) != string(env.Raw) {
		t.Fatalf("round-trip mismatch: got %+v want %+v", got, env)
	}
}

func TestEnvelopeValidFailsClosed(t *testing.T) {
	if err := (Envelope{TenantID: ""}).Valid(); !errors.Is(err, ErrNoTenantContext) {
		t.Fatalf("blank envelope Valid() = %v, want ErrNoTenantContext", err)
	}
	if err := (Envelope{TenantID: testTenantID}).Valid(); err != nil {
		t.Fatalf("valid envelope Valid() = %v, want nil", err)
	}
}
