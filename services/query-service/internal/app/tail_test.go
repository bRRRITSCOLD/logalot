package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const (
	tenantA = kernel.TenantID("00000000-0000-0000-0000-00000000000a")
	tenantB = kernel.TenantID("00000000-0000-0000-0000-00000000000b")
)

// fakeBus is a kernel.TailBus whose Subscribe records the tenant it was called
// with (proving the channel is derived from the verified context) and returns a
// channel the test feeds. Publish is unused here.
type fakeBus struct {
	mu         sync.Mutex
	subscribed []kernel.TenantContext
	ch         chan kernel.LogEvent
	subErr     error
}

func newFakeBus() *fakeBus { return &fakeBus{ch: make(chan kernel.LogEvent)} }

func (b *fakeBus) Publish(kernel.TenantContext, context.Context, kernel.LogEvent) error { return nil }

func (b *fakeBus) Subscribe(tc kernel.TenantContext, _ context.Context) (<-chan kernel.LogEvent, error) {
	b.mu.Lock()
	b.subscribed = append(b.subscribed, tc)
	b.mu.Unlock()
	if b.subErr != nil {
		return nil, b.subErr
	}
	return b.ch, nil
}

func (b *fakeBus) subscribedTenants() []kernel.TenantID {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]kernel.TenantID, 0, len(b.subscribed))
	for _, tc := range b.subscribed {
		out = append(out, tc.TenantID)
	}
	return out
}

// recordingSink captures the frames the core emits. Data optionally blocks on a
// gate so a test can model a slow consumer.
type recordingSink struct {
	mu         sync.Mutex
	data       []kernel.LogEvent
	gaps       []int
	heartbeats int
	gate       chan struct{} // when non-nil, Data blocks until it is closed
	gatedOnce  bool
}

func (s *recordingSink) Data(ev kernel.LogEvent) error {
	s.mu.Lock()
	g := s.gate
	first := !s.gatedOnce
	if g != nil && first {
		s.gatedOnce = true
	}
	s.mu.Unlock()
	if g != nil && first {
		<-g // model a stalled browser holding the consumer
	}
	s.mu.Lock()
	s.data = append(s.data, ev)
	s.mu.Unlock()
	return nil
}

func (s *recordingSink) Gap(n int) error {
	s.mu.Lock()
	s.gaps = append(s.gaps, n)
	s.mu.Unlock()
	return nil
}

func (s *recordingSink) Heartbeat() error {
	s.mu.Lock()
	s.heartbeats++
	s.mu.Unlock()
	return nil
}

func (s *recordingSink) dataLen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.data)
}

func (s *recordingSink) totalDropped() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := 0
	for _, g := range s.gaps {
		t += g
	}
	return t
}

func (s *recordingSink) heartbeatCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.heartbeats
}

func tcFor(id kernel.TenantID) kernel.TenantContext {
	return kernel.TenantContext{TenantID: id, Role: kernel.RoleMember}
}

func ev(level kernel.Level, service, msg string) kernel.LogEvent {
	return kernel.LogEvent{Level: level, Service: service, Message: msg, TS: time.Now()}
}

// waitFor polls cond until true or the deadline elapses.
func waitFor(t *testing.T, d time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(time.Millisecond)
	}
	return cond()
}

// TestStream_DerivesSubscribeFromContext is the load-bearing isolation test at
// the core: Subscribe is called with EXACTLY the authenticated tenant, so the
// channel (tail:{tenant}) can never be caller-controlled.
func TestStream_DerivesSubscribeFromContext(t *testing.T) {
	bus := newFakeBus()
	s := New(bus)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() { _ = s.Stream(tcFor(tenantA), ctx, Filter{}, &recordingSink{}) }()

	if !waitFor(t, time.Second, func() bool { return len(bus.subscribedTenants()) == 1 }) {
		t.Fatal("Subscribe was never called")
	}
	got := bus.subscribedTenants()
	if got[0] != tenantA {
		t.Fatalf("subscribed tenant = %q, want %q (channel must come from ctx)", got[0], tenantA)
	}
}

