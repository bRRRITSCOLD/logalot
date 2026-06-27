package httpx

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/app"
	"github.com/gin-gonic/gin"
)

// Body/line size guards. The pipeline is the throughput-critical hot path; bound
// memory per request so a single client cannot exhaust it.
const (
	maxBodyBytes = 8 << 20 // 8 MiB total request body
	maxLineBytes = 1 << 20 // 1 MiB per NDJSON line
)

// errUnsupportedMediaType distinguishes a 415 from a 400 (malformed body).
var errUnsupportedMediaType = errors.New("unsupported media type")

// Ingester is the port the HTTP handler depends on — the app core. Keeping it an
// interface here lets handler tests drive a fake without the broker.
type Ingester interface {
	Ingest(tc kernel.TenantContext, ctx context.Context, raws []json.RawMessage) (int, error)
}

// compile-time proof the app service satisfies the handler's port.
var _ Ingester = (*app.Service)(nil)

// Handler holds the dependencies for the ingest HTTP endpoints.
type Handler struct {
	ingest Ingester
	ready  func(context.Context) error
	log    *slog.Logger
}

// NewHandler builds the ingest handler. ready may be nil (then /readyz always
// reports ready); in production it pings the broker and dependencies.
func NewHandler(ingest Ingester, ready func(context.Context) error, log *slog.Logger) *Handler {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Handler{ingest: ingest, ready: ready, log: log}
}

// ingestEvent is the adapter-boundary validation schema (the zod-equivalent). It
// deliberately omits tenant_id: ingest NEVER reads the tenant from the body
// (ADR-0002). Unknown fields are tolerated — the raw payload is opaque and
// normalized later by the processor — but the fields we DO model are validated.
type ingestEvent struct {
	Message string       `json:"message"`
	Level   kernel.Level `json:"level,omitempty"`
	Service string       `json:"service,omitempty"`
	TS      *time.Time   `json:"ts,omitempty"`
}

// validateRaw enforces the minimal ingest contract on one event payload. It does
// NOT alter the bytes — the original raw is what gets enqueued for fidelity.
func validateRaw(raw []byte) error {
	var ev ingestEvent
	// kernel.Level.UnmarshalJSON rejects an unknown/empty level, so an invalid
	// level surfaces as a malformed-body error here.
	if err := json.Unmarshal(raw, &ev); err != nil {
		return fmt.Errorf("malformed event json: %w", err)
	}
	if strings.TrimSpace(ev.Message) == "" {
		return errors.New("event.message is required")
	}
	return nil
}

// Ingest handles POST /v1/ingest for both a single JSON event
// (Content-Type: application/json) and NDJSON bulk
// (Content-Type: application/x-ndjson).
func (h *Handler) Ingest(c *gin.Context) {
	tc, ok := tenantFromGin(c)
	if !ok {
		// Defensive: AuthMiddleware guarantees a tenant, but fail closed anyway.
		abortUnauthorized(c)
		return
	}

	raws, err := parseBody(c.Request)
	if err != nil {
		if errors.Is(err, errUnsupportedMediaType) {
			c.JSON(http.StatusUnsupportedMediaType, errorBody("unsupported_media_type", err.Error()))
			return
		}
		c.JSON(http.StatusBadRequest, errorBody("invalid_request", err.Error()))
		return
	}

	published, err := h.ingest.Ingest(tc, c.Request.Context(), raws)
	if err != nil {
		// Broker unavailable / confirm timeout / nack. NEVER a false 202.
		h.log.ErrorContext(c.Request.Context(), "ingest enqueue failed",
			"tenant_id", string(tc.TenantID), "published", published, "err", err)
		// Surface the confirmed count in the error body so callers can implement
		// at-least-once: the confirmed events are durably enqueued; only the
		// remaining (total - confirmed) need retrying (issue #35-M2).
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":     gin.H{"code": "ingest_unavailable", "message": "could not durably enqueue events"},
			"confirmed": published,
		})
		return
	}

	// 202 is returned ONLY after every envelope was publisher-confirmed (durable
	// enqueue) by the broker (overview.md §5.1).
	c.JSON(http.StatusAccepted, gin.H{"accepted": published})
}

// Healthz is liveness: the process is up. It does not touch dependencies.
func (h *Handler) Healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// Readyz is readiness: dependencies (broker + datastores) are reachable.
func (h *Handler) Readyz(c *gin.Context) {
	if h.ready != nil {
		if err := h.ready(c.Request.Context()); err != nil {
			h.log.WarnContext(c.Request.Context(), "readiness check failed", "err", err)
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unavailable"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"status": "ready"})
}

// parseBody negotiates on Content-Type and returns the validated raw payloads.
// Original bytes are preserved per event so the enqueued Raw is byte-faithful.
func parseBody(r *http.Request) ([]json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if int64(len(body)) > maxBodyBytes {
		return nil, fmt.Errorf("request body exceeds %d bytes", maxBodyBytes)
	}

	switch contentTypeBase(r.Header.Get("Content-Type")) {
	case "application/x-ndjson", "application/ndjson", "application/jsonl":
		return parseNDJSON(body)
	case "application/json", "":
		return parseSingle(body)
	default:
		return nil, fmt.Errorf("%w: use application/json or application/x-ndjson", errUnsupportedMediaType)
	}
}

func parseSingle(body []byte) ([]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, errors.New("empty request body")
	}
	if err := validateRaw(trimmed); err != nil {
		return nil, err
	}
	return []json.RawMessage{cloneBytes(trimmed)}, nil
}

func parseNDJSON(body []byte) ([]json.RawMessage, error) {
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)

	var raws []json.RawMessage
	line := 0
	for sc.Scan() {
		line++
		b := bytes.TrimSpace(sc.Bytes())
		if len(b) == 0 {
			continue // tolerate blank separator lines
		}
		if err := validateRaw(b); err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		raws = append(raws, cloneBytes(b))
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read ndjson: %w", err)
	}
	if len(raws) == 0 {
		return nil, errors.New("no events in ndjson body")
	}
	return raws, nil
}

// contentTypeBase strips parameters (e.g. "; charset=utf-8") and lowercases.
func contentTypeBase(ct string) string {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.ToLower(strings.TrimSpace(ct))
}

// cloneBytes copies a scanner/slice view into an independent backing array so the
// retained RawMessage does not alias a reused buffer.
func cloneBytes(b []byte) json.RawMessage {
	out := make([]byte, len(b))
	copy(out, b)
	return out
}
