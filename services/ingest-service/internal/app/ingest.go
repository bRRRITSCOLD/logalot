// Package app is the ingest-service application core (hexagonal centre). It owns
// the one security-critical rule of ingest — every published envelope's tenant
// comes from the authenticated TenantContext, never from the request body
// (ADR-0002) — and depends only on the kernel.Broker port, so transport (Gin)
// and broker (RabbitMQ) are swappable adapters around it.
package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// DefaultPublishTimeout is the per-envelope publish deadline applied when no
// explicit timeout is configured. It bounds how long a stalled-but-open broker
// connection can block a request goroutine (issue #35-I1). A context.WithTimeout
// wrapping the request ctx means an expired deadline becomes a broker error that
// maps to the existing 503 path — no new error handling needed.
const DefaultPublishTimeout = 10 * time.Second

// Service is the ingest application service. It turns already-validated raw event
// payloads into durable envelopes and publishes them via the Broker port.
type Service struct {
	broker         kernel.Broker
	now            func() time.Time
	log            *slog.Logger
	publishTimeout time.Duration
}

// Option configures a Service.
type Option func(*Service)

// WithClock injects a clock for deterministic ReceivedAt in tests.
func WithClock(now func() time.Time) Option { return func(s *Service) { s.now = now } }

// WithLogger sets the structured logger (defaults to a discard logger).
func WithLogger(l *slog.Logger) Option { return func(s *Service) { s.log = l } }

// WithPublishTimeout overrides the per-publish context deadline (default
// DefaultPublishTimeout). Set to 0 to disable the timeout (not recommended in
// production — a stalled broker will then block indefinitely).
func WithPublishTimeout(d time.Duration) Option {
	return func(s *Service) { s.publishTimeout = d }
}

// New builds the ingest Service over a Broker.
func New(broker kernel.Broker, opts ...Option) *Service {
	s := &Service{
		broker:         broker,
		now:            time.Now,
		log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		publishTimeout: DefaultPublishTimeout,
	}
	for _, o := range opts {
		o(s)
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.log == nil {
		s.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	// publishTimeout=0 is an explicit opt-out; keep 0 as-is (no floor applied).
	return s
}

// Ingest publishes raws as durable envelopes under tc, returning the number
// durably enqueued (publisher-confirmed) before any error. The TenantID is taken
// from tc — the authenticated key — so a tenant_id embedded in a raw payload is
// structurally ignored (ADR-0002).
//
// Publishing is sequential and fails fast: a broker error aborts the batch and is
// returned so the transport can answer non-2xx (never a false 202). Because each
// envelope is individually confirmed, `published` reflects exactly how many are
// durably enqueued — the caller decides how to report a partial bulk failure.
//
// A per-publish context deadline (publishTimeout) is applied so a stalled-but-open
// broker connection cannot block the request goroutine indefinitely (issue #35-I1).
// When the deadline fires, the broker returns a context.DeadlineExceeded error
// which the transport maps to the existing 503 path.
func (s *Service) Ingest(tc kernel.TenantContext, ctx context.Context, raws []json.RawMessage) (published int, err error) {
	if err := tc.Valid(); err != nil {
		return 0, err
	}
	// Apply a bounded publish deadline if configured (default 10 s). The timeout
	// wraps the caller's ctx so cancellation from either direction is respected.
	if s.publishTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.publishTimeout)
		defer cancel()
	}
	receivedAt := s.now().UTC()
	for _, raw := range raws {
		env := kernel.Envelope{
			TenantID:   tc.TenantID, // authoritative: from the key, never the body
			ReceivedAt: receivedAt,
			Raw:        raw,
		}
		if perr := s.broker.Publish(tc, ctx, env); perr != nil {
			s.log.ErrorContext(ctx, "ingest publish failed", "published", published, "err", perr)
			return published, perr
		}
		published++
	}
	return published, nil
}
