package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// ErrPoison marks a payload that cannot be normalized at all (not a JSON object).
// The handler treats it as a poison message: it is dead-lettered immediately
// rather than retried, because retrying it would never succeed (issue #7: "not
// infinite retry").
var ErrPoison = errors.New("processor: unprocessable payload (poison)")

// fieldAliases is the single source of accepted input key spellings (DRY). Ingest
// clients are heterogeneous, so we tolerate the common synonyms; the first present
// non-empty alias wins.
var (
	messageKeys = []string{"message", "msg", "text"}
	levelKeys   = []string{"level", "severity", "lvl"}
	tsKeys      = []string{"ts", "timestamp", "time", "@timestamp"}
	serviceKeys = []string{"service", "svc", "logger", "source"}
	traceKeys   = []string{"trace_id", "traceId", "trace", "traceID"}
	spanKeys    = []string{"span_id", "spanId", "span", "spanID"}
	labelsKeys  = []string{"labels", "fields", "attributes", "attrs"}
)

// reservedKeys are the top-level keys consumed into first-class LogEvent fields,
// so they are not also folded into labels when we synthesize labels from the
// remaining payload.
var reservedKeys = func() map[string]struct{} {
	m := map[string]struct{}{}
	for _, group := range [][]string{messageKeys, levelKeys, tsKeys, serviceKeys, traceKeys, spanKeys, labelsKeys} {
		for _, k := range group {
			m[k] = struct{}{}
		}
	}
	return m
}()

// Normalize converts an Envelope's untrusted Raw payload into a normalized
// LogEvent. It is deliberately TOLERANT of partial/malformed payloads: missing
// fields fall back to defaults (level -> info, ts -> now, service/message -> "")
// and non-string label values are coerced to strings per the kernel contract.
//
// It is INTOLERANT of a payload that is not a JSON object at all (empty, a scalar,
// an array, or invalid JSON) — that is poison (ErrPoison) and must be
// dead-lettered, not retried.
//
// The tenant_id is taken from tc (the authoritative per-message scope rebuilt
// from the envelope by the broker) and NEVER from the payload body (ADR-0002).
func Normalize(tc kernel.TenantContext, env kernel.Envelope, now func() time.Time) (kernel.LogEvent, error) {
	if len(env.Raw) == 0 {
		return kernel.LogEvent{}, fmt.Errorf("%w: empty payload", ErrPoison)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(env.Raw, &m); err != nil {
		return kernel.LogEvent{}, fmt.Errorf("%w: not a json object: %v", ErrPoison, err)
	}

	ev := kernel.LogEvent{
		TenantID: tc.TenantID, // authoritative, from context — never the body
		TS:       parseTS(m, env, now),
		Service:  firstString(m, serviceKeys),
		Level:    parseLevel(m),
		Message:  firstString(m, messageKeys),
		Labels:   parseLabels(m),
		TraceID:  firstString(m, traceKeys),
		SpanID:   firstString(m, spanKeys),
		Raw:      append(json.RawMessage(nil), env.Raw...), // retain original for fidelity/replay
	}
	return ev, nil
}

// firstString returns the first key whose value is a JSON string, else "".
func firstString(m map[string]json.RawMessage, keys []string) string {
	for _, k := range keys {
		if raw, ok := m[k]; ok {
			if s, ok := asString(raw); ok && s != "" {
				return s
			}
		}
	}
	return ""
}

// parseLevel resolves the level via the kernel enum, defaulting to info when
// missing or unrecognized (issue #7: "default info"). A bad level is tolerated,
// never poison.
func parseLevel(m map[string]json.RawMessage) kernel.Level {
	for _, k := range levelKeys {
		if raw, ok := m[k]; ok {
			if s, ok := asString(raw); ok {
				if lvl, err := kernel.ParseLevel(s); err == nil {
					return lvl
				}
			}
		}
	}
	return kernel.LevelInfo
}

// parseTS resolves the event time. It accepts RFC3339 strings and numeric unix
// seconds/millis; anything unparseable falls back to the envelope receipt time,
// then to now. Always returned in UTC.
func parseTS(m map[string]json.RawMessage, env kernel.Envelope, now func() time.Time) time.Time {
	for _, k := range tsKeys {
		raw, ok := m[k]
		if !ok {
			continue
		}
		if s, ok := asString(raw); ok && s != "" {
			if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
				return t.UTC()
			}
			if t, err := time.Parse(time.RFC3339, s); err == nil {
				return t.UTC()
			}
		}
		// numeric epoch (seconds or milliseconds)
		var n json.Number
		if err := json.Unmarshal(raw, &n); err == nil {
			if i, err := n.Int64(); err == nil && i > 0 {
				return epochToTime(i).UTC()
			}
		}
	}
	if !env.ReceivedAt.IsZero() {
		return env.ReceivedAt.UTC()
	}
	return now().UTC()
}

// epochToTime interprets i as unix seconds or milliseconds by magnitude.
func epochToTime(i int64) time.Time {
	// ~1e12 ms == year 2001; values larger than that are milliseconds.
	const msThreshold = 1_000_000_000_000
	if i >= msThreshold {
		return time.UnixMilli(i)
	}
	return time.Unix(i, 0)
}

// parseLabels builds the string->string labels map. It reads an explicit labels/
// fields object if present, then folds any remaining top-level scalar keys in as
// labels (a flat structured-logging payload becomes searchable labels). Non-string
// scalar values (numbers, bools) are coerced to their string form; nested
// objects/arrays are JSON-encoded to a string (the kernel contract: richer
// structure belongs in Raw, Labels stays flat string->string).
func parseLabels(m map[string]json.RawMessage) map[string]string {
	out := map[string]string{}

	for _, k := range labelsKeys {
		raw, ok := m[k]
		if !ok {
			continue
		}
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(raw, &obj); err == nil {
			for lk, lv := range obj {
				out[lk] = coerceToString(lv)
			}
		}
	}

	// Fold remaining top-level keys (not reserved, not already taken) into labels.
	for k, raw := range m {
		if _, reserved := reservedKeys[k]; reserved {
			continue
		}
		if _, taken := out[k]; taken {
			continue
		}
		out[k] = coerceToString(raw)
	}

	if len(out) == 0 {
		return nil
	}
	return out
}

// asString reports whether raw is a JSON string and returns its value.
func asString(raw json.RawMessage) (string, bool) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s, true
	}
	return "", false
}

// coerceToString renders a JSON value as a flat string per the kernel label
// contract: strings pass through; numbers/bools become their literal text; null
// becomes ""; objects/arrays are re-encoded to their compact JSON text.
func coerceToString(raw json.RawMessage) string {
	if s, ok := asString(raw); ok {
		return s
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return string(raw)
	}
	switch t := v.(type) {
	case nil:
		return ""
	case bool:
		return strconv.FormatBool(t)
	case float64:
		// Avoid scientific notation / trailing .0 for integers.
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		// object or array: keep the compact JSON form
		return string(raw)
	}
}
