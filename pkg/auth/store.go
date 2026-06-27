package auth

import (
	"context"
	"errors"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// pgStore is the Postgres-backed keyResolver. It connects via a pool that MUST
// use the NOSUPERUSER logalot_app role so FORCE ROW LEVEL SECURITY governs the
// scoped key lookup (migration 000011, model.md §4.2).
type pgStore struct {
	pool *pgxpool.Pool
}

// keyColumns is the single source of truth for the api_keys projection used by
// both resolveKey and KeyStore.Lookup (DRY).
const keyColumns = `id, tenant_id, key_hash, scopes, revoked_at, expires_at`

// resolveTenantID maps a tenant slug (tenants.public_id) to its uuid, requiring
// an ACTIVE tenant. tenants carries no RLS (registry table), so this runs without
// a tenant context — it is the step that PRODUCES the tenant scope used to arm
// RLS for the subsequent key lookup. An unknown/suspended tenant collapses to
// ErrUnknownKey (no distinct oracle).
func (s *pgStore) resolveTenantID(ctx context.Context, publicID string) (kernel.TenantID, error) {
	var id string
	err := s.pool.QueryRow(ctx,
		`SELECT id::text FROM tenants WHERE public_id = $1 AND status = 'active'`,
		publicID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUnknownKey
	}
	if err != nil {
		return "", err
	}
	return kernel.TenantID(id), nil
}

// resolveKey implements the ADR-0007 / model.md §4.5 resolution: slug -> tenant
// (no RLS), then a transaction that arms RLS via the kernel convention BEFORE the
// scoped SELECT by key id. Because RLS is armed for the slug's tenant, a key id
// that belongs to a DIFFERENT tenant returns zero rows (ErrUnknownKey) — the
// lookup is itself tenant-isolated, which is what the cross-tenant test proves.
func (s *pgStore) resolveKey(ctx context.Context, publicID, keyID string) (storedKey, error) {
	tid, err := s.resolveTenantID(ctx, publicID)
	if err != nil {
		return storedKey{}, err
	}

	tc := kernel.TenantContext{TenantID: tid}

	var sk storedKey
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		return kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
			loaded, lerr := scanKey(tx.QueryRow(ctx,
				`SELECT `+keyColumns+` FROM api_keys WHERE id = $1`, keyID))
			if lerr != nil {
				return lerr
			}
			sk = loaded
			return nil
		})
	})
	if err != nil {
		return storedKey{}, err
	}
	return sk, nil
}

// inTx runs fn inside a transaction, committing on success and rolling back on
// error. Arming RLS with SET LOCAL is only transaction-scoped, so the arm and the
// scoped query MUST share one tx (kernel postgres.go).
func (s *pgStore) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

// execOf adapts a pgx.Tx to the kernel.ExecFunc the RLS-arming convention needs.
func execOf(tx pgx.Tx) kernel.ExecFunc {
	return func(ctx context.Context, sql string, args ...any) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}
}

// scanKey reads one api_keys row into a storedKey. A missing row is mapped to
// ErrUnknownKey (the RLS fail-closed zero-rows case lands here too).
func scanKey(row pgx.Row) (storedKey, error) {
	var (
		sk        storedKey
		tenantID  string
		scopes    []string
		revokedAt *time.Time
		expiresAt *time.Time
	)
	err := row.Scan(&sk.KeyID, &tenantID, &sk.KeyHash, &scopes, &revokedAt, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedKey{}, ErrUnknownKey
	}
	if err != nil {
		return storedKey{}, err
	}
	sk.TenantID = kernel.TenantID(tenantID)
	sk.Scopes = toScopes(scopes)
	sk.RevokedAt = revokedAt
	sk.ExpiresAt = expiresAt
	return sk, nil
}

// toScopes converts the text[] scopes column into kernel.Scope values.
func toScopes(raw []string) []kernel.Scope {
	if len(raw) == 0 {
		return nil
	}
	scopes := make([]kernel.Scope, len(raw))
	for i, s := range raw {
		scopes[i] = kernel.Scope(s)
	}
	return scopes
}

// --- KeyStore (kernel.KeyStore) --------------------------------------------

// KeyStore is the concrete kernel.KeyStore: tenant-scoped reads and revocation of
// ingest keys. Revoke also busts the auth cache so a revoked key stops
// authenticating immediately (ahead of the 60s TTL).
type KeyStore struct {
	store *pgStore
	cache authCache
}

var _ kernel.KeyStore = (*KeyStore)(nil)

// NewKeyStore wires a KeyStore over the same pool and Redis client the
// Authenticator uses, so Revoke can bust the shared cache.
func NewKeyStore(pool *pgxpool.Pool, rc *redis.Client, ttl time.Duration) *KeyStore {
	return &KeyStore{store: &pgStore{pool: pool}, cache: newRedisCache(rc, ttl)}
}

// Lookup returns the stored record for keyID within tc's tenant scope. It arms
// RLS from tc, so a foreign-tenant key id is invisible (ErrUnknownKey).
func (k *KeyStore) Lookup(tc kernel.TenantContext, ctx context.Context, keyID string) (kernel.APIKey, error) {
	var out kernel.APIKey
	err := k.store.inTx(ctx, func(tx pgx.Tx) error {
		return kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
			sk, lerr := scanKey(tx.QueryRow(ctx,
				`SELECT `+keyColumns+` FROM api_keys WHERE id = $1`, keyID))
			if lerr != nil {
				return lerr
			}
			out = kernel.APIKey{
				ID:        sk.KeyID,
				TenantID:  sk.TenantID,
				Scopes:    sk.Scopes,
				Hash:      sk.KeyHash,
				RevokedAt: sk.RevokedAt,
			}
			return nil
		})
	})
	if err != nil {
		return kernel.APIKey{}, err
	}
	return out, nil
}

// Revoke marks keyID revoked within tc's tenant scope and busts the auth cache so
// the key stops authenticating immediately. The cache del is best-effort: a
// cache failure still leaves the DB row revoked (worst case: the key keeps
// authenticating from cache until the 60s TTL — the documented bound).
func (k *KeyStore) Revoke(tc kernel.TenantContext, ctx context.Context, keyID string) error {
	err := k.store.inTx(ctx, func(tx pgx.Tx) error {
		return kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
			_, eerr := tx.Exec(ctx,
				`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, keyID)
			return eerr
		})
	})
	if err != nil {
		return err
	}
	// Bust the cache so the revoked key stops authenticating immediately. This is
	// best-effort: if it fails the row is still revoked and the cached entry
	// expires within the 60s TTL bound (the documented worst case).
	_ = k.cache.del(ctx, keyID)
	return nil
}
