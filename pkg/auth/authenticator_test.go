package auth

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// --- test doubles -----------------------------------------------------------

const testTenantID = "00000000-0000-0000-0000-0000000000d1"

// fakeClock is a manually advanced clock shared by the authenticator and the
// fakeCache so cache-expiry and key-expiry are deterministic.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.Unix(1_700_000_000, 0)} }

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

// fakeResolver stands in for the RLS-armed Postgres lookup. It maps key id ->
// stored key and counts calls so tests can prove a cache hit skipped it.
type fakeResolver struct {
	keys  map[string]storedKey
	err   error
	calls int
}

func (r *fakeResolver) resolveKey(_ context.Context, _ string, keyID string) (storedKey, error) {
	r.calls++
	if r.err != nil {
		return storedKey{}, r.err
	}
	sk, ok := r.keys[keyID]
	if !ok {
		return storedKey{}, ErrUnknownKey
	}
	return sk, nil
}

// fakeCache honours a TTL against a shared clock so expiry is testable without
// real time. It records sets/dels for assertions.
type fakeCache struct {
	ttl     time.Duration
	clock   *fakeClock
	entries map[string]cachedAt
	sets    int
	dels    int
}

type cachedAt struct {
	ent   cacheEntry
	setAt time.Time
}

func newFakeCache(ttl time.Duration, clock *fakeClock) *fakeCache {
	return &fakeCache{ttl: ttl, clock: clock, entries: map[string]cachedAt{}}
}

func (c *fakeCache) get(_ context.Context, keyID string) (cacheEntry, bool, error) {
	e, ok := c.entries[keyID]
	if !ok {
		return cacheEntry{}, false, nil
	}
	if !c.clock.now().Before(e.setAt.Add(c.ttl)) {
		delete(c.entries, keyID) // expired
		return cacheEntry{}, false, nil
	}
	return e.ent, true, nil
}

func (c *fakeCache) set(_ context.Context, keyID string, ent cacheEntry) error {
	c.sets++
	c.entries[keyID] = cachedAt{ent: ent, setAt: c.clock.now()}
	return nil
}

func (c *fakeCache) del(_ context.Context, keyID string) error {
	c.dels++
	delete(c.entries, keyID)
	return nil
}

// harness wires an Authenticator over the fakes plus a known-good key.
type harness struct {
	auth     *Authenticator
	resolver *fakeResolver
	cache    *fakeCache
	clock    *fakeClock
	rawKey   string // a valid presented credential for the seeded key
}

func newHarness(t *testing.T, mutate func(sk *storedKey)) *harness {
	t.Helper()
	clock := newClock()
	const ttl = 60 * time.Second
	cache := newFakeCache(ttl, clock)

	// Build a valid key + its stored hash.
	const publicID, keyID, secret = "dev", "devkey001", "devsecret0123456789"
	raw := keyPrefix + "_" + publicID + "_" + keyID + "_" + secret
	sk := storedKey{
		KeyID:    keyID,
		TenantID: kernel.TenantID(testTenantID),
		KeyHash:  hashSecret(secret),
		Scopes:   []kernel.Scope{kernel.ScopeIngestWrite},
	}
	if mutate != nil {
		mutate(&sk)
	}
	resolver := &fakeResolver{keys: map[string]storedKey{keyID: sk}}

	cfg := resolveConfig(WithCacheTTL(ttl), WithClock(clock.now))
	auth := newAuthenticator(resolver, cache, cfg)
	return &harness{auth: auth, resolver: resolver, cache: cache, clock: clock, rawKey: raw}
}

func cred(raw string) kernel.Credential { return kernel.Credential{APIKey: raw} }

// --- tests ------------------------------------------------------------------

func TestAuthenticate_ValidKey_MissThenContext(t *testing.T) {
	h := newHarness(t, nil)
	tc, err := h.auth.Authenticate(context.Background(), cred(h.rawKey))
	if err != nil {
		t.Fatalf("Authenticate error = %v", err)
	}
	if tc.TenantID != kernel.TenantID(testTenantID) {
		t.Errorf("TenantID = %q", tc.TenantID)
	}
	if tc.PrincipalID != "devkey001" {
		t.Errorf("PrincipalID = %q, want devkey001", tc.PrincipalID)
	}
	if !tc.HasScope(kernel.ScopeIngestWrite) {
		t.Errorf("missing ingest:write scope: %+v", tc.Scopes)
	}
	if tc.Role != "" {
		t.Errorf("Role = %q, want empty (api keys are scope-authorized)", tc.Role)
	}
	if h.resolver.calls != 1 {
		t.Errorf("resolver calls = %d, want 1 (one miss)", h.resolver.calls)
	}
	if h.cache.sets != 1 {
		t.Errorf("cache sets = %d, want 1 (validated key cached)", h.cache.sets)
	}
}

