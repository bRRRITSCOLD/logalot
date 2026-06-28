package app

import (
	"context"
	"errors"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type fakePolicyStore struct {
	policies []RetentionPolicy
	err      error
}

func (f *fakePolicyStore) ListAll(_ context.Context) ([]RetentionPolicy, error) {
	return f.policies, f.err
}

type fakeHotDropper struct {
	calledWith []int
	dropped    int
	err        error
}

func (f *fakeHotDropper) DropOlderThan(_ context.Context, days int) (int, error) {
	f.calledWith = append(f.calledWith, days)
	if f.err != nil {
		return 0, f.err
	}
	return f.dropped, nil
}

type purgeCall struct {
	tenantID   string
	cutoffDate time.Time
}

type fakeColdPurger struct {
	calls   []purgeCall
	deleted int
	err     error
	// tenantErr maps tenant IDs to per-tenant errors (overrides err when set)
	tenantErr map[string]error
}

func (f *fakeColdPurger) PurgeExpiredPrefixes(_ context.Context, tenantID string, cutoff time.Time) (int, error) {
	f.calls = append(f.calls, purgeCall{tenantID: tenantID, cutoffDate: cutoff})
	if perr, ok := f.tenantErr[tenantID]; ok {
		return 0, perr
	}
	if f.err != nil {
		return 0, f.err
	}
	return f.deleted, nil
}

// ---------------------------------------------------------------------------
// ColdCutoff arithmetic
// ---------------------------------------------------------------------------

func TestColdCutoff_DefaultPolicy(t *testing.T) {
	now := time.Date(2026, 7, 1, 15, 0, 0, 0, time.UTC)
	got := ColdCutoff(now, 365)
	// 2026-07-01 − 365 days = 2025-07-01
	want := time.Date(2025, 7, 1, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("ColdCutoff(365) = %v, want %v", got, want)
	}
}

func TestColdCutoff_ShortPolicy(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	got := ColdCutoff(now, 30)
	want := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("ColdCutoff(30) = %v, want %v", got, want)
	}
}

func TestColdCutoff_Truncates_To_Midnight(t *testing.T) {
	// now has a non-zero time component — cutoff must be midnight UTC
	now := time.Date(2026, 6, 28, 23, 59, 59, 999, time.UTC)
	got := ColdCutoff(now, 10)
	if got.Hour() != 0 || got.Minute() != 0 || got.Second() != 0 || got.Nanosecond() != 0 {
		t.Errorf("ColdCutoff should be midnight UTC, got %v", got)
	}
	if got.UTC().Location() != time.UTC {
		t.Errorf("ColdCutoff must be UTC, got %v", got.Location())
	}
}

// ---------------------------------------------------------------------------
// Retainer.RunCycle — routing + isolation invariants
// ---------------------------------------------------------------------------

func TestRunCycle_CallsHotDropperWithConfiguredDays(t *testing.T) {
	policies := &fakePolicyStore{}
	dropper := &fakeHotDropper{dropped: 3}
	purger := &fakeColdPurger{}

	fixed := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	r := New(policies, dropper, purger,
		WithEnabled(true),
		WithHotDays(30),
		WithClock(func() time.Time { return fixed }),
	)
	if err := r.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle: %v", err)
	}

	if len(dropper.calledWith) != 1 || dropper.calledWith[0] != 30 {
		t.Errorf("hot dropper called with %v, want [30]", dropper.calledWith)
	}
}

func TestRunCycle_ColdPurgePerTenantWithCorrectCutoff(t *testing.T) {
	fixed := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	tenantA := "aaaaaaaa-0000-0000-0000-000000000001"
	tenantB := "bbbbbbbb-0000-0000-0000-000000000002"
	policies := &fakePolicyStore{
		policies: []RetentionPolicy{
			{TenantID: tenantA, HotDays: 30, ColdDays: 365},
			{TenantID: tenantB, HotDays: 30, ColdDays: 90},
		},
	}
	dropper := &fakeHotDropper{}
	purger := &fakeColdPurger{deleted: 5}

	r := New(policies, dropper, purger,
		WithEnabled(true),
		WithClock(func() time.Time { return fixed }),
	)
	if err := r.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle: %v", err)
	}

	// Expect exactly two purge calls — one per tenant
	if len(purger.calls) != 2 {
		t.Fatalf("purger called %d times, want 2", len(purger.calls))
	}

	// Find each tenant's call and verify the cutoff date.
	byTenant := make(map[string]time.Time)
	for _, c := range purger.calls {
		byTenant[c.tenantID] = c.cutoffDate
	}

	wantCutoffA := time.Date(2025, 7, 1, 0, 0, 0, 0, time.UTC) // 2026-07-01 − 365d
	wantCutoffB := time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC) // 2026-07-01 − 90d
	if !byTenant[tenantA].Equal(wantCutoffA) {
		t.Errorf("tenant A cutoff = %v, want %v", byTenant[tenantA], wantCutoffA)
	}
	if !byTenant[tenantB].Equal(wantCutoffB) {
		t.Errorf("tenant B cutoff = %v, want %v", byTenant[tenantB], wantCutoffB)
	}
}

