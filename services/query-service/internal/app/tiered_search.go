package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// tier classifies a search query into exactly one routing category.
type tier int8

const (
	// tierHot: query window entirely within the hot horizon → Postgres only.
	tierHot tier = iota
	// tierCold: query window entirely beyond the hot horizon → Athena only.
	tierCold
	// tierBoth: query window straddles the hot cutoff → both tiers, union+dedupe.
	tierBoth
)

// TieredSearcher routes searches between the hot (Postgres) and cold (Athena)
// tiers based on the query time window relative to the hot horizon
// (ADR-0003 / cold-tier.md §5.2).
//
// Routing table:
//
//	Window entirely within [now − hotDays, now]  → hot only (unchanged)
//	Window entirely before (now − hotDays)        → cold only (Athena)
//	Window straddling (now − hotDays)             → both, union + dedupe on (ts, id)
//	No time bounds (q.From==zero && q.To==zero)  → hot only (default path)
//
// The cold path is gated on COLD_SEARCH_ENABLED (default FALSE). With the
// flag off, ALL queries route to Postgres — the no-op contract with
// production until the real-AWS smoke test passes (AC#3 / decision 016 §6).
//
// Tenancy is never derived from the query itself — both adapters receive the
// verified TenantContext, so a routing decision can never cross a tenant
// boundary.
type TieredSearcher struct {
	hot     kernel.LogStore
	cold    kernel.ColdArchive // may be nil when coldEnabled=false
	hotDays int
	enabled bool // COLD_SEARCH_ENABLED
	now     func() time.Time
	log     *slog.Logger
}

// TieredSearcherOption configures a TieredSearcher.
type TieredSearcherOption func(*TieredSearcher)

// WithTieredClock injects a clock for deterministic routing in tests.
func WithTieredClock(now func() time.Time) TieredSearcherOption {
	return func(ts *TieredSearcher) {
		if now != nil {
			ts.now = now
		}
	}
}

// WithTieredLogger sets the structured logger.
func WithTieredLogger(l *slog.Logger) TieredSearcherOption {
	return func(ts *TieredSearcher) {
		if l != nil {
			ts.log = l
		}
	}
}

