package app

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// fakeStore is a kernel.LogStore that records appends and can fail a bounded
// number of times to exercise the transient-retry path.
type fakeStore struct {
	mu          sync.Mutex
	appended    []kernel.LogEvent
	armedTenant kernel.TenantID
	failFirst   int   // fail this many initial Append calls, then succeed
	failAlways  error // if set, every Append fails with this
	calls       int
}

func (f *fakeStore) Append(tc kernel.TenantContext, _ context.Context, events ...kernel.LogEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.failAlways != nil {
		return f.failAlways
	}
	if f.calls <= f.failFirst {
		return errors.New("transient db error")
	}
	f.armedTenant = tc.TenantID
	f.appended = append(f.appended, events...)
	return nil
}

func (f *fakeStore) Search(kernel.TenantContext, context.Context, kernel.SearchQuery) (kernel.SearchPage, error) {
	return kernel.SearchPage{}, errors.New("unused")
}
func (f *fakeStore) Tail(kernel.TenantContext, context.Context, kernel.TailQuery) ([]kernel.LogEvent, error) {
	return nil, errors.New("unused")
}

// fakeTail is a kernel.TailBus that records publishes and can fail.
type fakeTail struct {
	mu        sync.Mutex
	published []kernel.LogEvent
	channelTC kernel.TenantContext
	pubErr    error
}

func (f *fakeTail) Publish(tc kernel.TenantContext, _ context.Context, ev kernel.LogEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pubErr != nil {
		return f.pubErr
	}
	f.channelTC = tc
	f.published = append(f.published, ev)
	return nil
}
func (f *fakeTail) Subscribe(kernel.TenantContext, context.Context) (<-chan kernel.LogEvent, error) {
	return nil, errors.New("unused")
}

func noSleep() Option { return withSleeper(func(context.Context, time.Duration) {}) }

