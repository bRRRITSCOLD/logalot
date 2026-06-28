// Package app is the processor application core (hexagonal centre). It owns the
// one pipeline rule of the Log Processing context: consume an Envelope, normalize
// it to a LogEvent, persist it under the tenant's RLS context, then fan it out to
// the live-tail bus (overview.md §5.2, ADR-0006). It depends only on the
// kernel.LogStore, kernel.TailBus, and (optionally) kernel.ColdArchive ports,
// so Postgres/Redis/RabbitMQ/S3 are swappable adapters around it.
//
// Tenancy is load-bearing: the TenantContext is the one rebuilt by the broker
// from the envelope's authoritative tenant_id, and it is the sole source of the
// persisted tenant_id and the tail channel — never the event body (ADR-0002).
//
// Cold-tier tee (ADR-0005, cold-tier.md §5.1): after every successful hot
// persist, Archive is called with the event as a best-effort side-effect.
// Archive failure is logged but does NOT fail the message ACK — the hot row is
// already committed and re-delivery would duplicate the hot insert.
//
// Graceful-shutdown drain (issue #37): persist uses context.WithoutCancel so a
// SIGTERM that cancels the lifecycle context does not abort an in-flight DB write.
// Without this, the single in-flight message would hit ctx.Err() inside persist,
// return context.Canceled, and be nacked to the DLQ — misclassifying a clean
// shutdown as a poison message.
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
	cold  kernel.ColdArchive // optional; nil = cold tee disabled (feature flag off)
	now   func() time.Time
	log   *slog.Logger

	maxRetries   int                                  // bounded persist retries before dead-lettering
	retryDelay   time.Duration                        // base backoff between persist attempts
	drainTimeout time.Duration                        // upper bound on an in-flight drain persist
	sleep        func(context.Context, time.Duration) // injectable for fast tests
}

// DefaultDrainTimeout bounds the in-flight persist that runs on a drain after
// the lifecycle context is cancelled (issue #37). It must be comfortably less
// than the deployment's terminationGracePeriodSeconds so the drain completes
// before the orchestrator escalates to SIGKILL.
const DefaultDrainTimeout = 8 * time.Second

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

// WithDrainTimeout bounds the in-flight persist that runs on a shutdown drain
// (issue #37). The drain persist runs on a context derived from
// context.WithoutCancel so a SIGTERM does not abort it — but it MUST still be
// bounded so a stuck DB cannot hang shutdown forever (and force a SIGKILL, which
// would defeat the drain). A non-positive d leaves the default in place.
func WithDrainTimeout(d time.Duration) Option {
	return func(s *Service) {
		if d > 0 {
			s.drainTimeout = d
		}
	}
}

// WithColdArchive wires the optional cold-tier tee (ADR-0005, cold-tier.md
// §5.1). When set, every successful hot persist is also tee'd to the cold
// archive as a best-effort side-effect (failure is logged, not propagated —
// the hot ACK is never blocked by a cold failure). When nil or not called,
// the cold tee is silently skipped (feature-flag default-off per decision 016).
func WithColdArchive(cold kernel.ColdArchive) Option {
	return func(s *Service) { s.cold = cold }
}

// withSleeper overrides the backoff sleeper (test seam).
func withSleeper(f func(context.Context, time.Duration)) Option {
	return func(s *Service) { s.sleep = f }
}

