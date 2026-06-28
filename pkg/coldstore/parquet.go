package coldstore

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	parquetgo "github.com/parquet-go/parquet-go"
)

// coldLogRecord mirrors the cold-tier.md §2 Parquet schema.
//
// TS is stored as Unix epoch milliseconds (int64), surfaced as Glue/Athena
// `bigint` (cold-tier.md §2/§3, reconciled 2026-06-27) — NOT a SQL timestamp —
// so Athena compares without conversion (render with from_unixtime(ts/1000)).
// Labels and Raw are stored as JSON strings (not Parquet structs) so a fluid
// label schema does not force Parquet schema evolution per tenant; Athena's
// json_extract_scalar handles predicates.
//
// This type is intentionally identical in structure to the spike's
// coldLogRecord (tests/cold-tier-spike/athena_projection_spike_test.go) to
// preserve schema continuity; both reference the same cold-tier.md §2 layout.
type coldLogRecord struct {
	TenantID string `parquet:"tenant_id,snappy"`
	TS       int64  `parquet:"ts,snappy"` // Unix millis UTC
	ID       string `parquet:"id,snappy"`
	Service  string `parquet:"service,snappy"`
	Level    string `parquet:"level,snappy"`
	Message  string `parquet:"message,snappy"`
	Labels   string `parquet:"labels,snappy"` // JSON-encoded
	TraceID  string `parquet:"trace_id,snappy"`
	SpanID   string `parquet:"span_id,snappy"`
	Raw      string `parquet:"raw,snappy"` // JSON-encoded
}

// encodeParquet encodes events as a Parquet buffer. The tenant_id column is
// stamped from tc.TenantID (authoritative), NOT from ev.TenantID (untrusted
// event body). Zero TS defaults to now; zero labels/raw default to {}.
func encodeParquet(tc kernel.TenantContext, events []kernel.LogEvent) ([]byte, error) {
	rows := make([]coldLogRecord, 0, len(events))
	for _, ev := range events {
		ts := ev.TS
		if ts.IsZero() {
			ts = time.Now()
		}
		labels, err := marshalJSONString(ev.Labels)
		if err != nil {
			return nil, fmt.Errorf("coldstore: marshal labels: %w", err)
		}
		rawStr := "{}"
		if len(ev.Raw) > 0 {
			rawStr = string(ev.Raw)
		}
		rows = append(rows, coldLogRecord{
			TenantID: string(tc.TenantID), // authoritative tenant — never ev.TenantID
			TS:       ts.UTC().UnixMilli(),
			ID:       ev.ID,
			Service:  ev.Service,
			Level:    string(ev.Level),
			Message:  ev.Message,
			Labels:   labels,
			TraceID:  ev.TraceID,
			SpanID:   ev.SpanID,
			Raw:      rawStr,
		})
	}

	var buf bytes.Buffer
	w := parquetgo.NewGenericWriter[coldLogRecord](&buf)
	if _, err := w.Write(rows); err != nil {
		return nil, fmt.Errorf("coldstore: parquet write: %w", err)
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("coldstore: parquet close: %w", err)
	}
	return buf.Bytes(), nil
}

// marshalJSONString encodes m as a JSON string ({} when nil/empty). Used for
// labels and raw fields stored as JSON strings in Parquet (cold-tier.md §2).
func marshalJSONString(m map[string]string) (string, error) {
	if len(m) == 0 {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// coldKey returns the S3 object key for a Parquet batch.
// Format: logs/tenant_id=<uuid>/dt=<YYYY-MM-DD>/hour=<HH>/<batchID>.parquet
//
// cold-tier.md §1: tenant_id is the LEADING partition element — this is the
// structural cold-isolation boundary. Glue/Athena partition projection uses
// this Hive-style path layout.
func coldKey(tenantID, batchID string, t time.Time) string {
	return fmt.Sprintf("logs/tenant_id=%s/dt=%s/hour=%02d/%s.parquet",
		tenantID,
		t.UTC().Format("2006-01-02"),
		t.UTC().Hour(),
		batchID,
	)
}
