import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisClient } from '../../src/adapters/redis/client';
import { RedisOAuthStateStore } from '../../src/adapters/redis/redis-oauth-state-store';
import type { OAuthStateRecord } from '../../src/app/ports';

// ── Docker-backed integration suite for RedisOAuthStateStore.
// Verifies:
//  (R4) store-side semantics — TTL, key prefix, serialisation round-trip
//  (R5) single-use — atomic GETDEL: exactly one concurrent caller wins

let container: StartedRedisContainer;
let redis: Redis;
let store: RedisOAuthStateStore;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = createRedisClient(container.getConnectionUrl());
  await redis.connect();
  store = new RedisOAuthStateStore(redis);
});

afterAll(async () => {
  await redis.quit();
  await container.stop();
});

function makeRecord(state: string): OAuthStateRecord {
  return {
    state,
    tenantId: 'tenant-integration',
    meta: { provider: 'google', redirectUri: 'https://app.example.com/callback' },
    createdAt: new Date().toISOString(),
  };
}

describe('RedisOAuthStateStore — integration', () => {
  describe('put + consume (round-trip)', () => {
    it('consume returns the full record that was put', async () => {
      const record = makeRecord('it-roundtrip-state');
      await store.put(record, 600);

      const result = await store.consume(record.state);
      expect(result).toEqual(record);
    });

    it('consume returns null for an unknown state', async () => {
      const result = await store.consume('no-such-key');
      expect(result).toBeNull();
    });
  });

  describe('single-use (R5)', () => {
    it('second consume of the same state returns null', async () => {
      const record = makeRecord('it-single-use-state');
      await store.put(record, 600);

      const first = await store.consume(record.state);
      const second = await store.consume(record.state);

      expect(first).toEqual(record);
      expect(second).toBeNull();
    });

    it('atomic consume under two concurrent callers — exactly one wins', async () => {
      // Two independent Redis clients to guarantee separate TCP connections
      // (ioredis multiplexes commands on a single connection, so we need a second
      // client to prove cross-connection atomicity).
      const redis2 = createRedisClient(container.getConnectionUrl());
      await redis2.connect();
      const store2 = new RedisOAuthStateStore(redis2);

      try {
        const record = makeRecord('it-concurrent-state');
        await store.put(record, 600);

        // Race both consume() calls simultaneously.
        const [r1, r2] = await Promise.all([
          store.consume(record.state),
          store2.consume(record.state),
        ]);

        // Exactly one must have the record; the other must be null.
        const winners = [r1, r2].filter(Boolean);
        const losers = [r1, r2].filter((r) => r === null);

        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(winners[0]).toEqual(record);
      } finally {
        await redis2.quit();
      }
    });
  });

  describe('TTL expiry (R4)', () => {
    it('consume returns null after the TTL expires', async () => {
      const record = makeRecord('it-ttl-state');
      // 1-second TTL — just long enough to set but expire quickly.
      await store.put(record, 1);

      // Verify the key exists immediately.
      const immediate = await store.consume(record.state);
      expect(immediate).toEqual(record);

      // Put again, wait for expiry.
      await store.put(record, 1);
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const afterExpiry = await store.consume(record.state);
      expect(afterExpiry).toBeNull();
    });
  });

  describe('key isolation', () => {
    it('consuming one state does not affect another', async () => {
      const r1 = makeRecord('it-isolation-a');
      const r2 = makeRecord('it-isolation-b');
      await store.put(r1, 600);
      await store.put(r2, 600);

      await store.consume('it-isolation-a');

      const result = await store.consume('it-isolation-b');
      expect(result).toEqual(r2);
    });
  });
});
