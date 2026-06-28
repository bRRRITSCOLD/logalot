package app

import (
	"context"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// Search page-size contract (the edge enforces these against the raw query param;
// the LogStore adapter also clamps as an independent backstop). Kept here in the
// application core because page size is a query-API concern, not a transport one.
const (
	// DefaultSearchLimit is the page size when the caller omits ?limit.
	DefaultSearchLimit = 50
	// MaxSearchLimit caps a caller-supplied page size to bound query cost.
	MaxSearchLimit = 1000
	// DefaultHotDays is the hot-tier retention horizon used for cold-read
	// routing when no per-tenant override is configured (cold-tier.md §5.2).
	DefaultHotDays = 30
)

// Searcher is the query-service application service for hot search. It is the
// second core service beside Streamer (live tail), depending only on the
// kernel.LogStore port so the Postgres adapter and the Gin transport stay
// swappable around it (hexagonal centre). Tenancy is never read from user input:
// Search forwards the verified TenantContext to the store, which binds the tenant
// predicate and arms RLS — a search physically cannot reach another tenant's rows.
type Searcher struct {
	store kernel.LogStore
}

// NewSearcher builds a Searcher over a LogStore.
func NewSearcher(store kernel.LogStore) *Searcher {
	return &Searcher{store: store}
}

// Search applies the page-size contract (default/cap) and delegates to the store.
// The cursor, filters, and time range pass through unchanged; the store renders
// the keyset SELECT and returns one page plus the next cursor.
func (s *Searcher) Search(tc kernel.TenantContext, ctx context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	if q.Limit <= 0 {
		q.Limit = DefaultSearchLimit
	}
	if q.Limit > MaxSearchLimit {
		q.Limit = MaxSearchLimit
	}
	return s.store.Search(tc, ctx, q)
}
