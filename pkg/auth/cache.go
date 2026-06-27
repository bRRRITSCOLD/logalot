package auth

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// cacheKeyPrefix namespaces auth entries in the shared Redis instance (which also
// carries tail pub/sub and rate-limit keys). The keyID is appended verbatim.
const cacheKeyPrefix = "auth:key:"

// redisCache is the production authCache backed by go-redis with a fixed TTL.
type redisCache struct {
	rc  *redis.Client
	ttl time.Duration
}

// newRedisCache builds a redisCache. ttl is applied to every set (ADR-0007: 60s).
func newRedisCache(rc *redis.Client, ttl time.Duration) authCache {
	return &redisCache{rc: rc, ttl: ttl}
}

func cacheKey(keyID string) string { return cacheKeyPrefix + keyID }

// get returns the cached entry for keyID. A cache miss is (zero, false, nil) — it
// is NOT an error, so a cold cache simply falls through to Postgres.
func (c *redisCache) get(ctx context.Context, keyID string) (cacheEntry, bool, error) {
	raw, err := c.rc.Get(ctx, cacheKey(keyID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return cacheEntry{}, false, nil
	}
	if err != nil {
		return cacheEntry{}, false, err
	}
	var ent cacheEntry
	if err := json.Unmarshal(raw, &ent); err != nil {
		// A corrupt entry is treated as a miss (and best-effort deleted) rather
		// than failing auth.
		_ = c.rc.Del(ctx, cacheKey(keyID)).Err()
		return cacheEntry{}, false, nil
	}
	return ent, true, nil
}

// set stores ent under keyID with the configured TTL. Only validated keys are
// ever passed here (no negative caching), so the cache cannot be used to confirm
// the existence of an invalid/unknown key id.
func (c *redisCache) set(ctx context.Context, keyID string, ent cacheEntry) error {
	raw, err := json.Marshal(ent)
	if err != nil {
		return err
	}
	return c.rc.Set(ctx, cacheKey(keyID), raw, c.ttl).Err()
}

// del removes the cached entry for keyID (used by Revoke to bust the cache so a
// revoked key stops authenticating immediately rather than at TTL expiry).
func (c *redisCache) del(ctx context.Context, keyID string) error {
	return c.rc.Del(ctx, cacheKey(keyID)).Err()
}