// New builds the processor Service over the LogStore + TailBus ports.
func New(store kernel.LogStore, tail kernel.TailBus, opts ...Option) *Service {
	s := &Service{
		store:        store,
		tail:         tail,
		now:          time.Now,
		log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		maxRetries:   3,
		retryDelay:   200 * time.Millisecond,
		drainTimeout: DefaultDrainTimeout,
		sleep:        sleepCtx,
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
	if s.drainTimeout <= 0 {
		s.drainTimeout = DefaultDrainTimeout
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

	// Best-effort cold tee (day-0 archive, cold-tier.md §5.1 / ADR-0005).
	// The hot row is already committed; a cold failure must never block the ACK
	// or trigger re-delivery (that would duplicate the hot insert). We log the
	// failure and move on. The cold port is nil when the feature flag is off.
	//
	// Shutdown-drain budget (M2): persist and the cold tee each run on a
	// WithoutCancel context bounded by drainTimeout. Running them sequentially
	// on a drain could approach 2×drainTimeout and risk exceeding ShutdownGrace.
	// Because the cold tee is best-effort and the hot row is already durable, we
	// SKIP it once the lifecycle context is already cancelled — shutdown then
	// stays bounded by a single drainTimeout (the persist drain). In steady
	// state ctx is live and the tee runs normally.
	if s.cold != nil {
		if err := ctx.Err(); err != nil {
			s.log.WarnContext(ctx, "processor: cold archive skipped (shutting down; hot committed)",
				"tenant_id", tc.TenantID, "service", ev.Service)
		} else if err := s.archiveCold(tc, ctx, ev); err != nil {
			s.log.WarnContext(ctx, "processor: cold archive failed (hot committed; ack proceeds)",
				"tenant_id", tc.TenantID, "service", ev.Service, "err", err)
		}
	}

	// Best-effort fan-out. The durable work (persist) is done; never fail the
	// message on a tail hiccup (would re-deliver and duplicate the row).
	if err := s.tail.Publish(tc, ctx, ev); err != nil {
		s.log.WarnContext(ctx, "processor: tail publish failed (event persisted, fan-out dropped)",
			"tenant_id", tc.TenantID, "err", err)
	}
	return nil
}

// archiveCold tees the event to the cold archive with bounded retries. It uses
// a context derived from context.WithoutCancel (same drain logic as persist) so
// a shutdown signal does not abort an in-flight S3 write that is already on its
// first attempt. Archive failure after the retry budget is returned to the
// caller (Handle), which logs it as a warning and continues with ACK.
func (s *Service) archiveCold(tc kernel.TenantContext, ctx context.Context, ev kernel.LogEvent) error {
	archCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.drainTimeout)
	defer cancel()

	attempts := s.maxRetries + 1
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			if err := ctx.Err(); err != nil {
				return lastErr
			}
			s.log.WarnContext(ctx, "processor: retrying cold archive",
				"tenant_id", tc.TenantID, "attempt", attempt, "err", lastErr)
			s.sleep(ctx, s.retryDelay*time.Duration(attempt))
		}
		if err := s.cold.Archive(tc, archCtx, ev); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

// persist appends the event with a bounded retry on transient failure.
//
// Drain contract (issue #37): the store.Append call uses a drainCtx derived
// from context.WithoutCancel(ctx), so a lifecycle cancellation (SIGTERM) does
// NOT abort an in-flight DB write. This prevents a graceful-shutdown signal from
// being misclassified as a poison persist and routing the message to the DLQ.
//
// The drainCtx is bounded by s.drainTimeout (NOT unbounded): WithoutCancel strips
// the parent deadline, so a stuck DB would otherwise hang shutdown forever and
// force a SIGKILL — which would defeat the drain. The timeout caps the in-flight
// persist so shutdown always completes within terminationGracePeriodSeconds.
//
// ctx (the lifecycle context) is still used for the retry sleep so that a
// cancellation wakes up the sleep immediately, and ctx.Err() is checked between
// retry attempts to stop retrying once the process is shutting down. This means:
//   - Attempt 0 always runs to completion (bounded drain).
//   - Subsequent retry attempts are skipped after a shutdown signal.
func (s *Service) persist(tc kernel.TenantContext, ctx context.Context, ev kernel.LogEvent) error {
	// drainCtx inherits all values from ctx (trace IDs etc.) but not its
	// cancellation, so the DB write survives a lifecycle cancellation — yet it is
	// bounded by drainTimeout so a stuck DB cannot hang shutdown indefinitely.
	drainCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.drainTimeout)
	defer cancel()

	attempts := s.maxRetries + 1
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			// Between retries: stop if the lifecycle context was cancelled (shutdown).
			// ctx.Err() is intentionally checked only AFTER the first attempt so the
			// initial persist always runs — that is the drain guarantee.
			if err := ctx.Err(); err != nil {
				// Return the last actual persist error so the caller has a meaningful
				// error (not context.Canceled) if it decides to surface it.
				return lastErr
			}
			s.log.WarnContext(ctx, "processor: retrying persist",
				"tenant_id", tc.TenantID, "attempt", attempt, "err", lastErr)
			s.sleep(ctx, s.retryDelay*time.Duration(attempt))
		}
		if err := s.store.Append(tc, drainCtx, ev); err != nil {
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
