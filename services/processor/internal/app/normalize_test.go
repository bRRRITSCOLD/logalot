package app

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const tenantA = kernel.TenantID("00000000-0000-0000-0000-00000000000a")
const tenantB = kernel.TenantID("00000000-0000-0000-0000-00000000000b")

func fixedNow() time.Time { return time.Date(2026, 6, 27, 9, 0, 0, 0, time.UTC) }

func env(raw string) kernel.Envelope {
	return kernel.Envelope{TenantID: tenantA, ReceivedAt: fixedNow(), Raw: json.RawMessage(raw)}
}

func TestNormalize_GoodPayload(t *testing.T) {
	tc := kernel.TenantContext{TenantID: tenantA}
	ev, err := Normalize(tc, env(`{
		"message":"db slow","level":"warn","service":"api",
		"ts":"2026-06-27T08:30:00Z","trace_id":"t1","span_id":"s1",
		"labels":{"region":"us-east-1"}
	}`), fixedNow)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if ev.TenantID != tenantA {
		t.Errorf("tenant = %q, want %q", ev.TenantID, tenantA)
	}
	if ev.Message != "db slow" || ev.Service != "api" {
		t.Errorf("message/service = %q/%q", ev.Message, ev.Service)
	}
	if ev.Level != kernel.LevelWarn {
		t.Errorf("level = %q, want warn", ev.Level)
	}
	want := time.Date(2026, 6, 27, 8, 30, 0, 0, time.UTC)
	if !ev.TS.Equal(want) {
		t.Errorf("ts = %v, want %v", ev.TS, want)
	}
	if ev.TraceID != "t1" || ev.SpanID != "s1" {
		t.Errorf("trace/span = %q/%q", ev.TraceID, ev.SpanID)
	}
	if ev.Labels["region"] != "us-east-1" {
		t.Errorf("labels = %v", ev.Labels)
	}
	if len(ev.Raw) == 0 {
		t.Error("raw should be retained")
	}
}

func TestNormalize_TenantFromContextNotBody(t *testing.T) {
	tc := kernel.TenantContext{TenantID: tenantA}
	// Body tries to assert a different tenant; it MUST be ignored.
	ev, err := Normalize(tc, env(`{"message":"x","tenant_id":"`+string(tenantB)+`"}`), fixedNow)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if ev.TenantID != tenantA {
		t.Errorf("tenant = %q, want %q (body tenant must be ignored)", ev.TenantID, tenantA)
	}
}

func TestNormalize_DefaultsLevelInfoAndNow(t *testing.T) {
	tc := kernel.TenantContext{TenantID: tenantA}
	// No level, no ts -> level info, ts from envelope ReceivedAt.
	ev, err := Normalize(tc, env(`{"message":"hi"}`), fixedNow)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if ev.Level != kernel.LevelInfo {
		t.Errorf("level = %q, want info default", ev.Level)
	}
	if !ev.TS.Equal(fixedNow()) {
		t.Errorf("ts = %v, want envelope ReceivedAt %v", ev.TS, fixedNow())
	}
}

func TestNormalize_BadLevelDefaultsInfo(t *testing.T) {
	tc := kernel.TenantContext{TenantID: tenantA}
	ev, err := Normalize(tc, env(`{"message":"hi","level":"SCREAMING"}`), fixedNow)
	if err != nil {
		t.Fatalf("Normalize should tolerate a bad level: %v", err)
	}
	if ev.Level != kernel.LevelInfo {
		t.Errorf("level = %q, want info default for unknown level", ev.Level)
	}
}

func TestNormalize_LabelCoercion(t *testing.T) {
	tc := kernel.TenantContext{TenantID: tenantA}
	ev, err := Normalize(tc, env(`{
		"message":"m",
		"labels":{"n":42,"ok":true,"f":3.14,"nested":{"a":1},"s":"str","nul":null}
	}`), fixedNow)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	checks := map[string]string{
		"n":      "42",
		"ok":     "true",
		"f":      "3.14",
		"nested": `{"a":1}`,
		"s":      "str",
		"nul":    "",
	}
	for k, want := range checks {
		if got := ev.Labels[k]; got != want {
			t.Errorf("label %q = %q, want %q", k, got, want)
		}
	}
}

func TestNormalize_FoldsTopLevelScalarsIntoLabels(t *testing.T) {
	tc := kernel.TenantContext{TenantID: tenantA}
	// "user_id" is not a reserved field, so it becomes a searchable label.
	ev, err := Normalize(tc, env(`{"message":"m","user_id":1234,"env":"prod"}`), fixedNow)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if ev.Labels["user_id"] != "1234" {
		t.Errorf("user_id label = %q, want 1234", ev.Labels["user_id"])
	}
	if ev.Labels["env"] != "prod" {
		t.Errorf("env label = %q, want prod", ev.Labels["env"])
	}
}

func TestNormalize_PoisonPayloads(t *testing.T) {
	tc := kernel.TenantContext{TenantID: tenantA}
	cases := map[string]string{
		"empty":        ``,
		"scalar":       `"just a string"`,
		"number":       `12345`,
		"array":        `[1,2,3]`,
		"invalid json": `{not json`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Normalize(tc, env(raw), fixedNow)
			if !IsPoison(err) {
				t.Fatalf("err = %v, want poison", err)
			}
		})
	}
}

func TestNormalize_AliasesAndEpochTS(t *testing.T) {
	tc := kernel.TenantContext{TenantID: tenantA}
	// msg/svc/severity aliases + millisecond epoch ts.
	ev, err := Normalize(tc, env(`{"msg":"viaAlias","svc":"worker","severity":"error","ts":1750000000000}`), fixedNow)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if ev.Message != "viaAlias" || ev.Service != "worker" || ev.Level != kernel.LevelError {
		t.Errorf("alias parse: msg=%q svc=%q lvl=%q", ev.Message, ev.Service, ev.Level)
	}
	if ev.TS.IsZero() || ev.TS.Year() != 2025 {
		t.Errorf("epoch ts = %v (want ~2025)", ev.TS)
	}
}
