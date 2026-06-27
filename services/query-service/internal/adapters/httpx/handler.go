package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
	"github.com/gin-gonic/gin"
)

// Streamer is the port the SSE handler depends on — the app core. Keeping it an
// interface lets handler tests drive the real core over a recording TailBus (so
// "no subscribe on bad credential" is provable) without standing up Redis.
//
// The interface exposes Subscribe and StreamEvents as separate steps (issue
// #39-M4): the handler calls Subscribe BEFORE writing 200/SSE headers so a
// subscribe error (e.g. Redis down) returns a JSON 5xx instead of a silent
// empty-body 200. Stream is retained as the combined convenience method.
type Streamer interface {
	// Subscribe opens the tenant's tail channel and returns the event stream.
	// Calling this before writing response headers lets the handler return a
	// JSON 5xx instead of a silent empty 200 when the TailBus is unavailable.
	Subscribe(tc kernel.TenantContext, ctx context.Context) (<-chan kernel.LogEvent, error)
	// StreamEvents runs the fan-out loop over an already-opened events channel.
	StreamEvents(events <-chan kernel.LogEvent, ctx context.Context, f app.Filter, sink app.Sink) error
}

// compile-time proof the app service satisfies the handler's port.
var _ Streamer = (*app.Streamer)(nil)

// Handler holds the dependencies for the query-service HTTP endpoints: live tail
// (the wave-1 slice), hot search (#10), and panel-data (#18), each over its own
// app-core port.
type Handler struct {
	stream Streamer
	search Searcher
	panel  Paneler
	ready  func(context.Context) error
	log    *slog.Logger
}

// NewHandler builds the query handler. search and panel may be nil for focused
// tests that only exercise tail; ready may be nil (then /readyz always reports
// ready, in production it pings Redis).
func NewHandler(stream Streamer, search Searcher, panel Paneler, ready func(context.Context) error, log *slog.Logger) *Handler {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Handler{stream: stream, search: search, panel: panel, ready: ready, log: log}
}

// Tail handles GET /v1/tail. It requires `Accept: text/event-stream`, derives the
// subscription channel from the authenticated TenantContext (never from a query
// param), and streams matching events as SSE until the client disconnects.
//
// Subscribe is called BEFORE the 200/SSE headers are written (issue #39-M4) so a
// TailBus failure (e.g. Redis down at subscribe time) can be returned as a JSON
// 503 instead of a silent empty-body 200.
func (h *Handler) Tail(c *gin.Context) {
	tc, ok := tenantFromGin(c)
	if !ok {
		// Defensive: AuthMiddleware guarantees a tenant, but fail closed anyway.
		abortUnauthorized(c)
		return
	}
	if !acceptsEventStream(c.Request.Header.Get("Accept")) {
		c.JSON(http.StatusNotAcceptable, errorBody("not_acceptable", "GET /v1/tail requires Accept: text/event-stream"))
		return
	}
	filter, err := parseFilter(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, errorBody("invalid_request", err.Error()))
		return
	}

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		// No streaming support behind this server — should never happen with Gin.
		c.JSON(http.StatusInternalServerError, errorBody("internal", "streaming unsupported"))
		return
	}

	// Pre-subscribe BEFORE writing 200 headers so a TailBus failure returns a
	// JSON 5xx rather than a silent empty-body 200 (issue #39-M4). The channel
	// derives from tc inside the TailBus adapter — never from caller input.
	events, err := h.stream.Subscribe(tc, c.Request.Context())
	if err != nil {
		h.log.ErrorContext(c.Request.Context(), "tail subscribe failed",
			"tenant_id", string(tc.TenantID), "err", err)
		c.JSON(http.StatusServiceUnavailable, errorBody("tail_unavailable", "could not subscribe to tail stream"))
		return
	}

	// SSE headers, then flush so the client's EventSource opens immediately.
	hdr := c.Writer.Header()
	hdr.Set("Content-Type", "text/event-stream")
	hdr.Set("Cache-Control", "no-cache")
	hdr.Set("Connection", "keep-alive")
	hdr.Set("X-Accel-Buffering", "no") // disable proxy buffering (nginx) for live frames
	c.Writer.WriteHeader(http.StatusOK)
	flusher.Flush()

	sink := &sseSink{w: c.Writer, flush: flusher.Flush}

	// ctx is cancelled on client disconnect; StreamEvents tears down when it returns.
	if err := h.stream.StreamEvents(events, c.Request.Context(), filter, sink); err != nil {
		h.log.WarnContext(c.Request.Context(), "tail stream ended with error",
			"tenant_id", string(tc.TenantID), "err", err)
	}
}

// Healthz is liveness: the process is up. It does not touch dependencies.
func (h *Handler) Healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// Readyz is readiness: dependencies (Redis) are reachable.
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

// acceptsEventStream reports whether the Accept header permits SSE. A missing or
// wildcard Accept is permitted (EventSource sends text/event-stream, but curl and
// proxies may send */* ).
func acceptsEventStream(accept string) bool {
	if accept == "" {
		return false
	}
	for _, part := range strings.Split(accept, ",") {
		mt := strings.TrimSpace(part)
		if i := strings.IndexByte(mt, ';'); i >= 0 {
			mt = strings.TrimSpace(mt[:i])
		}
		switch mt {
		case "text/event-stream", "text/*", "*/*":
			return true
		}
	}
	return false
}

// parseFilter reads the optional ?level= and ?service= query params into an
// app.Filter. An unknown level is a 400 (kernel.Level validates the value).
func parseFilter(c *gin.Context) (app.Filter, error) {
	var f app.Filter
	if lvl := strings.TrimSpace(c.Query("level")); lvl != "" {
		var level kernel.Level
		if err := level.UnmarshalJSON([]byte(`"` + lvl + `"`)); err != nil {
			return app.Filter{}, fmt.Errorf("invalid level %q", lvl)
		}
		f.Level = &level
	}
	f.Service = strings.TrimSpace(c.Query("service"))
	return f, nil
}

// sseSink renders app stream frames as Server-Sent Events and flushes each so the
// browser receives them immediately. It is the transport half of app.Sink.
type sseSink struct {
	w     io.Writer
	flush func()
}

// compile-time proof sseSink satisfies the core's transport port.
var _ app.Sink = (*sseSink)(nil)

func (s *sseSink) Data(ev kernel.LogEvent) error {
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "data: %s\n\n", b); err != nil {
		return err
	}
	s.flush()
	return nil
}

func (s *sseSink) Gap(n int) error {
	if _, err := fmt.Fprintf(s.w, "event: gap\ndata: {\"dropped\":%d}\n\n", n); err != nil {
		return err
	}
	s.flush()
	return nil
}

func (s *sseSink) Heartbeat() error {
	if _, err := io.WriteString(s.w, ": keepalive\n\n"); err != nil {
		return err
	}
	s.flush()
	return nil
}