func TestStream_EmitsDataFrameForEvent(t *testing.T) {
	bus := newFakeBus()
	sink := &recordingSink{}
	s := New(bus)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() { _ = s.Stream(tcFor(tenantA), ctx, Filter{}, sink) }()

	want := ev(kernel.LevelInfo, "api", "hello")
	bus.ch <- want

	if !waitFor(t, time.Second, func() bool { return sink.dataLen() == 1 }) {
		t.Fatal("event was not emitted to the sink")
	}
	sink.mu.Lock()
	got := sink.data[0]
	sink.mu.Unlock()
	if got.Message != "hello" {
		t.Fatalf("emitted message = %q, want %q", got.Message, "hello")
	}
}

func TestStream_FilterAppliedBeforeEmit(t *testing.T) {
	bus := newFakeBus()
	sink := &recordingSink{}
	wantLevel := kernel.LevelError
	s := New(bus)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() { _ = s.Stream(tcFor(tenantA), ctx, Filter{Level: &wantLevel}, sink) }()

	bus.ch <- ev(kernel.LevelInfo, "api", "noise")  // filtered out
	bus.ch <- ev(kernel.LevelError, "api", "boom")  // kept
	bus.ch <- ev(kernel.LevelDebug, "api", "noise") // filtered out

	if !waitFor(t, time.Second, func() bool { return sink.dataLen() == 1 }) {
		t.Fatalf("want exactly 1 emitted event, got %d", sink.dataLen())
	}
	sink.mu.Lock()
	got := sink.data[0]
	sink.mu.Unlock()
	if got.Level != kernel.LevelError {
		t.Fatalf("emitted level = %v, want error (filter must drop non-matching)", got.Level)
	}
}

func TestStream_HeartbeatOnTick(t *testing.T) {
	bus := newFakeBus()
	sink := &recordingSink{}
	tick := make(chan time.Time, 1)
	s := New(bus, WithTicker(func(time.Duration) (<-chan time.Time, func()) {
		return tick, func() {}
	}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() { _ = s.Stream(tcFor(tenantA), ctx, Filter{}, sink) }()

	tick <- time.Now() // fire the heartbeat deterministically
	if !waitFor(t, time.Second, func() bool { return sink.heartbeatCount() == 1 }) {
		t.Fatalf("heartbeat count = %d, want 1 on the interval", sink.heartbeatCount())
	}
}

// TestStream_SlowConsumerDropsAndGaps proves the slow-consumer contract: a
// stalled sink causes events to be DROPPED (not block the bus) and surfaces as a
// Gap, so the publisher is never backed up.
func TestStream_SlowConsumerDropsAndGaps(t *testing.T) {
	bus := newFakeBus()
	gate := make(chan struct{})
	sink := &recordingSink{gate: gate}
	s := New(bus, WithBuffer(2)) // tiny buffer to force overflow
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() { _ = s.Stream(tcFor(tenantA), ctx, Filter{}, sink) }()

	// e1 is pulled into Data and blocks there (stalled browser). e2,e3 fill the
	// buffer; everything after overflows and is dropped. Each send blocks until
	// the pump has received it, so by the time the last send returns the pump has
	// processed (and dropped) it.
	for i := 0; i < 6; i++ {
		bus.ch <- ev(kernel.LevelInfo, "api", "msg")
	}

	close(gate) // release the stalled consumer

	if !waitFor(t, 2*time.Second, func() bool { return sink.totalDropped() > 0 }) {
		t.Fatal("expected a Gap reporting dropped events from the slow consumer")
	}
	// The publisher (test goroutine) was never blocked: all 6 sends returned.
}

func TestStream_TeardownOnContextCancel(t *testing.T) {
	bus := newFakeBus()
	s := New(bus)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		_ = s.Stream(tcFor(tenantA), ctx, Filter{}, &recordingSink{})
		close(done)
	}()

	// Ensure the subscription is live, then disconnect.
	if !waitFor(t, time.Second, func() bool { return len(bus.subscribedTenants()) == 1 }) {
		t.Fatal("Subscribe was never called")
	}
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Stream did not return after context cancel (no clean teardown)")
	}
}

func TestStream_SubscribeErrorPropagates(t *testing.T) {
	bus := newFakeBus()
	bus.subErr = kernel.ErrNoTenantContext
	s := New(bus)

	err := s.Stream(kernel.TenantContext{}, context.Background(), Filter{}, &recordingSink{})
	if err == nil {
		t.Fatal("want the subscribe error to propagate (fail closed)")
	}
}

func TestFilter_MatchZeroValueMatchesAll(t *testing.T) {
	var f Filter
	if !f.Match(ev(kernel.LevelInfo, "api", "x")) {
		t.Fatal("zero filter must match everything")
	}
}
