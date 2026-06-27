// Package app is the processor application core (hexagonal centre). It owns the
// one pipeline rule of the Log Processing context: consume an Envelope, normalize
// it to a LogEvent, persist it under the tenant's RLS context, then fan it out to
// the live-tail bus (overview.md §5.2, ADR-0006). It depends only on the
// kernel.LogStore and kernel.TailBus ports, so Postgres/Redis/RabbitMQ are
// swappable adapters around it.
//
// Tenancy is load-bearing: the TenantContext is the one rebuilt by the broker
// from the envelope's authoritative tenant_id, and it is the sole source of the
// persisted tenant_id and the tail channel — never the event body (ADR-0002).
package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// Service is the processor application service.
type Service struct {
	store kernel.LogStore
	tail  kernel.TailBus
	now   func() time.Time
	log   *slog.Logger

	maxRetries int                                  // bounded persist retries before dead-lettering
	retryDelay time.Duration                        // base backoff between persist attempts
	sleep      func(context.Context, time.Duration) // injectable for fast tests
}

// Option configures a Service.
type Option func(*Service)

// WithClock injects a clock (deterministic ts defaulting in tests).
func WithClock(now func() time.Time) Option { return func(s *Service) { s.now = now } }

// WithLogger sets the structured logger (defaults to discard).
func WithLogger(l *slog.Logger) Option { return func(s *Service) { s.log = l } }

// WithRetry bounds transient persist retries and the base backoff between them.
// A non-positive maxRetries means "no retries" (one attempt). Poison messages are
// never retried regardless.
func WithRetry(maxRetries int, base time.Duration) Option {
	return func(s *Service) { s.maxRetries = maxRetries; s.retryDelay = base }
}

// withSleeper overrides the backoff sleeper (test seam).
func withSleeper(f func(context.Context, time.Duration)) Option {
	return func(s *Service) { s.sleep = f }
}

// New builds the processor Service over the LogStore + TailBus ports.
func New(store kernel.LogStore, tail kernel.TailBus, opts ...Option) *Service {
	s := &Service{
		store:      store,
		tail:       tail,
		now:        time.Now,
		log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		maxRetries: 3,
		retryDelay: 200 * time.Millisecond,
		sleep:      sleepCtx,
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
	if s.sleep == nil {
		s.sleep = sleepCtx
	}
	return s
}

// Handle is the kernel.EnvelopeHandler the broker invokes per delivery. Its
// contract drives the broker's ack/nack:
//
//   - nil error  -> broker ACKs the message (success).
//   - non-nil    -> broker NACKs without requeue -> the message dead-letters to
//     the DLX/DLQ (the broker topology, #6).
//
// Retry/DLQ policy:
//   - A POISON payload (cannot be normalized at all) returns immediately so it is
//     dead-lettered without retry — retrying it would never succeed (#7).
//   - A PERSIST failure is retried up to maxRetries with backoff (transient DB
//     blips recover and the message is eventually acked). If the budget is
//     exhausted the error is returned, so the message dead-letters as a poison
//     persist (operator-inspectable in the DLQ) rather than looping forever.
//   - The tail PUBLISH happens AFTER a durable persist and is best-effort
//     (ADR-0006): a publish failure is logged but does NOT fail the message,
//     because the row is already committed and re-delivery would double-insert.
func (s *Service) Handle(tc kernel.TenantContext, ctx context.Context, env kernel.Envelope) error {
	ev, err := Normalize(tc, env, s.now)
	if err != nil {
		// Poison: do not retry. Returning the error dead-letters the message.
		s.log.WarnContext(ctx, "processor: poison message -> dlq",
			"tenant_id", tc.TenantID, "err", err)
		return err
	}

	if err := s.persist(tc, ctx, ev); err != nil {
		s.log.ErrorContext(ctx, "processor: persist failed after retries -> dlq",
			"tenant_id", tc.TenantID, "service", ev.Service, "err", err)
		return err
	}

	// Best-effort fan-out. The durable work (persist) is done; never fail the
	// message on a tail hiccup (would re-deliver and duplicate the row).
	if err := s.tail.Publish(tc, ctx, ev); err != nil {
		s.log.WarnContext(ctx, "processor: tail publish failed (event persisted, fan-out dropped)",
			"tenant_id", tc.TenantID, "err", err)
	}
	return nil
}

// persist appends the event with a bounded retry on transient failure, honoring
// context cancellation between attempts.
func (s *Service) persist(tc kernel.TenantContext, ctx context.Context, ev kernel.LogEvent) error {
	attempts := s.maxRetries + 1
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			s.log.WarnContext(ctx, "processor: retrying persist",
				"tenant_id", tc.TenantID, "attempt", attempt, "err", lastErr)
			s.sleep(ctx, s.retryDelay*time.Duration(attempt))
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.store.Append(tc, ctx, ev); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

// sleepCtx sleeps for d unless ctx is cancelled first.
func sleepCtx(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// IsPoison reports whether err is the poison sentinel (exposed for callers/tests).
func IsPoison(err error) bool { return errors.Is(err, ErrPoison) }
