package app

import (
	"context"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const (
	panelTenantA = "00000000-0000-0000-0000-00000000000a"
	panelTenantB = "00000000-0000-0000-0000-00000000000b"
	savedQueryID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
)

// fakePanelStore is an in-memory PanelStore for unit tests.
type fakePanelStore struct {
	defs     map[string]*SavedQueryDef // id → def (nil = not found)
	count    int64
	buckets  []Bucket
	recent   []kernel.LogEvent
}

func (f *fakePanelStore) Resolve(ctx context.Context, tc kernel.TenantContext, id string) (*SavedQueryDef, error) {
	def, ok := f.defs[id]
	if !ok {
		return nil, nil
	}
	return def, nil
}

func (f *fakePanelStore) Count(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time) (int64, error) {
	return f.count, nil
}

func (f *fakePanelStore) TimeSeries(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time, nBuckets int) ([]Bucket, error) {
	return f.buckets, nil
}

func (f *fakePanelStore) RecentLogs(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time, limit int) ([]kernel.LogEvent, error) {
	if len(f.recent) > limit {
		return f.recent[:limit], nil
	}
	return f.recent, nil
}

var _ PanelStore = (*fakePanelStore)(nil)

func TestPanelService_Data_ResolvesMissSavedQuery_ReturnsNil(t *testing.T) {
	store := &fakePanelStore{defs: map[string]*SavedQueryDef{}}
	svc := NewPanelService(store)
	tc := kernel.TenantContext{TenantID: panelTenantA}

	data, err := svc.Data(context.Background(), tc, PanelQuery{SavedQueryID: savedQueryID})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data != nil {
		t.Fatalf("expected nil for missing saved query, got %+v", data)
	}
}

func TestPanelService_Data_ResolvesDefinition_ReturnsCombinedData(t *testing.T) {
	lvl := kernel.LevelError
	store := &fakePanelStore{
		defs: map[string]*SavedQueryDef{
			savedQueryID: {Service: "billing", Level: &lvl},
		},
		count:   42,
		buckets: []Bucket{{BucketStart: time.Now(), Count: 42}},
		recent:  []kernel.LogEvent{{Service: "billing", Level: kernel.LevelError, Message: "boom"}},
	}
	svc := NewPanelService(store)
	tc := kernel.TenantContext{TenantID: panelTenantA}

	data, err := svc.Data(context.Background(), tc, PanelQuery{SavedQueryID: savedQueryID, Buckets: 5, RecentLimit: 10})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data == nil {
		t.Fatal("expected data, got nil")
	}
	if data.TotalCount != 42 {
		t.Errorf("TotalCount = %d, want 42", data.TotalCount)
	}
	if len(data.Buckets) != 1 {
		t.Errorf("Buckets len = %d, want 1", len(data.Buckets))
	}
	if len(data.RecentLogs) != 1 {
		t.Errorf("RecentLogs len = %d, want 1", len(data.RecentLogs))
	}
}

func TestPanelService_Data_ClampsRecentLimit(t *testing.T) {
	recent := make([]kernel.LogEvent, 50)
	store := &fakePanelStore{
		defs:   map[string]*SavedQueryDef{savedQueryID: {QueryText: "error"}},
		recent: recent,
	}
	svc := NewPanelService(store)
	tc := kernel.TenantContext{TenantID: panelTenantA}

	// Default limit (0 input) → DefaultRecentLogsLimit
	data, err := svc.Data(context.Background(), tc, PanelQuery{SavedQueryID: savedQueryID})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data == nil {
		t.Fatal("expected data")
	}
	if len(data.RecentLogs) > DefaultRecentLogsLimit {
		t.Errorf("RecentLogs len = %d, want <= %d", len(data.RecentLogs), DefaultRecentLogsLimit)
	}
}

func TestPanelService_Data_DefaultsBuckets(t *testing.T) {
	called := false
	store := &captureStore{
		def:     &SavedQueryDef{QueryText: "error"},
		onTS: func(n int) {
			if n != DefaultPanelBuckets {
				t.Errorf("buckets passed to TimeSeries = %d, want %d", n, DefaultPanelBuckets)
			}
			called = true
		},
	}
	svc := NewPanelService(store)
	tc := kernel.TenantContext{TenantID: panelTenantA}
	_, _ = svc.Data(context.Background(), tc, PanelQuery{SavedQueryID: savedQueryID, Buckets: 0})
	if !called {
		t.Fatal("TimeSeries was never called")
	}
}

// captureStore is a PanelStore that records nBuckets passed to TimeSeries.
type captureStore struct {
	def  *SavedQueryDef
	onTS func(n int)
}

func (c *captureStore) Resolve(ctx context.Context, tc kernel.TenantContext, id string) (*SavedQueryDef, error) {
	return c.def, nil
}
func (c *captureStore) Count(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time) (int64, error) {
	return 0, nil
}
func (c *captureStore) TimeSeries(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time, nBuckets int) ([]Bucket, error) {
	if c.onTS != nil {
		c.onTS(nBuckets)
	}
	return nil, nil
}
func (c *captureStore) RecentLogs(ctx context.Context, tc kernel.TenantContext, def SavedQueryDef, from, to time.Time, limit int) ([]kernel.LogEvent, error) {
	return nil, nil
}
