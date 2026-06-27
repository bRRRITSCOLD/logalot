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

// TestHandle_CancelledContextRetrySucceeded_Acks verifies the control flow when a
// shutdown arrives mid-backoff but the next persist attempt then succeeds.
//
// Control flow with failFirst=1, maxRetries=3:
//   - attempt 0: Append fails (calls=1), lastErr set, continue.
//   - attempt 1: ctx.Err() is checked FIRST and is still nil (cancellation has not
//     happened yet); the loop proceeds into the sleep, which cancels ctx; then
//     Append runs on drainCtx (NOT cancelled, derived via WithoutCancel) and
//     SUCCEEDS (calls=2) → persist returns nil → Handle ACKs.
//
// So a shutdown that lands while retrying does NOT DLQ a message whose persist
// ultimately succeeds: the result is nil/ACK.
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

	err := s.Handle(mtc(), ctx, env(`{"message":"retry-during-shutdown"}`))
	if err != nil {
		t.Fatalf("retry that ultimately succeeds during shutdown must ACK (nil), got %v", err)
	}
	if store.calls != 2 {
		t.Errorf("store.Append calls = %d, want 2 (1 fail + 1 success on drainCtx)", store.calls)
	}
	if len(store.appended) != 1 {
		t.Errorf("appended %d events, want 1", len(store.appended))
	}
}

// blockingStore is a kernel.LogStore whose Append blocks until the context it is
// given is cancelled, then returns ctx.Err(). It models a stuck/hung database so a
// test can prove the drain context is BOUNDED (issue #37, blocker I1): without the
// WithTimeout bound, Append would block forever and hang shutdown until SIGKILL.
type blockingStore struct {
	mu sync.Mutex
	n  int
}

func (b *blockingStore) Append(_ kernel.TenantContext, ctx context.Context, _ ...kernel.LogEvent) error {
	b.mu.Lock()
	b.n++
	b.mu.Unlock()
	<-ctx.Done() // hang until the (bounded) drain context fires
	return ctx.Err()
}

func (b *blockingStore) Search(kernel.TenantContext, context.Context, kernel.SearchQuery) (kernel.SearchPage, error) {
	return kernel.SearchPage{}, errors.New("unused")
}
func (b *blockingStore) Tail(kernel.TenantContext, context.Context, kernel.TailQuery) ([]kernel.LogEvent, error) {
	return nil, errors.New("unused")
}
func (b *blockingStore) calls() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.n
}

// TestHandle_DrainTimeoutBoundsHungStore is the I1 blocker test: a stuck DB whose
// Append never returns on its own must NOT hang the processor forever. The drain
// context is derived via context.WithoutCancel (so a SIGTERM does not abort it) but
// is bounded by drainTimeout, so Append observes a deadline and returns within the
// bound. A persist that cannot complete inside the drain window surfaces an error
// (the message dead-letters — the correct outcome for a genuinely stuck DB).
func TestHandle_DrainTimeoutBoundsHungStore(t *testing.T) {
	store := &blockingStore{}
	tail := &fakeTail{}
	// No retries (one attempt), tiny drain bound so the test is fast.
	s := New(store, tail, WithRetry(0, time.Millisecond), WithDrainTimeout(50*time.Millisecond), noSleep())

	// Pre-cancel the lifecycle ctx to simulate the SIGTERM-during-persist timing.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan error, 1)
	go func() { done <- s.Handle(mtc(), ctx, env(`{"message":"stuck-db"}`)) }()

	select {
	case err := <-done:
		// The hung store could not complete within the drain bound -> error -> DLQ.
		if err == nil {
			t.Fatal("a store stuck past the drain window must surface an error, got nil")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Handle did not return within the drain bound; WithoutCancel left the persist unbounded")
	}
	if store.calls() < 1 {
		t.Error("store.Append was never called (drain must still attempt the persist)")
	}
}
