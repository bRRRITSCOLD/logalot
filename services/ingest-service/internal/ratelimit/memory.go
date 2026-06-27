package ratelimit

import (
	"context"
	"sync"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// MemoryLimiter is an in-process token-bucket Limiter. It shares the exact same
// admission math (take) as the Redis adapter, so it is the deterministic backend
// for unit tests (inject a fake clock) and a usable single-node fallback when
// Redis is not configured. It is NOT a substitute for the Redis limiter across a
// horizontally-scaled ingest tier — each process would keep its own buckets, so
// the effective limit would multiply by replica count.
type MemoryLimiter struct {
	resolver Resolver
	now      func() time.Time

	mu      sync.Mutex
	buckets map[string]bucketState
}

// NewMemoryLimiter builds an in-process limiter over resolver. now defaults to
// time.Now; pass WithMemoryClock in tests for determinism.
func NewMemoryLimiter(resolver Resolver, opts ...MemoryOption) *MemoryLimiter {
	m := &MemoryLimiter{
		resolver: resolver,
		now:      time.Now,
		buckets:  map[string]bucketState{},
	}
	for _, o := range opts {
		o(m)
	}
	if m.now == nil {
		m.now = time.Now
	}
	return m
}

// MemoryOption configures a MemoryLimiter.
type MemoryOption func(*MemoryLimiter)

// WithMemoryClock injects a clock so tests advance time deterministically.
func WithMemoryClock(now func() time.Time) MemoryOption {
	return func(m *MemoryLimiter) { m.now = now }
}

// Allow admits one request for tc against its per-tenant bucket. The bucket key is
// derived from tc.TenantID only, so tenants are fully isolated.
//
// tc is validated BEFORE the Unlimited short-circuit (issue #47): an exempted
// tenant (Rate=0:0) with a blank or invalid TenantContext must still fail
// closed rather than bypass the UUID validity check.
func (m *MemoryLimiter) Allow(tc kernel.TenantContext, _ context.Context) (Decision, error) {
	// Fail closed unconditionally on an invalid TenantContext BEFORE applying
	// any resolver exemption, so a malformed tc can never silently bypass limits.
	if err := tc.Valid(); err != nil {
		return Decision{}, err
	}
	lim := m.resolver.Resolve(tc)
	if lim.Unlimited() {
		return Decision{Allowed: true}, nil
	}
	key, err := bucketKey(tc)
	if err != nil {
		return Decision{}, err
	}
	nowMs := m.now().UnixMilli()

	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.buckets[key]
	if !ok {
		// Fresh bucket starts full so a tenant's first burst is admitted.
		s = bucketState{tokens: lim.Burst, ts: nowMs}
	}
	next, d := take(s, lim, nowMs, 1)
	m.buckets[key] = next
	return d, nil
}

// compile-time proof MemoryLimiter satisfies the port.
var _ Limiter = (*MemoryLimiter)(nil)