// NewTieredSearcher builds a TieredSearcher.
//
//   - hot must always be non-nil (the existing Postgres LogStore).
//   - cold may be nil when COLD_SEARCH_ENABLED=false; in that case
//     enabled must also be false.
//   - hotDays is the global hot-partition horizon (default 30).
//   - enabled is the COLD_SEARCH_ENABLED flag.
func NewTieredSearcher(
	hot kernel.LogStore,
	cold kernel.ColdArchive,
	hotDays int,
	enabled bool,
	opts ...TieredSearcherOption,
) *TieredSearcher {
	if hotDays <= 0 {
		hotDays = DefaultHotDays
	}
	ts := &TieredSearcher{
		hot:     hot,
		cold:    cold,
		hotDays: hotDays,
		enabled: enabled,
		now:     time.Now,
		log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, o := range opts {
		o(ts)
	}
	return ts
}

// Search applies page-size defaults then routes to hot, cold, or both tiers
// based on the query window, the hot horizon, and COLD_SEARCH_ENABLED.
//
// Flag-off guarantee: when enabled=false this is identical to today's
// Postgres-only path — the cold path is never entered.
func (ts *TieredSearcher) Search(tc kernel.TenantContext, ctx context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	// Apply the page-size contract (same logic as app.Searcher).
	if q.Limit <= 0 {
		q.Limit = DefaultSearchLimit
	}
	if q.Limit > MaxSearchLimit {
		q.Limit = MaxSearchLimit
	}

	// Flag-off: route everything to hot (the no-op production guarantee).
	if !ts.enabled || ts.cold == nil {
		return ts.hot.Search(tc, ctx, q)
	}

	switch ts.classifyTier(q) {
	case tierCold:
		return ts.cold.Search(tc, ctx, q)
	case tierBoth:
		return ts.unionSearch(tc, ctx, q)
	default: // tierHot (also the catch-all)
		return ts.hot.Search(tc, ctx, q)
	}
}

// hotCutoff returns the boundary between hot and cold (exclusive): any event
// with ts < hotCutoff is cold; ts >= hotCutoff is hot.
func (ts *TieredSearcher) hotCutoff() time.Time {
	return ts.now().Add(-time.Duration(ts.hotDays) * 24 * time.Hour)
}

// classifyTier determines the routing tier for a query based on its time window
// and the current hot cutoff. Zero time bounds are treated as unbounded.
//
// Classification rules (where hotCutoff = now − hotDays):
//
//	from=0, to=0          → hot  (no bounds: use hot default)
//	to ≤ hotCutoff        → cold (entirely old)
//	from ≥ hotCutoff      → hot  (entirely recent)
//	from < hotCutoff < to → both (straddling)
//	from=0, to > hotCutoff → both (open start, to is in hot — cold may exist)
//	from < hotCutoff, to=0 → both (open end includes hot, from is in cold)
func (ts *TieredSearcher) classifyTier(q kernel.SearchQuery) tier {
	hotCutoff := ts.hotCutoff()

	// No time constraints at all: hot only (Postgres default).
	if q.From.IsZero() && q.To.IsZero() {
		return tierHot
	}

	// Both bounds set: precise classification.
	if !q.From.IsZero() && !q.To.IsZero() {
		if !q.To.After(hotCutoff) { // to ≤ hotCutoff: entirely cold
			return tierCold
		}
		if !q.From.Before(hotCutoff) { // from ≥ hotCutoff: entirely hot
			return tierHot
		}
		return tierBoth // from < hotCutoff < to: straddling
	}

	// Only 'from' is set (open 'to' means "up to now"):
	// from < hotCutoff means the query starts in cold territory.
	if !q.From.IsZero() && q.To.IsZero() {
		if q.From.Before(hotCutoff) {
			return tierBoth // from is old, to extends to now (hot)
		}
		return tierHot // from is recent
	}

	// Only 'to' is set (open 'from' means "from the very beginning"):
	// If to ≤ hotCutoff the entire range is cold; if to > hotCutoff, the
	// range includes hot data AND the open start extends into cold.
	if q.From.IsZero() && !q.To.IsZero() {
		if !q.To.After(hotCutoff) {
			return tierCold
		}
		return tierBoth // to is in hot but from is unbounded (includes cold)
	}

	return tierHot // unreachable; belt+suspenders
}

// unionSearch queries both tiers, dedupes on (ts, id), sorts ts DESC, and
// returns the first q.Limit events.
//
// I2 — PARTIAL FAILURE (deliberate availability-over-completeness choice):
// if exactly one tier fails, its error is logged and the other tier's results
// are returned alone, as a normal HTTP 200 with NO degraded-results signal in
// the response. This trades completeness for availability. Before
// COLD_SEARCH_ENABLED can be flipped (AC#3 / cold_smoke_aws gate) this needs a
// degradation indicator on the response so a caller can tell a partial page
// from a complete one — tracked as an AC#3 blocker. If both tiers fail, the
// joined error propagates (HTTP 500).
//
// I3 — NO CURSOR on straddle: a straddling query returns no NextCursor, so
// pages past the first are unreachable. Cross-tier keyset pagination (merging
// a Postgres keyset cursor with Athena, which has no server-side cursor) is a
// hard AC#3 blocker — tracked, see the return statement comment below.
func (ts *TieredSearcher) unionSearch(tc kernel.TenantContext, ctx context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	hotCutoff := ts.hotCutoff()

	// Split the query at the hot cutoff:
	//   hot half  = [hotCutoff, q.To]
	//   cold half = [q.From, hotCutoff)
	hotQ := q
	hotQ.From = hotCutoff
	hotQ.Cursor = nil // no keyset cursor inside a split query

	coldQ := q
	coldQ.To = hotCutoff
	coldQ.Cursor = nil

	hotPage, hotErr := ts.hot.Search(tc, ctx, hotQ)
	coldPage, coldErr := ts.cold.Search(tc, ctx, coldQ)

	if hotErr != nil && coldErr != nil {
		// Both tiers failed — propagate a joined error (both wrapped with %w via
		// errors.Join so callers can errors.Is either underlying cause). M4.
		return kernel.SearchPage{}, fmt.Errorf("tiered search: both tiers failed: %w",
			errors.Join(hotErr, coldErr))
	}
	if hotErr != nil {
		// I2: returning cold-only as a 200 with no degraded signal — see fn doc.
		ts.log.WarnContext(ctx, "tiered search: hot tier failed, returning cold only (no degraded signal — AC#3 blocker)",
			"tenant_id", string(tc.TenantID), "err", hotErr)
	}
	if coldErr != nil {
		// I2: returning hot-only as a 200 with no degraded signal — see fn doc.
		ts.log.WarnContext(ctx, "tiered search: cold tier failed, returning hot only (no degraded signal — AC#3 blocker)",
			"tenant_id", string(tc.TenantID), "err", coldErr)
	}

	// Union events from both tiers.
	all := make([]kernel.LogEvent, 0, len(hotPage.Events)+len(coldPage.Events))
	all = append(all, hotPage.Events...)
	all = append(all, coldPage.Events...)

	// Dedupe on (ts, id) per cold-tier.md §5.2 — but ONLY for rows with a
	// NON-EMPTY id. This is load-bearing and subtle:
	//
	//   Cold-tier parquet rows currently carry an EMPTY id. pkg/logstore Append
	//   lets Postgres assign the row id via gen_random_uuid() and does not read
	//   it back (no RETURNING backfill), and the processor cold-tee archives the
	//   SAME id-less event. So today every cold row has id == "" while the hot
	//   copy of the same event has a real UUID.
	//
	//   Consequence 1 (correctness): if we keyed dedupe on id alone, ALL cold
	//   rows (id == "") would collapse to a single row — silent data loss.
	//   Therefore empty-id rows are NEVER placed in the seen set and ALWAYS
	//   pass through untouched.
	//
	//   Consequence 2 (known gap): because the tee-overlap event has a real id
	//   in hot but "" in cold, cross-tier dedupe of a genuinely duplicated event
	//   is a NO-OP today — a tee-overlap event can appear twice in a straddle
	//   result. Fixing that requires hot and cold to share a stable id (a
	//   processor/logstore change), which is a separate, tracked AC#3 blocker
	//   for flipping COLD_SEARCH_ENABLED (cold_smoke_aws gate). We do NOT fix it
	//   here. Once a shared id lands, this same (ts, id) key dedupes correctly
	//   with no change to this logic.
	type tsID struct {
		ts time.Time
		id string
	}
	seen := make(map[tsID]struct{}, len(all))
	deduped := all[:0]
	for _, ev := range all {
		if ev.ID == "" {
			// Empty-id rows (all cold rows today) are never deduped — keep all.
			deduped = append(deduped, ev)
			continue
		}
		key := tsID{ts: ev.TS, id: ev.ID}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		deduped = append(deduped, ev)
	}

	// Sort ts DESC, id DESC — matches hot-store and cold-store native ordering.
	sort.Slice(deduped, func(i, j int) bool {
		if deduped[i].TS.Equal(deduped[j].TS) {
			return deduped[i].ID > deduped[j].ID
		}
		return deduped[i].TS.After(deduped[j].TS)
	})

	// Trim to limit.
	if q.Limit > 0 && len(deduped) > q.Limit {
		deduped = deduped[:q.Limit]
	}

	// I3: No cursor for straddling queries. Cross-tier keyset pagination is not
	// implemented (Athena has no server-side cursor, and merging it with a
	// Postgres keyset position is non-trivial), so pages past the first are
	// unreachable for a straddle. This is a hard AC#3 blocker — tracked in the
	// PR body — and is acceptable only while COLD_SEARCH_ENABLED is OFF.
	return kernel.SearchPage{Events: deduped}, nil
}