func TestRunCycle_TenantIsolation_PurgesOnlyOwnTenant(t *testing.T) {
	// SECURITY: each tenant's purge call must reference ONLY that tenant's ID.
	// This test verifies the call arguments — the actual S3 prefix safety is
	// verified in the adapter test (s3/coldpurger_test.go).
	fixed := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	tenantX := "xxxxxxxx-0000-0000-0000-000000000001"
	tenantY := "yyyyyyyy-0000-0000-0000-000000000002"
	policies := &fakePolicyStore{
		policies: []RetentionPolicy{
			{TenantID: tenantX, HotDays: 30, ColdDays: 180},
			{TenantID: tenantY, HotDays: 30, ColdDays: 180},
		},
	}
	dropper := &fakeHotDropper{}
	purger := &fakeColdPurger{deleted: 0}

	r := New(policies, dropper, purger, WithEnabled(true), WithClock(func() time.Time { return fixed }))
	_ = r.RunCycle(context.Background())

	seenTenants := make(map[string]bool)
	for _, c := range purger.calls {
		seenTenants[c.tenantID] = true
	}
	// Every tenant that has a policy must be swept exactly once.
	for _, tenant := range []string{tenantX, tenantY} {
		if !seenTenants[tenant] {
			t.Errorf("tenant %s not swept", tenant)
		}
	}
	// No extra tenants swept.
	if len(purger.calls) != 2 {
		t.Errorf("want 2 purge calls, got %d", len(purger.calls))
	}
}

func TestRunCycle_ListPoliciesError_IsHardError(t *testing.T) {
	policies := &fakePolicyStore{err: errors.New("db down")}
	dropper := &fakeHotDropper{}
	purger := &fakeColdPurger{}

	r := New(policies, dropper, purger, WithEnabled(true))
	err := r.RunCycle(context.Background())
	if err == nil {
		t.Fatal("expected error from ListAll failure, got nil")
	}
}

func TestRunCycle_HotDropperError_DoesNotAbortColdSweep(t *testing.T) {
	// A hot drop failure is logged but the cold sweep continues.
	fixed := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	tenantA := "aaaaaaaa-0000-0000-0000-000000000001"
	policies := &fakePolicyStore{
		policies: []RetentionPolicy{
			{TenantID: tenantA, HotDays: 30, ColdDays: 365},
		},
	}
	dropper := &fakeHotDropper{err: errors.New("postgres down")}
	purger := &fakeColdPurger{deleted: 2}

	r := New(policies, dropper, purger, WithEnabled(true), WithClock(func() time.Time { return fixed }))
	err := r.RunCycle(context.Background())
	// RunCycle should NOT return the hot drop error (it continues cold sweep).
	if err != nil {
		t.Errorf("expected no hard error, got: %v", err)
	}
	// Cold sweep still ran.
	if len(purger.calls) != 1 {
		t.Errorf("cold sweep ran %d times, want 1", len(purger.calls))
	}
}

