// Package app is the query-service application core (hexagonal centre). For the
// wave-1 slice it owns live-tail streaming: subscribe to the tenant's tail
// channel via the kernel.TailBus port, apply optional server-side filters, and
// fan matching events to a transport-agnostic Sink with a periodic heartbeat and
// bounded, drop-on-overflow backpressure (ADR-0006, overview.md §5.3).
//
// The core depends ONLY on the kernel.TailBus port, so the SSE transport (Gin)
// and the Redis pub/sub adapter are swappable around it. Tenancy is never read
// from user input: the channel is derived from the TenantContext inside the
// TailBus adapter (kernel.TailChannel), and Stream simply forwards the verified
// tc — a connection physically cannot subscribe to another tenant's stream.
//
// NOTE (#10): search will land beside this as a second app service over the
// kernel.LogStore port; the package is structured so adding it is additive.
package app

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// DefaultBuffer is the per-connection bounded buffer depth. It bounds how many
// events may queue for one slow SSE consumer before we start dropping; small
// enough that a stalled browser never holds significant memory, large enough to
// ride out a brief render hiccup.
const DefaultBuffer = 256

// DefaultHeartbeat is the SSE keep-alive interval (ADR-0006: 15s) — frequent
// enough to keep idle intermediaries from closing the connection.
const DefaultHeartbeat = 15 * time.Second

// Filter is the optional, server-side per-subscription filter applied to each
// event BEFORE it is emitted (ADR-0006). A zero Filter matches everything. Kept
// deliberately small (level + service) for the slice; richer predicates can be
// added without touching the streaming loop.
type Filter struct {
	// Level, when non-nil, keeps only events of exactly this severity.
	Level *kernel.Level
	// Service, when non-empty, keeps only events from this emitting service.
	Service string
}

// Match reports whether ev passes the filter.
func (f Filter) Match(ev kernel.LogEvent) bool {
	if f.Level != nil && ev.Level != *f.Level {
		return false
	}
	if f.Service != "" && ev.Service != f.Service {
		return false
	}
	return true
}

// Sink is the transport-facing port the core writes frames to. The httpx adapter
// implements it as SSE; tests implement it as a recorder. Keeping it here (not in
// httpx) lets the core stay transport-agnostic while still owning frame ordering.
//
// A non-nil error from any method ends the stream (e.g. the client hung up); the
// core treats it as a clean teardown.
type Sink interface {
	// Data emits one matched event.
	Data(ev kernel.LogEvent) error
	// Gap signals that n events were dropped for this slow consumer.
	Gap(n int) error
	// Heartbeat emits a keep-alive.
	Heartbeat() error
}

// tickerFunc builds a tick channel plus a stop func. It is injectable so tests
// drive heartbeats deterministically instead of waiting on wall-clock time.
type tickerFunc func(d time.Duration) (<-chan time.Time, func())

