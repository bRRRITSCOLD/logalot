import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryOAuthStateStore } from '../../src/adapters/redis/in-memory-oauth-state-store';
import type { OAuthStateRecord } from '../../src/app/ports';

function makeRecord(overrides?: Partial<OAuthStateRecord>): OAuthStateRecord {
  return {
    state: 'test-state-abc123',
    tenantId: 'tenant-uuid',
    meta: { provider: 'google', redirectUri: 'http://localhost:3000/callback' },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('InMemoryOAuthStateStore', () => {
  let store: InMemoryOAuthStateStore;

  beforeEach(() => {
    store = new InMemoryOAuthStateStore();
  });

  describe('put + consume (happy path)', () => {
    it('consume returns the record that was put', async () => {
      const record = makeRecord();
      await store.put(record, 600);

      const result = await store.consume(record.state);
      expect(result).toEqual(record);
    });

    it('consume is single-use — second call returns null', async () => {
      const record = makeRecord({ state: 'single-use-state' });
      await store.put(record, 600);

      const first = await store.consume(record.state);
      const second = await store.consume(record.state);

      expect(first).toEqual(record);
      expect(second).toBeNull();
    });

    it('consume returns null for an unknown state', async () => {
      const result = await store.consume('nonexistent-state');
      expect(result).toBeNull();
    });
  });

  describe('TTL expiry', () => {
    it('consume returns null after the entry is expired', async () => {
      const record = makeRecord({ state: 'expiring-state' });
      await store.put(record, 600);

      // Force-expire using the test helper.
      store._expire(record.state);

      const result = await store.consume(record.state);
      expect(result).toBeNull();
    });

    it('expired entry is removed from the store on consume', async () => {
      const record = makeRecord({ state: 'cleanup-state' });
      await store.put(record, 600);
      store._expire(record.state);

      await store.consume(record.state); // triggers lazy cleanup
      // Peek directly — entry must be gone.
      expect(store._peek(record.state)).toBeUndefined();
    });
  });

  describe('isolation between keys', () => {
    it('consuming one state does not affect another', async () => {
      const r1 = makeRecord({ state: 'state-1' });
      const r2 = makeRecord({ state: 'state-2' });
      await store.put(r1, 600);
      await store.put(r2, 600);

      await store.consume('state-1');

      const result = await store.consume('state-2');
      expect(result).toEqual(r2);
    });
  });

  describe('put overwrites an existing key', () => {
    it('second put with same state key replaces the first', async () => {
      const original = makeRecord({ state: 'dup-state', tenantId: 'tenant-1' });
      const replacement = makeRecord({ state: 'dup-state', tenantId: 'tenant-2' });
      await store.put(original, 600);
      await store.put(replacement, 600);

      const result = await store.consume('dup-state');
      expect(result?.tenantId).toBe('tenant-2');
    });
  });
});