func TestRunCycle_PerTenantColdError_DoesNotAbortOtherTenants(t *testing.T) {
	// A per-tenant cold purge failure must NOT stop other tenants from being swept.
	fixed := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	tenantA := "aaaaaaaa-0000-0000-0000-000000000001"
	tenantB := "bbbbbbbb-0000-0000-0000-000000000002"
	tenantC := "cccccccc-0000-0000-0000-000000000003"
	policies := &fakePolicyStore{
		policies: []RetentionPolicy{
			{TenantID: tenantA, HotDays: 30, ColdDays: 365},
			{TenantID: tenantB, HotDays: 30, ColdDays: 365},
			{TenantID: tenantC, HotDays: 30, ColdDays: 365},
		},
	}
	dropper := &fakeHotDropper{}
	purger := &fakeColdPurger{
		deleted: 1,
		tenantErr: map[string]error{
			tenantB: errors.New("s3 error"),
		},
	}

	r := New(policies, dropper, purger, WithEnabled(true), WithClock(func() time.Time { return fixed }))
	err := r.RunCycle(context.Background())
	if err != nil {
		t.Errorf("expected no hard error even with per-tenant failure, got: %v", err)
	}
	// All three tenants should have been attempted.
	if len(purger.calls) != 3 {
		t.Errorf("purger called %d times, want 3", len(purger.calls))
	}
}

func TestRunCycle_NoPolicies_SucceedsWithNoS3Calls(t *testing.T) {
	policies := &fakePolicyStore{policies: []RetentionPolicy{}}
	dropper := &fakeHotDropper{dropped: 0}
	purger := &fakeColdPurger{}

	r := New(policies, dropper, purger, WithEnabled(true))
	if err := r.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle with no policies: %v", err)
	}
	if len(purger.calls) != 0 {
		t.Errorf("expected no purge calls for empty policies, got %d", len(purger.calls))
	}
}

// ---------------------------------------------------------------------------
// Kill-switch (RETENTION_ENABLED) — Security Medium-1
// ---------------------------------------------------------------------------

func TestRunCycle_Disabled_IsNoOp(t *testing.T) {
	// SECURITY: a worker built WITHOUT WithEnabled(true) (the default, mirroring
	// RETENTION_ENABLED unset) must perform NO drops and NO deletes — an
	// accidental deploy is harmless.
	policies := &fakePolicyStore{
		policies: []RetentionPolicy{
			{TenantID: "aaaaaaaa-0000-0000-0000-000000000001", HotDays: 30, ColdDays: 365},
		},
	}
	dropper := &fakeHotDropper{dropped: 99}
	purger := &fakeColdPurger{deleted: 99}

	// New WITHOUT WithEnabled → disabled by default.
	r := New(policies, dropper, purger)
	if err := r.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle (disabled): %v", err)
	}

	if len(dropper.calledWith) != 0 {
		t.Errorf("disabled worker called hot dropper %d time(s) — want 0", len(dropper.calledWith))
	}
	if len(purger.calls) != 0 {
		t.Errorf("disabled worker called purger %d time(s) — want 0", len(purger.calls))
	}
}

func TestRunCycle_ExplicitlyDisabled_IsNoOp(t *testing.T) {
	dropper := &fakeHotDropper{}
	purger := &fakeColdPurger{}
	r := New(&fakePolicyStore{}, dropper, purger, WithEnabled(false))
	if err := r.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle (explicitly disabled): %v", err)
	}
	if len(dropper.calledWith) != 0 || len(purger.calls) != 0 {
		t.Error("explicitly-disabled worker performed a destructive operation")
	}
}

// ---------------------------------------------------------------------------
// Dry-run — logs intent, performs no destructive operation
// ---------------------------------------------------------------------------

func TestRunCycle_DryRun_NoDropsOrDeletes(t *testing.T) {
	fixed := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	policies := &fakePolicyStore{
		policies: []RetentionPolicy{
			{TenantID: "aaaaaaaa-0000-0000-0000-000000000001", HotDays: 30, ColdDays: 365},
			{TenantID: "bbbbbbbb-0000-0000-0000-000000000002", HotDays: 30, ColdDays: 90},
		},
	}
	dropper := &fakeHotDropper{}
	purger := &fakeColdPurger{}

	// Enabled AND dry-run: iterates policies (SELECT only) but performs NO
	// drops or deletes.
	r := New(policies, dropper, purger,
		WithEnabled(true),
		WithDryRun(true),
		WithClock(func() time.Time { return fixed }),
	)
	if err := r.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle (dry-run): %v", err)
	}
	if len(dropper.calledWith) != 0 {
		t.Errorf("dry-run called hot dropper %d time(s) — want 0", len(dropper.calledWith))
	}
	if len(purger.calls) != 0 {
		t.Errorf("dry-run called purger %d time(s) — want 0", len(purger.calls))
	}
}
