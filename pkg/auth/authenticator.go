package auth

import (
	"context"
	"io"
	"log/slog"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// DefaultCacheTTL is the validated-key cache lifetime (ADR-0007: 60s). It bounds
// revocation propagation lag: a revoked key may keep authenticating from cache
// for up to this long unless the cache entry is busted explicitly (Revoke does
// bust it; see KeyStore.Revoke).
const DefaultCacheTTL = 60 * time.Second

// storedKey is the package-internal projection of an api_keys row used during
// resolution. The kernel.APIKey port type intentionally omits ExpiresAt, so the
// adapter carries the extra fields it needs here rather than widening the port.
type storedKey struct {
	KeyID     string
	TenantID  kernel.TenantID
	KeyHash   []byte
	Scopes    []kernel.Scope
	RevokedAt *time.Time
	ExpiresAt *time.Time
}

// keyResolver is the DB-backed port the Authenticator uses on a cache miss. It
// owns the security-critical resolution: parse the tenant slug FIRST, arm RLS
// (SET LOCAL app.tenant_id), then run the tenant-scoped SELECT by key id, so the
// lookup itself is tenant-isolated (model.md §4.5). Injecting it behind an
// interface lets unit tests exercise the cache/compare/expiry logic without a
// database, while the integration tests prove the real RLS behaviour.
type keyResolver interface {
	resolveKey(ctx context.Context, publicID, keyID string) (storedKey, error)
}

// cacheEntry is what we persist for a VALIDATED key. It includes KeyHash so the
// presented secret is re-verified (constant time) on every cache hit — a cache
// hit skips Postgres, NOT the secret check. KeyHash is the SHA-256 of a
// high-entropy secret (irreversible), so caching it is not a secret disclosure.
// Only successful validations are ever cached (no negative caching), so revoked
// state is not represented here.
//
// ExpiresAt is stored so a key that expires WITHIN the 60 s cache TTL is still
// rejected on the cache-hit path: without it a key would keep authenticating
// from cache until the entry itself expired, up to 60 s after the key's own
// ExpiresAt (issue #33).
type cacheEntry struct {
	TenantID    kernel.TenantID    `json:"tenant_id"`
	PrincipalID kernel.PrincipalID `json:"principal_id"`
	Scopes      []kernel.Scope     `json:"scopes"`
	KeyHash     []byte             `json:"key_hash"`
	ExpiresAt   *time.Time         `json:"expires_at,omitempty"`
}

// authCache is the 60s validated-key cache port (Redis in production, a fake in
// unit tests). All methods are best-effort from the Authenticator's perspective:
// a cache error degrades to a Postgres round-trip, never to a failed auth.
type authCache interface {
	get(ctx context.Context, keyID string) (cacheEntry, bool, error)
	set(ctx context.Context, keyID string, ent cacheEntry) error
	del(ctx context.Context, keyID string) error
}

// Authenticator is the concrete kernel.Authenticator for ingest API keys. It is
// shared by ingest-service (#6) and query-service (#8).
type Authenticator struct {
	keys  keyResolver
	cache authCache
	now   func() time.Time
	log   *slog.Logger
}

// compile-time proof the adapter satisfies the kernel port.
var _ kernel.Authenticator = (*Authenticator)(nil)

// Option configures an Authenticator.
type Option func(*authConfig)

type authConfig struct {
	ttl time.Duration
	now func() time.Time
	log *slog.Logger
}

// WithCacheTTL overrides the validated-key cache TTL (default DefaultCacheTTL).
func WithCacheTTL(d time.Duration) Option {
	return func(c *authConfig) { c.ttl = d }
}

// WithClock injects a clock for deterministic expiry tests. Defaults to time.Now.
func WithClock(now func() time.Time) Option {
	return func(c *authConfig) { c.now = now }
}

// WithLogger sets the structured logger. Defaults to a discard logger so the
// library is silent unless the host opts in.
func WithLogger(l *slog.Logger) Option {
	return func(c *authConfig) { c.log = l }
}

func resolveConfig(opts ...Option) authConfig {
	cfg := authConfig{
		ttl: DefaultCacheTTL,
		now: time.Now,
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.ttl <= 0 {
		cfg.ttl = DefaultCacheTTL
	}
	if cfg.now == nil {
		cfg.now = time.Now
	}
	if cfg.log == nil {
		cfg.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return cfg
}

// New wires a production Authenticator over a pgx pool (connected as logalot_app)
// and a Redis client. The pool MUST use the NOSUPERUSER app role or RLS will not
// bite (see platform.AppDatabaseURL).
func New(pool *pgxpool.Pool, rc *redis.Client, opts ...Option) *Authenticator {
	cfg := resolveConfig(opts...)
	return newAuthenticator(
		&pgStore{pool: pool},
		newRedisCache(rc, cfg.ttl),
		cfg,
	)
}

// newAuthenticator is the internal constructor used by both New and the unit
// tests (which inject fakes for keys/cache).
func newAuthenticator(keys keyResolver, cache authCache, cfg authConfig) *Authenticator {
	return &Authenticator{keys: keys, cache: cache, now: cfg.now, log: cfg.log}
}

// Authenticate verifies a presented ingest API key and yields the TenantContext
// that drives downstream isolation. It has no tc parameter ON PURPOSE — it is the
// boundary that establishes tenancy (kernel ports.go, fitness allow-list).
//
// Flow (ADR-0007, model.md §4.5):
//  1. require + parse the key (shape only; no DB) — fail closed on malformed.
//  2. cache hit: re-verify the secret (constant time) against the cached hash and
//     return; this skips Postgres but NOT the secret check.
//  3. cache miss: resolve slug -> tenant_id, ARM RLS, scoped SELECT by key id
//     (the lookup runs inside the tenant boundary), constant-time compare, then
//     reject revoked/expired; cache only on success.
func (a *Authenticator) Authenticate(ctx context.Context, cred kernel.Credential) (kernel.TenantContext, error) {
	if cred.APIKey == "" {
		return kernel.TenantContext{}, ErrNoCredential
	}
	pk, err := parseKey(cred.APIKey)
	if err != nil {
		return kernel.TenantContext{}, err
	}
	secretHash := pk.SecretHash()

	// 1) Cache hit path — skips Postgres, still verifies the secret.
	if ent, ok, cerr := a.cache.get(ctx, pk.KeyID); cerr != nil {
		a.log.WarnContext(ctx, "auth cache get failed; falling back to postgres", "err", cerr)
	} else if ok {
		if !constantTimeEqual(secretHash, ent.KeyHash) {
			return kernel.TenantContext{}, ErrBadSecret
		}
		// Enforce expiry within the cache TTL window (issue #33): a key can
		// expire while its cache entry is still live. Bust the entry on expiry so
		// the next request falls through to Postgres and gets a fresh rejection.
		if ent.ExpiresAt != nil && !a.now().Before(*ent.ExpiresAt) {
			_ = a.cache.del(ctx, pk.KeyID)
			return kernel.TenantContext{}, ErrExpiredKey
		}
		return tenantContextFrom(ent.TenantID, ent.PrincipalID, ent.Scopes)
	}

	// 2) Cache miss path — RLS-armed scoped lookup.
	sk, err := a.keys.resolveKey(ctx, pk.PublicID, pk.KeyID)
	if err != nil {
		return kernel.TenantContext{}, err
	}
	// Verify the secret BEFORE leaking any lifecycle state, so revoked/expired
	// status is only knowable to a holder of the correct secret.
	if !constantTimeEqual(secretHash, sk.KeyHash) {
		return kernel.TenantContext{}, ErrBadSecret
	}
	if sk.RevokedAt != nil {
		return kernel.TenantContext{}, ErrRevokedKey
	}
	if sk.ExpiresAt != nil && !a.now().Before(*sk.ExpiresAt) {
		return kernel.TenantContext{}, ErrExpiredKey
	}

	ent := cacheEntry{
		TenantID:    sk.TenantID,
		PrincipalID: kernel.PrincipalID(sk.KeyID),
		Scopes:      sk.Scopes,
		KeyHash:     sk.KeyHash,
		ExpiresAt:   sk.ExpiresAt, // propagated so cache-hit path can enforce expiry (#33)
	}
	if cerr := a.cache.set(ctx, pk.KeyID, ent); cerr != nil {
		// Caching is an optimization; a failure must not fail authentication.
		a.log.WarnContext(ctx, "auth cache set failed", "err", cerr)
	}
	return tenantContextFrom(ent.TenantID, ent.PrincipalID, ent.Scopes)
}

// tenantContextFrom builds the TenantContext for a validated key. Role is left
// empty: an ingest API key is a machine principal authorized by SCOPE
// (ingest:write), not by an RBAC role (ADR-0007 — roles are for human users).
// Valid() is asserted as a fail-closed backstop against a malformed stored
// tenant_id.
func tenantContextFrom(tid kernel.TenantID, pid kernel.PrincipalID, scopes []kernel.Scope) (kernel.TenantContext, error) {
	tc := kernel.TenantContext{
		TenantID:    tid,
		PrincipalID: pid,
		Scopes:      scopes,
	}
	if err := tc.Valid(); err != nil {
		return kernel.TenantContext{}, err
	}
	return tc, nil
}
