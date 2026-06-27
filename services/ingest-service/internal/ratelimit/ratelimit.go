// Package ratelimit is the ingest-service per-tenant rate limiter (ADR-0004,
// NFR-3). It sits on the accept path AFTER authentication and BEFORE publish,
// keyed strictly by the authenticated TenantContext's tenant id — never by
// anything in the request body. Over-limit requests are rejected so the hot path
// stays off Postgres and the broker gets backpressure rather than a flood.
//
// Algorithm: token bucket (the algorithm ADR-0004 names). A bucket holds up to
// `Burst` tokens and refills at `Rate` tokens/second; each admitted request takes
// one token. Token bucket is chosen over a sliding-window counter because it
// models exactly what ingest backpressure needs — a sustained per-second rate
// plus a bounded burst allowance — and it yields a precise Retry-After (the time
// until the next token is available). The refill+take step is a single pure
// function (take, below) so the decision is deterministic and unit-testable with
// a fake clock; the Redis adapter mirrors it atomically in a Lua script.
//
// Tenancy: Limiter.Allow takes the TenantContext first (the repo-wide port
// convention) and derives the bucket key from tc.TenantID only. Two tenants
// therefore use two independent buckets — tenant A exhausting its bucket can
// never throttle tenant B.
package ratelimit

import (
	"context"
	"math"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// keyPrefix namespaces rate-limit buckets in the shared Redis instance (which
// also carries auth key cache + tail pub/sub). The tenant id is appended verbatim.
const keyPrefix = "ratelimit:ingest:"

// Limits is a tenant's token-bucket configuration: a sustained Rate (tokens, i.e.
// admitted requests, per second) and a Burst (bucket capacity). A non-positive
// Rate or Burst means "unlimited" — the limiter admits unconditionally, which is
// how a tenant is exempted via a 0 override.
type Limits struct {
	Rate  float64 // tokens refilled per second
	Burst float64 // maximum bucket capacity
}

// Unlimited reports whether these limits disable rate limiting (admit always).
func (l Limits) Unlimited() bool { return l.Rate <= 0 || l.Burst <= 0 }

// Decision is the outcome of an admission check.
type Decision struct {
	// Allowed is true when the request may proceed to publish.
	Allowed bool
	// RetryAfter is how long the client should wait before the next token is
	// available. It is meaningful only when Allowed is false.
	RetryAfter time.Duration
	// Limit is the bucket capacity (Burst) that produced this decision.
	Limit float64
	// Remaining is the tokens left in the bucket after this decision.
	Remaining float64
}

// Limiter is the admission port the rate-limit middleware depends on (DIP). It is
// small on purpose so tests drive a fake and the Redis adapter is swappable.
//
// tc leads the signature per the repo-wide tenant-first port convention; the
// implementation MUST derive its counter key from tc.TenantID and nothing else.
type Limiter interface {
	// Allow reports whether one request for tc may be admitted now. A non-nil
	// error means the limiter backend failed; the caller decides fail-open vs
	// fail-closed (the limiter does not impose that policy).
	Allow(tc kernel.TenantContext, ctx context.Context) (Decision, error)
}

// Resolver maps a tenant to its Limits. Keeping resolution behind an interface
// lets the default-plus-override map be swapped for a Redis/control-plane-backed
// source later without touching the limiter (DIP, ADR-0004 "per-tenant override").
type Resolver interface {
	Resolve(tc kernel.TenantContext) Limits
}

// bucketState is the persisted token-bucket position: fractional tokens remaining
// and the millisecond timestamp they were last refilled at.
type bucketState struct {
	tokens float64
	ts     int64 // unix millis
}

// take applies the token-bucket refill-then-take step for a single request and is
// the single source of truth for the admission math (the Lua script mirrors it).
// It is pure: callers supply the current state, the limits, the current time in
// millis, and how many tokens to take, and get the next state + Decision back.
func take(s bucketState, lim Limits, nowMs int64, n float64) (bucketState, Decision) {
	elapsed := nowMs - s.ts
	if elapsed < 0 {
		elapsed = 0 // clock skew: never refill backwards
	}
	s.tokens = math.Min(lim.Burst, s.tokens+(float64(elapsed)/1000.0)*lim.Rate)
	s.ts = nowMs

	if s.tokens >= n {
		s.tokens -= n
		return s, Decision{Allowed: true, Limit: lim.Burst, Remaining: s.tokens}
	}

	var retry time.Duration
	if lim.Rate > 0 {
		needed := n - s.tokens
		retry = time.Duration(math.Ceil(needed/lim.Rate*1000.0)) * time.Millisecond
	}
	return s, Decision{Allowed: false, RetryAfter: retry, Limit: lim.Burst, Remaining: s.tokens}
}

// bucketKey derives the Redis bucket key from the authenticated tenant. It fails
// closed if tc carries no valid tenant — a missing/invalid tenant never produces
// a key (and the caller must treat the error as deny / mis-ordered middleware).
func bucketKey(tc kernel.TenantContext) (string, error) {
	if err := tc.Valid(); err != nil {
		return "", err
	}
	return keyPrefix + string(tc.TenantID), nil
}
