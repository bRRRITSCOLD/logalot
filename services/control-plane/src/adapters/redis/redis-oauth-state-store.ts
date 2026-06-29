import type Redis from 'ioredis';
import type { OAuthStateRecord, OAuthStateStore } from '../../app/ports';

// Key prefix avoids collisions if the Redis instance is shared with other
// subsystems (rate-limiter, pub/sub, etc.).
const KEY_PREFIX = 'oauth:state:';

// RedisOAuthStateStore is the production adapter backed by Redis.
//
// Single-use atomicity is provided by the GETDEL command (Redis ≥ 6.2) which
// atomically returns the value and deletes the key in a single round-trip — no
// Lua script or WATCH/MULTI is needed. Two concurrent callers racing on the same
// state key will have exactly one succeed (gets the record) and one get null
// (key already gone).
//
// TTL is set with SET … EX at write time so Redis expires stale records
// automatically even if consume() is never called (e.g. the user abandons the
// OAuth flow). The store holds the JSON-serialised OAuthStateRecord.

export class RedisOAuthStateStore implements OAuthStateStore {
  constructor(private readonly redis: Redis) {}

  async put(record: OAuthStateRecord, ttlSeconds: number): Promise<void> {
    const key = KEY_PREFIX + record.state;
    await this.redis.set(key, JSON.stringify(record), 'EX', ttlSeconds);
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const key = KEY_PREFIX + state;
    // GETDEL is atomic: retrieve + delete in one command (Redis ≥ 6.2).
    const raw = await this.redis.getdel(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthStateRecord;
    } catch {
      // Corrupt value — treat as absent and surface nothing to the caller.
      return null;
    }
  }
}
