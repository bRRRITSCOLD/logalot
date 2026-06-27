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
