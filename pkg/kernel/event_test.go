package kernel

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func sampleEvent() LogEvent {
	return LogEvent{
		TenantID: testTenantID,
		TS:       time.Date(2026, 6, 26, 12, 0, 0, 0, time.UTC),
		ID:       "22222222-2222-2222-2222-222222222222",
		Service:  "api",
		Level:    LevelInfo,
		Message:  "hello",
		Labels:   map[string]string{"env": "prod", "region": "us"},
		TraceID:  "t1",
		SpanID:   "s1",
		Raw:      json.RawMessage(`{"k":"v"}`),
	}
}

func TestLogEventStableSerialization(t *testing.T) {
	const golden = `{"tenant_id":"11111111-1111-1111-1111-111111111111",` +
		`"ts":"2026-06-26T12:00:00Z",` +
		`"id":"22222222-2222-2222-2222-222222222222",` +
		`"service":"api","level":"info","message":"hello",` +
		`"labels":{"env":"prod","region":"us"},` +
		`"trace_id":"t1","span_id":"s1","raw":{"k":"v"}}`

	b, err := json.Marshal(sampleEvent())
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != golden {
		t.Fatalf("serialization drift:\n got: %s\nwant: %s", b, golden)
	}
}

func TestLogEventRoundTrip(t *testing.T) {
	want := sampleEvent()
	b, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var got LogEvent
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if !got.TS.Equal(want.TS) {
		t.Fatalf("ts drift: got %v want %v", got.TS, want.TS)
	}
	got.TS, want.TS = time.Time{}, time.Time{} // compared above; normalize for DeepEqual
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round-trip mismatch:\n got %+v\nwant %+v", got, want)
	}
}
