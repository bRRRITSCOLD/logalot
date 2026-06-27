package ratelimit

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const (
	tenantA = kernel.TenantID("11111111-1111-1111-1111-111111111111")
	tenantB = kernel.TenantID("22222222-2222-2222-2222-222222222222")
)

func tc(id kernel.TenantID) kernel.TenantContext {
	return kernel.TenantContext{TenantID: id, Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}
}

// fakeClock is a manually-advanced clock for deterministic refill tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 6, 27, 0, 0, 0, 0, time.UTC)}
}
func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func TestTake_PureMath(t *testing.T) {
	lim := Limits{Rate: 10, Burst: 5}
	base := int64(1_000_000)

	t.Run("admits while tokens remain, then denies with retry-after", func(t *testing.T) {
		s := bucketState{tokens: lim.Burst, ts: base}
		// 5 takes drain the full bucket (no time advances).
		for i := 1; i <= 5; i++ {
			var d Decision
			s, d = take(s, lim, base, 1)
			if !d.Allowed {
				t.Fatalf("take %d: denied, want allowed (remaining=%v)", i, d.Remaining)
			}
		}
		// 6th has no token and time has not advanced.
		_, d := take(s, lim, base, 1)
		if d.Allowed {
			t.Fatalf("take 6: allowed, want denied")
		}
		// Need 1 token at 10/s => 100ms.
		if d.RetryAfter != 100*time.Millisecond {
			t.Fatalf("retry-after=%v, want 100ms", d.RetryAfter)
		}
	})

	t.Run("refills over time and caps at burst", func(t *testing.T) {
		s := bucketState{tokens: 0, ts: base}
		// 200ms at 10/s => +2 tokens.
		s, d := take(s, lim, base+200, 1)
		if !d.Allowed {
			t.Fatalf("after 200ms refill: denied, want allowed")
		}
		if d.Remaining != 1 { // 2 refilled - 1 taken
			t.Fatalf("remaining=%v, want 1", d.Remaining)
		}
		// A long gap must cap at Burst, not overflow.
		_, d = take(s, lim, base+10_000, 1)
		if d.Remaining != lim.Burst-1 {
			t.Fatalf("remaining=%v, want %v (capped at burst)", d.Remaining, lim.Burst-1)
		}
	})

	t.Run("ignores backward clock skew", func(t *testing.T) {
		s := bucketState{tokens: 2, ts: base}
		_, d := take(s, lim, base-5_000, 1) // clock went backwards
		if d.Remaining != 1 {               // no refill, just the take
			t.Fatalf("remaining=%v, want 1 (no negative refill)", d.Remaining)
		}
	})
}

