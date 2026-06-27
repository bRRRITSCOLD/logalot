package kernel

import (
	"encoding/json"
	"time"
)

// LogEvent is the normalized log record — the shared-kernel published language
// between the processor (writer) and query-service (reader). Its fields mirror
// the hot-store `log_events` columns (docs/data/model.md §5.1); the generated
// `search` tsvector is a storage concern and is intentionally absent here.
//
// JSON tags are stable: this is the exact shape published on the tail bus
// (`tail:{tenant_id}`) and persisted in `raw`, so it must (de)serialize
// round-trip-identically.
type LogEvent struct {
	// TenantID is bound from TenantContext, never from the event body (ADR-0002).
	TenantID TenantID `json:"tenant_id"`
	// TS is the event time and the table's partition key.
	TS time.Time `json:"ts"`
	// ID is the row id (DB-generated when empty); the keyset cursor tiebreak.
	ID string `json:"id,omitempty"`
	// Service is the emitting service name (folded into the FTS vector).
	Service string `json:"service"`
	// Level is the severity (Postgres log_level enum).
	Level Level `json:"level"`
	// Message is the primary full-text-searched text.
	Message string `json:"message"`
	// Labels are structured fields persisted to the `labels` jsonb column and
	// searched via GIN jsonb_path_ops `@>` containment (model.md §5.1).
	//
	// CONTRACT — DECISION: labels are string→string. The jsonb column can
	// physically hold nested/non-string values, but the kernel deliberately
	// narrows the published language to map[string]string because (a) our label
	// search model is flat `key=value` containment, which keeps `@>` queries
	// simple and the GIN index small, and (b) a single scalar value type removes
	// per-value type ambiguity from the wire contract. The PROCESSOR is
	// responsible for normalizing any non-string label value (numbers, bools,
	// nested objects) to its string form BEFORE persistence; richer structure
	// belongs in Raw, not Labels.
	Labels map[string]string `json:"labels"`
	// TraceID / SpanID are optional trace correlation ids.
	TraceID string `json:"trace_id,omitempty"`
	SpanID  string `json:"span_id,omitempty"`
	// Raw is the original normalized envelope retained for fidelity/replay.
	Raw json.RawMessage `json:"raw,omitempty"`
}