func TestAuthenticate_CacheHit_SkipsResolver(t *testing.T) {
	h := newHarness(t, nil)
	// Prime the cache.
	if _, err := h.auth.Authenticate(context.Background(), cred(h.rawKey)); err != nil {
		t.Fatal(err)
	}
	// Second call within TTL must NOT touch the resolver.
	if _, err := h.auth.Authenticate(context.Background(), cred(h.rawKey)); err != nil {
		t.Fatal(err)
	}
	if h.resolver.calls != 1 {
		t.Fatalf("resolver calls = %d, want 1 (second served from cache)", h.resolver.calls)
	}
}

func TestAuthenticate_CacheExpiry_RefetchesAfterTTL(t *testing.T) {
	h := newHarness(t, nil)
	if _, err := h.auth.Authenticate(context.Background(), cred(h.rawKey)); err != nil {
		t.Fatal(err)
	}
	h.clock.advance(61 * time.Second) // past the 60s TTL
	if _, err := h.auth.Authenticate(context.Background(), cred(h.rawKey)); err != nil {
		t.Fatal(err)
	}
	if h.resolver.calls != 2 {
		t.Fatalf("resolver calls = %d, want 2 (cache expired -> refetch)", h.resolver.calls)
	}
}

func TestAuthenticate_CacheHit_StillVerifiesSecret(t *testing.T) {
	h := newHarness(t, nil)
	if _, err := h.auth.Authenticate(context.Background(), cred(h.rawKey)); err != nil {
		t.Fatal(err)
	}
	// Present the right keyID but a wrong secret — a cache hit must still reject.
	bad := keyPrefix + "_dev_devkey001_wrongsecretwrongsecret"
	if _, err := h.auth.Authenticate(context.Background(), cred(bad)); !errors.Is(err, ErrBadSecret) {
		t.Fatalf("err = %v, want ErrBadSecret on cache hit with wrong secret", err)
	}
}

func TestAuthenticate_WrongSecret_NotCached(t *testing.T) {
	h := newHarness(t, nil)
	bad := keyPrefix + "_dev_devkey001_nottherealsecretvalue"
	if _, err := h.auth.Authenticate(context.Background(), cred(bad)); !errors.Is(err, ErrBadSecret) {
		t.Fatalf("err = %v, want ErrBadSecret", err)
	}
	if h.cache.sets != 0 {
		t.Errorf("cache sets = %d, want 0 (failed auth must not cache)", h.cache.sets)
	}
}

func TestAuthenticate_Revoked(t *testing.T) {
	now := newClock().now()
	h := newHarness(t, func(sk *storedKey) { sk.RevokedAt = &now })
	if _, err := h.auth.Authenticate(context.Background(), cred(h.rawKey)); !errors.Is(err, ErrRevokedKey) {
		t.Fatalf("err = %v, want ErrRevokedKey", err)
	}
	if h.cache.sets != 0 {
		t.Errorf("revoked key was cached")
	}
}

func TestAuthenticate_Expired(t *testing.T) {
	h := newHarness(t, nil)
	past := h.clock.now().Add(-time.Hour)
	h.resolver.keys["devkey001"] = func() storedKey {
		sk := h.resolver.keys["devkey001"]
		sk.ExpiresAt = &past
		return sk
	}()
	if _, err := h.auth.Authenticate(context.Background(), cred(h.rawKey)); !errors.Is(err, ErrExpiredKey) {
		t.Fatalf("err = %v, want ErrExpiredKey", err)
	}
}

func TestAuthenticate_NotYetExpired_OK(t *testing.T) {
	h := newHarness(t, nil)
	future := h.clock.now().Add(time.Hour)
	sk := h.resolver.keys["devkey001"]
	sk.ExpiresAt = &future
	h.resolver.keys["devkey001"] = sk
	if _, err := h.auth.Authenticate(context.Background(), cred(h.rawKey)); err != nil {
		t.Fatalf("future-dated key should authenticate, got %v", err)
	}
}

func TestAuthenticate_Unknown(t *testing.T) {
	h := newHarness(t, nil)
	unknown := keyPrefix + "_dev_nosuchkey_somesecretvalue123456"
	if _, err := h.auth.Authenticate(context.Background(), cred(unknown)); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}
	if h.cache.sets != 0 {
		t.Errorf("unknown key created a cache entry (enumeration risk)")
	}
}

func TestAuthenticate_Malformed(t *testing.T) {
	h := newHarness(t, nil)
	if _, err := h.auth.Authenticate(context.Background(), cred("not-a-key")); !errors.Is(err, ErrMalformedKey) {
		t.Fatalf("err = %v, want ErrMalformedKey", err)
	}
	if h.resolver.calls != 0 {
		t.Errorf("malformed key hit the resolver (should fail before any DB work)")
	}
}

func TestAuthenticate_NoCredential(t *testing.T) {
	h := newHarness(t, nil)
	if _, err := h.auth.Authenticate(context.Background(), kernel.Credential{}); !errors.Is(err, ErrNoCredential) {
		t.Fatalf("err = %v, want ErrNoCredential", err)
	}
}