func realTicker(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

// Streamer is the live-tail application service.
type Streamer struct {
	bus       kernel.TailBus
	buffer    int
	heartbeat time.Duration
	newTicker tickerFunc
	log       *slog.Logger
}

// Option configures a Streamer.
type Option func(*Streamer)

// WithBuffer overrides the per-connection bounded buffer depth.
func WithBuffer(n int) Option { return func(s *Streamer) { s.buffer = n } }

// WithHeartbeat overrides the keep-alive interval.
func WithHeartbeat(d time.Duration) Option { return func(s *Streamer) { s.heartbeat = d } }

// WithTicker injects a ticker constructor for deterministic heartbeat tests.
func WithTicker(f tickerFunc) Option { return func(s *Streamer) { s.newTicker = f } }

// WithLogger sets the structured logger (defaults to a discard logger).
func WithLogger(l *slog.Logger) Option { return func(s *Streamer) { s.log = l } }

// New builds a Streamer over a TailBus.
func New(bus kernel.TailBus, opts ...Option) *Streamer {
	s := &Streamer{
		bus:       bus,
		buffer:    DefaultBuffer,
		heartbeat: DefaultHeartbeat,
		newTicker: realTicker,
		log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, o := range opts {
		o(s)
	}
	if s.buffer <= 0 {
		s.buffer = DefaultBuffer
	}
	if s.heartbeat <= 0 {
		s.heartbeat = DefaultHeartbeat
	}
	if s.newTicker == nil {
		s.newTicker = realTicker
	}
	if s.log == nil {
		s.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return s
}

// Subscribe opens the tenant's tail channel and returns the event stream. It is
// exposed separately from StreamEvents so the transport handler can call Subscribe
// BEFORE writing SSE response headers: a Subscribe error then maps to a JSON 5xx
// instead of a silent empty 200 (issue #39-M4). The channel derives from tc inside
// the TailBus adapter (kernel.TailChannel) — never from caller input.
func (s *Streamer) Subscribe(tc kernel.TenantContext, ctx context.Context) (<-chan kernel.LogEvent, error) {
	return s.bus.Subscribe(tc, ctx)
}

// StreamEvents runs the fan-out loop over an already-opened events channel,
// writing filtered events and heartbeats to sink until ctx is cancelled (client
// disconnect / shutdown) or the upstream channel closes. It is the second phase
// of the two-step Subscribe → StreamEvents flow used by the Tail HTTP handler.
//
// Backpressure: a pump goroutine drains the bus into a bounded buffer with a
// NON-blocking send; on overflow the event is dropped and counted, so a slow
// consumer can never block the Redis subscriber or back up the publisher (the
// processor). The drop count surfaces to the client as a `Gap` before the next
// emission, so a tail is best-effort-lossy by design, never stalling.
func (s *Streamer) StreamEvents(events <-chan kernel.LogEvent, ctx context.Context, f Filter, sink Sink) error {
	buf := make(chan kernel.LogEvent, s.buffer)
	var dropped atomic.Int64
	upstreamClosed := make(chan struct{})

	// Pump: bus -> bounded buffer, filtering and dropping on overflow. It owns no
	// transport; it only ever does a non-blocking send so the publisher is never
	// throttled by one slow browser.
	go func() {
		defer close(upstreamClosed)
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-events:
				if !ok {
					return // upstream subscription ended (e.g. Redis dropped)
				}
				if !f.Match(ev) {
					continue
				}
				select {
				case buf <- ev:
				default:
					dropped.Add(1) // slow consumer: drop, do NOT block the bus
				}
			}
		}
	}()

	tick, stop := s.newTicker(s.heartbeat)
	defer stop()

	// Recover the tenant for log context. The ctx was enriched by AuthMiddleware
	// via kernel.WithTenant, so FromContext succeeds when invoked from the handler.
	tenantID := ""
	if tc, ok := kernel.FromContext(ctx); ok {
		tenantID = string(tc.TenantID)
	}

	for {
		// Surface any drops accumulated since the last emission as a single Gap,
		// in order, before the next data frame.
		if d := dropped.Swap(0); d > 0 {
			s.log.WarnContext(ctx, "tail slow consumer; dropped events", "dropped", d, "tenant_id", tenantID)
			if err := sink.Gap(int(d)); err != nil {
				return nil // client hung up
			}
		}
		select {
		case <-ctx.Done():
			return nil // clean teardown: tailbus unsubscribes on ctx cancel
		case <-upstreamClosed:
			return nil // upstream ended; let EventSource reconnect
		case ev := <-buf:
			if err := sink.Data(ev); err != nil {
				return nil // client hung up
			}
		case <-tick:
			if err := sink.Heartbeat(); err != nil {
				return nil // client hung up
			}
		}
	}
}

// Stream subscribes to the tenant's tail channel and writes matching events to
// sink until ctx is cancelled (client disconnect / shutdown) or the upstream
// subscription ends. It is the combined Subscribe+StreamEvents convenience method
// used when pre-flight header separation is not required.
//
// The channel is derived from tc inside the TailBus adapter, so the subscription
// target can never be caller-controlled (load-bearing tenant isolation, ADR-0002 /
// overview.md §5.3).
func (s *Streamer) Stream(tc kernel.TenantContext, ctx context.Context, f Filter, sink Sink) error {
	events, err := s.Subscribe(tc, ctx)
	if err != nil {
		return err
	}
	return s.StreamEvents(events, ctx, f, sink)
}
