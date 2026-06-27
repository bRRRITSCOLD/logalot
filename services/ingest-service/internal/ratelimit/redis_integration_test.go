//go:build integration

// Redis-backed rate-limiter integration tests. They run against a REAL Redis in a
// random-port testcontainer (the host runs a conflicting `burrow` redis on 6379,
// so a fixed port is avoided). Gated behind the `integration` build tag so the
// default `go test ./...` stays fast and Docker-free; run with:
//
//	go test -tags=integration ./...
//
// These prove what the in-memory fake cannot: the actual Lua token-bucket script
// admits a burst then 429-equivalents (denies), refills over real wall-clock time,
// keeps per-tenant buckets independent, and self-expires idle buckets via TTL.
package ratelimit

import (
	"context"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/redis/go-redis/v9"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

func startRedis(t *testing.T) *redis.Client {
	t.Helper()
	ctx := context.Background()
	c, err := tcredis.Run(ctx, "redis:7")
	if err != nil {
		t.Fatalf("start redis: %v", err)
	}
	t.Cleanup(func() { _ = c.Terminate(ctx) })
	host, _ := c.Host(ctx)
	port, _ := c.MappedPort(ctx, "6379/tcp")
	rc, err := platform.NewRedisClient(ctx, platform.RedisConfig{Addr: host + ":" + port.Port()})
	if err != nil {
		t.Fatalf("redis client: %v", err)
	}
	t.Cleanup(func() { _ = rc.Close() })
	return rc
}

func TestIntegration_RedisLimiter_BurstThenDeny(t *testing.T) {
	rc := startRedis(t)
	clk := newClock()
	r := NewStaticResolver(Limits{Rate: 10, Burst: 5}, nil)
	lim := NewRedisLimiter(rc, r, WithRedisClock(clk.now))
	ctx := context.Background()

	for i := 1; i <= 5; i++ {
		d, err := lim.Allow(tc(tenantA), ctx)
		if err != nil {
			t.Fatalf("allow %d: %v", i, err)
		}
		if !d.Allowed {
			t.Fatalf("request %d denied, want allowed within burst", i)
		}
	}
	d, err := lim.Allow(tc(tenantA), ctx)
	if err != nil {
		t.Fatal(err)
	}
	if d.Allowed {
		t.Fatal("6th request allowed, want denied (over burst)")
	}
	if d.RetryAfter <= 0 {
		t.Fatalf("retry-after=%v, want > 0", d.RetryAfter)
	}

	// Refill via the injected clock: +1s at 10/s fully refills the 5-token bucket.
	clk.advance(time.Second)
	if d, _ := lim.Allow(tc(tenantA), ctx); !d.Allowed {
		t.Fatal("after 1s refill the request must be admitted again")
	}
}

func TestIntegration_RedisLimiter_PerTenantIsolation(t *testing.T) {
	rc := startRedis(t)
	r := NewStaticResolver(Limits{Rate: 1, Burst: 3}, nil)
	lim := NewRedisLimiter(rc, r)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if d, _ := lim.Allow(tc(tenantA), ctx); !d.Allowed {
			t.Fatalf("tenant A request %d should be admitted within burst", i)
		}
	}
	if d, _ := lim.Allow(tc(tenantA), ctx); d.Allowed {
		t.Fatal("tenant A should be throttled after draining its burst")
	}
	// Tenant B has its own key/bucket; its burst must be fully available.
	for i := 0; i < 3; i++ {
		if d, _ := lim.Allow(tc(tenantB), ctx); !d.Allowed {
			t.Fatalf("tenant B request %d throttled — Redis buckets are NOT isolated", i)
		}
	}
}

func TestIntegration_RedisLimiter_BucketHasTTL(t *testing.T) {
	rc := startRedis(t)
	r := NewStaticResolver(Limits{Rate: 10, Burst: 5}, nil)
	lim := NewRedisLimiter(rc, r)
	ctx := context.Background()

	if _, err := lim.Allow(tc(tenantA), ctx); err != nil {
		t.Fatal(err)
	}
	key := keyPrefix + string(tenantA)
	ttl, err := rc.PTTL(ctx, key).Result()
	if err != nil {
		t.Fatal(err)
	}
	// burst/rate = 0.5s, +1s slack => ~1.5s TTL set; must be positive and bounded.
	if ttl <= 0 {
		t.Fatalf("bucket TTL=%v, want a positive expiry so idle buckets self-clean", ttl)
	}
	if ttl > 10*time.Second {
		t.Fatalf("bucket TTL=%v, unexpectedly large for burst/rate=0.5s", ttl)
	}
}

func TestIntegration_RedisLimiter_AtomicNoOverAdmit(t *testing.T) {
	rc := startRedis(t)
	r := NewStaticResolver(Limits{Rate: 0.0001, Burst: 50}, nil) // negligible refill
	lim := NewRedisLimiter(rc, r)
	ctx := context.Background()

	const concurrent = 200
	results := make(chan bool, concurrent)
	for i := 0; i < concurrent; i++ {
		go func() {
			d, err := lim.Allow(tc(tenantA), ctx)
			results <- err == nil && d.Allowed
		}()
	}
	admitted := 0
	for i := 0; i < concurrent; i++ {
		if <-results {
			admitted++
		}
	}
	// With an atomic script and ~no refill, exactly burst (50) requests admit even
	// under 200 concurrent callers — proving no over-admission race.
	if admitted != 50 {
		t.Fatalf("admitted=%d under concurrency, want exactly 50 (burst) — over/under-admit race", admitted)
	}
}
