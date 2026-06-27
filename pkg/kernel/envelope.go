package kernel

import (
	"encoding/json"
	"time"
)

// Envelope is the asynchronous pipeline contract between ingest-service
// (supplier) and processor (customer) across the broker (overview.md §2, §5.1;
// ADR-0004). It is the published language of that relationship and must
// (de)serialize stably across the queue.
//
// The tenant_id is resolved from the authenticated API key at ingest, never from
// the request body (ADR-0002, ADR-0007). Raw is the untrusted original payload,
// normalized into a LogEvent only later by the processor.
type Envelope struct {
	// TenantID is authoritative, set from the ingest credential.
	TenantID TenantID `json:"tenant_id"`
	// ReceivedAt is the ingest-side receipt time.
	ReceivedAt time.Time `json:"received_at"`
	// Raw is the original event payload as received.
	Raw json.RawMessage `json:"raw"`
}

// Valid fails closed when the envelope carries no usable tenant scope.
func (e Envelope) Valid() error {
	return TenantContext{TenantID: e.TenantID}.Valid()
}
