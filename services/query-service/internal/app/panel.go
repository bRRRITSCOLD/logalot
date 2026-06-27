package app

import (
	"context"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// SavedQueryDef is the resolved definition from a saved_queries row. Only the
// fields the panel aggregation cares about — the display metadata lives in the
// dashboard panel, not here.
type SavedQueryDef struct {
	QueryText string
	Service   string
	Level     *kernel.Level
	Labels    map[string]string
}

// Bucket is one time-series data point: the bucket's start timestamp and the
// count of matching events whose ts falls in [BucketStart, BucketStart+size).
type Bucket struct {
	BucketStart time.Time `json:"bucketStart"`
	Count       int64     `json:"count"`
}

// PanelData is the response payload for a panel's data request: a total match
// count, a time-series of bucketed counts, and a sample of recent matching events.
type PanelData struct {
	TotalCount int64             `json:"totalCount"`
	Buckets    []Bucket          `json:"buckets"`
	RecentLogs []kernel.LogEvent `json:"recentLogs"`
}

// PanelStore is the driven port for panel-data resolution. Its adapter connects
// as the NOSUPERUSER logalot_app role so every call is RLS-governed.
//
// ctx-first (not tc-first) because this port is internal to the query-service
// and does not need to satisfy the kernel AllPorts contract.
type PanelStore interface {
	// Resolve reads the saved_query definition for savedQueryID within the tenant.
	// Returns nil, nil when not found (caller returns 404 when nil).
	Resolve(ctx context.Context, tc kernel.TenantContext, savedQueryID string) (*SavedQueryDef, error)
	// Count returns the total event count matching def in the half-open window [from, to).
	Count(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time) (int64, error)
	// TimeSeries returns bucketed event counts in [from, to) — one bucket per interval.
	TimeSeries(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time, nBuckets int) ([]Bucket, error)
	// RecentLogs returns the most recent matching events, newest-first.
	RecentLogs(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time, limit int) ([]kernel.LogEvent, error)
}

// DefaultPanelBuckets is the default time-series bucket count.
const DefaultPanelBuckets = 30

// DefaultRecentLogsLimit is the default number of recent log events returned.
const DefaultRecentLogsLimit = 20

// MaxRecentLogsLimit caps the caller-supplied limit.
const MaxRecentLogsLimit = 100

// PanelService is the query-service application core for panel-data.
// It resolves a saved query and runs count + time-series + recent-logs in
// parallel logical steps over the same logalot_app RLS-governed pool.
// Tenant isolation flows from TenantContext → PanelStore → SET LOCAL.
type PanelService struct {
	store PanelStore
}

// NewPanelService builds a PanelService over the panel store.
func NewPanelService(store PanelStore) *PanelService { return &PanelService{store: store} }

// PanelQuery is the input to a panel-data request.
type PanelQuery struct {
	SavedQueryID string
	From         time.Time
	To           time.Time
	Buckets      int
	RecentLimit  int
}

// Data resolves the saved query and runs the three aggregations for a panel.
// Returns nil, nil when the saved query is not found or is invisible (RLS).
func (s *PanelService) Data(
	ctx context.Context,
	tc kernel.TenantContext,
	q PanelQuery,
) (*PanelData, error) {
	def, err := s.store.Resolve(ctx, tc, q.SavedQueryID)
	if err != nil {
		return nil, err
	}
	if def == nil {
		// Invisible (RLS) or genuinely missing — caller returns 404.
		return nil, nil
	}

	// Default / clamp caller-supplied parameters.
	nBuckets := q.Buckets
	if nBuckets <= 0 || nBuckets > 100 {
		nBuckets = DefaultPanelBuckets
	}
	limit := q.RecentLimit
	if limit <= 0 {
		limit = DefaultRecentLogsLimit
	}
	if limit > MaxRecentLogsLimit {
		limit = MaxRecentLogsLimit
	}

	// Use caller's time range or default to last hour.
	from, to := q.From, q.To
	if to.IsZero() {
		to = time.Now().UTC()
	}
	if from.IsZero() {
		from = to.Add(-time.Hour)
	}

	total, err := s.store.Count(ctx, tc, *def, from, to)
	if err != nil {
		return nil, err
	}

	buckets, err := s.store.TimeSeries(ctx, tc, *def, from, to, nBuckets)
	if err != nil {
		return nil, err
	}

	recent, err := s.store.RecentLogs(ctx, tc, *def, from, to, limit)
	if err != nil {
		return nil, err
	}

	return &PanelData{
		TotalCount: total,
		Buckets:    buckets,
		RecentLogs: recent,
	}, nil
}
