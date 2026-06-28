package app

import (
	"context"
	"io"
	"log/slog"
	"time"
)

// DefaultHotDays is the global hot-partition retention horizon (cold-tier.md
// §5.2). Partitions are time-only (not per-tenant), so the drop is global.
// A per-tenant shorter hot window is enforced by the tenant's own cold_days,
// not by multiple partition drops.
const DefaultHotDays = 30

// DefaultInterval is the cadence between full retention cycles. Once per day
// is the right granularity: cold-tier.md §5.2 uses daily dt= partitions.
const DefaultInterval = 24 * time.Hour

// Retainer is the retention-worker application service. It holds one cycle:
//  1. Hot-tier partition drop (global, O(1)): calls
//     app.drop_log_events_partitions_older_than via HotDropper.
//  2. Cold-tier prefix delete (per-tenant): for every tenant in
//     retention_policies, deletes S3 prefixes whose dt is older than
//     the tenant's cold_days horizon.
//
// Tenancy: the cold delete derives the S3 prefix from the verified TenantID
// from retention_policies.tenant_id (a UUID from the DB) — never from caller
// input. The prefix is always logs/tenant_id=<uuid>/, so a bug in one
// tenant's cold_days cannot touch another tenant's objects.
type Retainer struct {
	policies PolicyStore
	hotDrop  HotDropper
	purger   ColdPurger

	enabled  bool          // master kill-switch (RETENTION_ENABLED); default false
	dryRun   bool          // log intended sweeps without performing them
	hotDays  int           // global hot-partition horizon (default 30)
	interval time.Duration // run cadence
	now      func() time.Time
	log      *slog.Logger
}

// Option configures a Retainer.
type Option func(*Retainer)

// WithEnabled sets the master kill-switch. Default is false (no-op cycles):
// a Retainer built without this option deletes NOTHING, so an accidental
// deploy is harmless. Pass true to arm destructive retention.
func WithEnabled(on bool) Option {
	return func(r *Retainer) { r.enabled = on }
}

// WithDryRun enables dry-run mode: cycles iterate and log the computed
// per-tenant cutoffs and the hot horizon but perform NO drops or deletes.
func WithDryRun(on bool) Option {
	return func(r *Retainer) { r.dryRun = on }
}

// WithHotDays overrides the global hot-partition retention horizon. Must be
// positive; zero is a no-op (keeps the default).
func WithHotDays(d int) Option {
	return func(r *Retainer) {
		if d > 0 {
			r.hotDays = d
		}
	}
}

// WithInterval sets the cycle cadence. Must be positive.
func WithInterval(d time.Duration) Option {
	return func(r *Retainer) {
		if d > 0 {
			r.interval = d
		}
	}
}

// WithClock injects a clock (test seam for deterministic date arithmetic).
func WithClock(now func() time.Time) Option {
	return func(r *Retainer) {
		if now != nil {
			r.now = now
		}
	}
}

// WithLogger sets the structured logger (defaults to discard).
func WithLogger(l *slog.Logger) Option {
	return func(r *Retainer) {
		if l != nil {
			r.log = l
		}
	}
}