func TestMemoryLimiter_AllowsBurstThenDenies(t *testing.T) {
	clk := newClock()
	r := NewStaticResolver(Limits{Rate: 10, Burst: 5}, nil)
	lim := NewMemoryLimiter(r, WithMemoryClock(clk.now))

	for i := 1; i <= 5; i++ {
		d, err := lim.Allow(tc(tenantA), context.Background())
		if err != nil {
			t.Fatalf("allow %d: %v", i, err)
		}
		if !d.Allowed {
			t.Fatalf("request %d denied, want allowed (burst=5)", i)
		}
	}
	d, err := lim.Allow(tc(tenantA), context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if d.Allowed {
		t.Fatal("6th request allowed, want denied (over burst)")
	}
	if d.RetryAfter <= 0 {
		t.Fatalf("retry-after=%v, want > 0 on denial", d.RetryAfter)
	}
}

func TestMemoryLimiter_WindowResets(t *testing.T) {
	clk := newClock()
	r := NewStaticResolver(Limits{Rate: 10, Burst: 5}, nil)
	lim := NewMemoryLimiter(r, WithMemoryClock(clk.now))

	for i := 0; i < 5; i++ {
		_, _ = lim.Allow(tc(tenantA), context.Background())
	}
	if d, _ := lim.Allow(tc(tenantA), context.Background()); d.Allowed {
		t.Fatal("expected exhaustion before reset")
	}
	// Advance enough to fully refill (burst/rate = 0.5s).
	clk.advance(time.Second)
	if d, _ := lim.Allow(tc(tenantA), context.Background()); !d.Allowed {
		t.Fatal("after refill window the request must be admitted again")
	}
}

// The load-bearing isolation test: tenant A exhausting its bucket must not affect
// tenant B's independent bucket.
func TestMemoryLimiter_PerTenantIsolation(t *testing.T) {
	clk := newClock()
	r := NewStaticResolver(Limits{Rate: 1, Burst: 3}, nil)
	lim := NewMemoryLimiter(r, WithMemoryClock(clk.now))

	// Drain tenant A completely.
	for i := 0; i < 3; i++ {
		if d, _ := lim.Allow(tc(tenantA), context.Background()); !d.Allowed {
			t.Fatalf("tenant A request %d should be admitted within burst", i)
		}
	}
	if d, _ := lim.Allow(tc(tenantA), context.Background()); d.Allowed {
		t.Fatal("tenant A should now be throttled")
	}

	// Tenant B's bucket is untouched: its full burst must be available.
	for i := 0; i < 3; i++ {
		d, _ := lim.Allow(tc(tenantB), context.Background())
		if !d.Allowed {
			t.Fatalf("tenant B request %d throttled — buckets are NOT isolated", i)
		}
	}
}

func TestMemoryLimiter_UnlimitedAdmitsAlways(t *testing.T) {
	r := NewStaticResolver(Limits{Rate: 0, Burst: 0}, nil)
	lim := NewMemoryLimiter(r)
	for i := 0; i < 100; i++ {
		if d, _ := lim.Allow(tc(tenantA), context.Background()); !d.Allowed {
			t.Fatalf("unlimited tenant denied at request %d", i)
		}
	}
}

func TestMemoryLimiter_InvalidTenantFailsClosed(t *testing.T) {
	r := NewStaticResolver(Limits{Rate: 10, Burst: 5}, nil)
	lim := NewMemoryLimiter(r)
	_, err := lim.Allow(kernel.TenantContext{}, context.Background())
	if err == nil {
		t.Fatal("blank tenant must error (fail closed), got nil")
	}
}

// TestMemoryLimiter_InvalidTenantFailsClosed_EvenWhenUnlimited asserts the
// issue-#47 invariant: tc.Valid() is called BEFORE the Unlimited() short-
// circuit, so an exempted (0:0) resolver still rejects an invalid tenant.
func TestMemoryLimiter_InvalidTenantFailsClosed_EvenWhenUnlimited(t *testing.T) {
	// Rate=0:0 → Unlimited() is true for any tenant that resolves to this.
	r := NewStaticResolver(Limits{Rate: 0, Burst: 0}, nil)
	lim := NewMemoryLimiter(r)
	_, err := lim.Allow(kernel.TenantContext{}, context.Background())
	if err == nil {
		t.Fatal("invalid tenant must error (fail closed) even when the resolver returns Unlimited")
	}
}

// TestRedisLimiter_InvalidTenantFailsClosed_EvenWhenUnlimited mirrors the above
// for RedisLimiter. The nil Redis client is safe because the validation error
// fires before any Redis call.
func TestRedisLimiter_InvalidTenantFailsClosed_EvenWhenUnlimited(t *testing.T) {
	r := NewStaticResolver(Limits{Rate: 0, Burst: 0}, nil)
	lim := NewRedisLimiter(nil, r) // nil client: never reached due to early validation
	_, err := lim.Allow(kernel.TenantContext{}, context.Background())
	if err == nil {
		t.Fatal("invalid tenant must error (fail closed) even when the resolver returns Unlimited")
	}
}

func TestStaticResolver_DefaultAndOverride(t *testing.T) {
	def := Limits{Rate: 100, Burst: 200}
	override := Limits{Rate: 5, Burst: 5}
	r := NewStaticResolver(def, map[kernel.TenantID]Limits{tenantB: override})

	if got := r.Resolve(tc(tenantA)); got != def {
		t.Errorf("tenant A limits=%+v, want default %+v", got, def)
	}
	if got := r.Resolve(tc(tenantB)); got != override {
		t.Errorf("tenant B limits=%+v, want override %+v", got, override)
	}
}

func TestParseOverrides(t *testing.T) {
	t.Run("blank yields empty", func(t *testing.T) {
		m, err := ParseOverrides("  ")
		if err != nil || len(m) != 0 {
			t.Fatalf("got %v, %v; want empty, nil", m, err)
		}
	})
	t.Run("parses multiple entries", func(t *testing.T) {
		in := string(tenantA) + "=2000:4000, " + string(tenantB) + "=0:0"
		m, err := ParseOverrides(in)
		if err != nil {
			t.Fatal(err)
		}
		if m[tenantA] != (Limits{Rate: 2000, Burst: 4000}) {
			t.Errorf("tenantA=%+v", m[tenantA])
		}
		if !m[tenantB].Unlimited() {
			t.Errorf("tenantB should be unlimited (0:0), got %+v", m[tenantB])
		}
	})
	t.Run("rejects malformed", func(t *testing.T) {
		for _, bad := range []string{
			"not-a-uuid=1:2",
			string(tenantA) + "=oops",
			string(tenantA) + "=1",
			string(tenantA) + "=x:2",
			string(tenantA),
		} {
			if _, err := ParseOverrides(bad); err == nil {
				t.Errorf("ParseOverrides(%q) = nil err, want error", bad)
			}
		}
	})
}
