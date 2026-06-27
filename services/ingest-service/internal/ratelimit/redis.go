package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/redis/go-redis/v9"
)

// tokenBucketScript is the atomic token-bucket step, run server-side so a
// concurrent burst across many ingest replicas can never over-admit (the
// HMGET → refill → take → HSET sequence is a single Redis operation). It mirrors
// the pure take() function exactly.
//
//	KEYS[1] = bucket hash key (ratelimit:ingest:<tenant_id>)
//	ARGV[1] = rate   (tokens per second)
//	ARGV[2] = burst  (bucket capacity)
//	ARGV[3] = now    (unix millis)
//	ARGV[4] = take   (tokens to consume, normally 1)
//
// Returns: { allowed (0|1), retry_after_ms, tokens_remaining_floor }.
//
// The bucket hash self-expires after the time it takes to fully refill from empty
// (+1s slack), so idle tenants leave no keys behind — no separate sweeper needed.
const tokenBucketScript = `
local key   = KEYS[1]
local rate  = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now   = tonumber(ARGV[3])
local take  = tonumber(ARGV[4])

local h = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(h[1])
local ts = tonumber(h[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + (elapsed / 1000.0) * rate)
ts = now

local allowed = 0
local retry_after = 0
if tokens >= take then
  tokens = tokens - take
  allowed = 1
else
  if rate > 0 then
    local needed = take - tokens
    retry_after = math.ceil((needed / rate) * 1000.0)
  end
end

redis.call('HSET', key, 'tokens', tokens, 'ts', ts)
local ttl = math.ceil((burst / rate) * 1000.0) + 1000
redis.call('PEXPIRE', key, ttl)

return {allowed, retry_after, math.floor(tokens)}
`

// RedisLimiter is the production Limiter: a per-tenant token bucket held in Redis
// and stepped by an atomic Lua script (ADR-0004). It is the correct backend for a
// horizontally-scaled ingest tier because all replicas share one bucket per
// tenant.
type RedisLimiter struct {
	rc       *redis.Client
	resolver Resolver
	script   *redis.Script
	now      func() time.Time
}

// RedisOption configures a RedisLimiter.
type RedisOption func(*RedisLimiter)

// WithRedisClock injects a clock for deterministic tests; defaults to time.Now.
func WithRedisClock(now func() time.Time) RedisOption {
	return func(r *RedisLimiter) { r.now = now }
}

// NewRedisLimiter builds a RedisLimiter over rc and resolver.
func NewRedisLimiter(rc *redis.Client, resolver Resolver, opts ...RedisOption) *RedisLimiter {
	r := &RedisLimiter{
		rc:       rc,
		resolver: resolver,
		script:   redis.NewScript(tokenBucketScript),
		now:      time.Now,
	}
	for _, o := range opts {
		o(r)
	}
	if r.now == nil {
		r.now = time.Now
	}
	return r
}

// Allow runs the atomic token-bucket step for tc. An error means Redis was
// unreachable or the script failed; the caller (middleware) decides fail-open vs
// fail-closed — Allow itself never silently admits on a backend error.
//
// tc is validated BEFORE the Unlimited short-circuit (issue #47): an exempted
// tenant (Rate=0:0) with a blank or invalid TenantContext must still fail
// closed rather than bypass the UUID validity check.
func (r *RedisLimiter) Allow(tc kernel.TenantContext, ctx context.Context) (Decision, error) {
	// Fail closed unconditionally on an invalid TenantContext BEFORE applying
	// any resolver exemption, so a malformed tc can never silently bypass limits.
	if err := tc.Valid(); err != nil {
		return Decision{}, err
	}
	lim := r.resolver.Resolve(tc)
	if lim.Unlimited() {
		return Decision{Allowed: true}, nil
	}
	key, err := bucketKey(tc)
	if err != nil {
		return Decision{}, err
	}
	nowMs := r.now().UnixMilli()

	res, err := r.script.Run(ctx, r.rc, []string{key}, lim.Rate, lim.Burst, nowMs, 1).Int64Slice()
	if err != nil {
		return Decision{}, fmt.Errorf("ratelimit: redis eval: %w", err)
	}
	if len(res) != 3 {
		return Decision{}, fmt.Errorf("ratelimit: unexpected script result arity %d", len(res))
	}

	d := Decision{
		Allowed:   res[0] == 1,
		Limit:     lim.Burst,
		Remaining: float64(res[2]),
	}
	if !d.Allowed {
		d.RetryAfter = time.Duration(res[1]) * time.Millisecond
	}
	return d, nil
}

// compile-time proof RedisLimiter satisfies the port.
var _ Limiter = (*RedisLimiter)(nil)