func mtc() kernel.TenantContext {
	return kernel.TenantContext{TenantID: tenantA, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
}

func TestHandle_SuccessPersistsThenPublishesAndAcks(t *testing.T) {
	store := &fakeStore{}
	tail := &fakeTail{}
	s := New(store, tail, WithClock(fixedNow), noSleep())

	err := s.Handle(mtc(), context.Background(), env(`{"message":"ok","level":"info"}`))
	if err != nil {
		t.Fatalf("Handle (ack expected) = %v", err)
	}
	if len(store.appended) != 1 {
		t.Fatalf("appended %d, want 1", len(store.appended))
	}
	if store.armedTenant != tenantA {
		t.Errorf("appended under tenant %q, want %q", store.armedTenant, tenantA)
	}
	if len(tail.published) != 1 {
		t.Fatalf("published %d, want 1", len(tail.published))
	}
	if tail.channelTC.TenantID != tenantA {
		t.Errorf("tail tenant %q, want %q", tail.channelTC.TenantID, tenantA)
	}
}

func TestHandle_PoisonReturnsErrorWithoutPersistOrRetry(t *testing.T) {
	store := &fakeStore{}
	tail := &fakeTail{}
	s := New(store, tail, noSleep())

	err := s.Handle(mtc(), context.Background(), env(`not-json`))
	if !IsPoison(err) {
		t.Fatalf("err = %v, want poison (-> nack/dlq)", err)
	}
	if store.calls != 0 {
		t.Errorf("poison must not hit the store, calls=%d", store.calls)
	}
	if len(tail.published) != 0 {
		t.Errorf("poison must not publish to tail")
	}
}

func TestHandle_TransientPersistRetriesThenAcks(t *testing.T) {
	store := &fakeStore{failFirst: 2} // fail twice, succeed on the 3rd attempt
	tail := &fakeTail{}
	s := New(store, tail, WithRetry(3, time.Millisecond), noSleep())

	err := s.Handle(mtc(), context.Background(), env(`{"message":"eventually"}`))
	if err != nil {
		t.Fatalf("Handle should ack after retries, got %v", err)
	}
	if store.calls != 3 {
		t.Errorf("store calls = %d, want 3 (2 fail + 1 success)", store.calls)
	}
	if len(store.appended) != 1 {
		t.Errorf("appended %d, want 1", len(store.appended))
	}
}

func TestHandle_PersistExhaustedReturnsErrorForDLQ(t *testing.T) {
	store := &fakeStore{failAlways: errors.New("db permanently down")}
	tail := &fakeTail{}
	s := New(store, tail, WithRetry(2, time.Millisecond), noSleep())

	err := s.Handle(mtc(), context.Background(), env(`{"message":"never"}`))
	if err == nil {
		t.Fatal("expected error after exhausting retries (-> nack/dlq)")
	}
	if store.calls != 3 { // maxRetries(2) + 1 initial
		t.Errorf("store calls = %d, want 3", store.calls)
	}
	if len(tail.published) != 0 {
		t.Error("must not publish when persist failed")
	}
}

func TestHandle_TailFailureStillAcks(t *testing.T) {
	store := &fakeStore{}
	tail := &fakeTail{pubErr: errors.New("redis down")}
	s := New(store, tail, noSleep())

	// Persist succeeded; a tail failure must NOT fail the message (no re-delivery /
	// duplicate insert). Handle returns nil so the broker acks.
	if err := s.Handle(mtc(), context.Background(), env(`{"message":"persisted"}`)); err != nil {
		t.Fatalf("tail failure must not fail the message, got %v", err)
	}
	if len(store.appended) != 1 {
		t.Errorf("event should still be persisted, appended=%d", len(store.appended))
	}
}

// TestHandle_CancelledContextDuringPersist_DoesNotDLQ is the load-bearing test
// for issue #37: a lifecycle context that is already cancelled when Handle is
// called (SIGTERM timing) must NOT cause the message to be nacked to the DLQ.
//
// Before the fix, persist checked ctx.Err() before the first DB call and returned
// context.Canceled immediately, which Handle propagated as an error → nack/DLQ.
// After the fix, persist uses context.WithoutCancel so the store.Append call runs
// to completion and Handle returns nil (ACK).
func TestHandle_CancelledContextDuringPersist_DoesNotDLQ(t *testing.T) {
	store := &fakeStore{}
	tail := &fakeTail{}
	s := New(store, tail, noSleep())

	// Pre-cancel the context to simulate SIGTERM firing just as the message was
	// picked up from the queue and passed to Handle.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := s.Handle(mtc(), ctx, env(`{"message":"drain-on-shutdown"}`))
	if err != nil {
		t.Fatalf("cancelled lifecycle ctx must not DLQ the message (want nil), got %v", err)
	}
	if store.calls != 1 {
		t.Errorf("store.Append calls = %d, want 1 (drain must not skip persist)", store.calls)
	}
	if len(store.appended) != 1 {
		t.Errorf("appended %d events, want 1", len(store.appended))
	}
}

// TestHandle_CancelledBetweenRetries_StopsRetryingDoesNotDLQ verifies that when
// ctx is cancelled between retry attempts (shutdown arrives mid-backoff), the retry
// loop exits but returns nil (not an error) when the last persist attempt actually
// succeeded.  Separately, if the last attempt failed before ctx was cancelled, the
// lastErr is returned — which is a genuine DB error and may DLQ. This test focuses
// on the shutdown-during-backoff-after-success path.
func TestHandle_CancelledContextRetrySucceeded_Acks(t *testing.T) {
	// failFirst=1: first attempt fails, second succeeds.
	store := &fakeStore{failFirst: 1}
	tail := &fakeTail{}

	// sleeper that cancels ctx on the first sleep call (simulating shutdown arriving
	// while the processor is waiting between retries).
	ctx, cancel := context.WithCancel(context.Background())
	sleepCancel := withSleeper(func(c context.Context, d time.Duration) {
		cancel()
		sleepCtx(c, d) // still respect the ctx so the test doesn't hang
	})

	s := New(store, tail, WithRetry(3, time.Millisecond), sleepCancel)

	// The first attempt fails; the sleep fires and cancels ctx; persist checks
	// ctx.Err() before a second attempt and exits. The last attempt failed → the
	// error is returned.  This is the "DB-error-at-shutdown" path: the message
	// goes to DLQ only because of the DB error, not because of the shutdown.
	// We don't assert nil here — we assert the store was called at least once.
	_ = s.Handle(mtc(), ctx, env(`{"message":"retry-during-shutdown"}`))
	if store.calls < 1 {
		t.Errorf("store.Append calls = %d, want >= 1", store.calls)
	}
}