// New builds a Retainer over its ports.
func New(policies PolicyStore, hotDrop HotDropper, purger ColdPurger, opts ...Option) *Retainer {
	r := &Retainer{
		policies: policies,
		hotDrop:  hotDrop,
		purger:   purger,
		hotDays:  DefaultHotDays,
		interval: DefaultInterval,
		now:      time.Now,
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, o := range opts {
		o(r)
	}
	return r
}

// Run drives the retention loop until ctx is cancelled. It runs one cycle
// immediately, then on every tick. A cycle error is logged but does not kill
// the loop — a transient DB or S3 blip must not stop future cycles.
func (r *Retainer) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		if err := r.RunCycle(ctx); err != nil {
			r.log.ErrorContext(ctx, "retention-worker: cycle failed",
				"err", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// RunCycle executes one retention sweep and returns any hard error. Per-tenant
// cold-purge failures are logged and counted but do NOT abort the sweep — one
// bad tenant must not stall the rest. The hot partition drop failure IS a hard
// error (it is global and idempotent to retry).
//
// Kill-switch: when the Retainer is not enabled (RETENTION_ENABLED!=true, the
// default), this is a pure logging no-op — NO partitions are dropped and NO S3
// objects are deleted. This mirrors COLD_SEARCH_ENABLED's opt-in posture so an
// accidental deploy of a destructive worker is harmless.
//
// Returns a non-nil error only when the cycle cannot proceed at all (e.g. the
// DB is unreachable for the policy list). Individual-tenant cold-purge errors
// are reported via metrics/logging only.
func (r *Retainer) RunCycle(ctx context.Context) error {
	// Master kill-switch — fail-safe OFF. No destructive call is reached.
	if !r.enabled {
		r.log.InfoContext(ctx, "retention-worker: disabled (RETENTION_ENABLED!=true) — skipping cycle, no drops or deletes")
		return nil
	}

	if r.dryRun {
		return r.runDryCycle(ctx)
	}

	start := r.now()

	// ── Step 1: hot partition drop (global, O(1)) ──────────────────────────
	dropped, err := r.hotDrop.DropOlderThan(ctx, r.hotDays)
	if err != nil {
		// Hot drop failure is logged as an error so alerting can fire on it.
		r.log.ErrorContext(ctx, "retention-worker: hot partition drop failed",
			"hot_days", r.hotDays, "err", err)
		// We continue to the cold sweep — it is independent.
	} else {
		r.log.InfoContext(ctx, "retention-worker: hot partition drop complete",
			"hot_days", r.hotDays, "dropped_partitions", dropped)
	}

	// ── Step 2: cold prefix delete (per-tenant) ────────────────────────────
	policies, err := r.policies.ListAll(ctx)
	if err != nil {
		r.log.ErrorContext(ctx, "retention-worker: list retention policies failed", "err", err)
		return err // hard error: can't iterate tenants
	}

	today := r.now().UTC().Truncate(24 * time.Hour)
	var coldErrors, coldTenants, totalDeleted int
	for _, p := range policies {
		cutoff := today.AddDate(0, 0, -p.ColdDays)
		n, perr := r.purger.PurgeExpiredPrefixes(ctx, p.TenantID, cutoff)
		if perr != nil {
			coldErrors++
			// Log at error level so alerting can fire on individual-tenant failures.
			r.log.ErrorContext(ctx, "retention-worker: cold purge failed for tenant",
				"tenant_id", p.TenantID,
				"cold_days", p.ColdDays,
				"cutoff_date", cutoff.Format("2006-01-02"),
				"err", perr)
			continue
		}
		coldTenants++
		totalDeleted += n
		if n > 0 {
			r.log.InfoContext(ctx, "retention-worker: cold purge complete for tenant",
				"tenant_id", p.TenantID,
				"cold_days", p.ColdDays,
				"cutoff_date", cutoff.Format("2006-01-02"),
				"deleted_objects", n)
		}
	}

	elapsed := r.now().Sub(start)
	r.log.InfoContext(ctx, "retention-worker: cycle complete",
		"hot_days", r.hotDays,
		"dropped_partitions", dropped,
		"cold_tenants_swept", coldTenants,
		"cold_tenants_errors", coldErrors,
		"cold_objects_deleted", totalDeleted,
		"elapsed_ms", elapsed.Milliseconds())

	return nil
}

// runDryCycle iterates policies and logs the hot horizon + each tenant's
// computed cold cutoff WITHOUT performing any drop or delete. It still reads
// retention_policies (a non-destructive SELECT) so an operator can rehearse the
// exact set of tenants and cutoffs that an armed cycle would act on.
//
// It deliberately does NOT report per-object counts: counting expired objects
// requires a list-only purger call, which would expand the ColdPurger port; a
// count-mode dry-run is left as a follow-up. The required guarantee here is
// that NO destructive operation runs.
func (r *Retainer) runDryCycle(ctx context.Context) error {
	r.log.InfoContext(ctx, "retention-worker: DRY RUN — no drops or deletes will be performed",
		"would_drop_partitions_older_than_days", r.hotDays)

	policies, err := r.policies.ListAll(ctx)
	if err != nil {
		r.log.ErrorContext(ctx, "retention-worker: dry-run list retention policies failed", "err", err)
		return err
	}
	today := r.now().UTC().Truncate(24 * time.Hour)
	for _, p := range policies {
		cutoff := today.AddDate(0, 0, -p.ColdDays)
		r.log.InfoContext(ctx, "retention-worker: dry-run would purge tenant cold prefixes",
			"tenant_id", p.TenantID,
			"cold_days", p.ColdDays,
			"cutoff_date", cutoff.Format("2006-01-02"))
	}
	return nil
}

// ColdCutoff computes the S3 dt cutoff date for a tenant given its cold_days.
// Exported so unit tests and the adapter can share the same arithmetic without
// depending on Retainer.
func ColdCutoff(now time.Time, coldDays int) time.Time {
	today := now.UTC().Truncate(24 * time.Hour)
	return today.AddDate(0, 0, -coldDays)
}
