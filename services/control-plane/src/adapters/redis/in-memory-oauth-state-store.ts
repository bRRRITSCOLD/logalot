import type { OAuthStateRecord, OAuthStateStore } from '../../app/ports';

// InMemoryOAuthStateStore is the in-process fake used in unit tests and
// local development when Redis is not available. It is NOT safe for multi-process
// deployments (no cross-process atomicity) — the Redis adapter must be used in
// production.
//
// Expiry is lazily checked on consume() so the store never needs a timer,
// keeping it simple for tests that control fake time or don't care about TTL.

interface Entry {
  record: OAuthStateRecord;
  expiresAt: number; // Date.now() ms
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly store = new Map<string, Entry>();

  async put(record: OAuthStateRecord, ttlSeconds: number): Promise<void> {
    this.store.set(record.state, {
      record,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const entry = this.store.get(state);
    if (!entry) return null;

    // Lazy TTL check — treat expired entries as absent.
    if (Date.now() > entry.expiresAt) {
      this.store.delete(state);
      return null;
    }

    // Single-use: delete before returning.
    this.store.delete(state);
    return entry.record;
  }

  /** Test helper — directly inspect the raw entry without consuming it. */
  _peek(state: string): Entry | undefined {
    return this.store.get(state);
  }

  /** Test helper — forcibly expire an entry to simulate TTL. */
  _expire(state: string): void {
    const entry = this.store.get(state);
    if (entry) {
      this.store.set(state, { ...entry, expiresAt: 0 });
    }
  }
}
