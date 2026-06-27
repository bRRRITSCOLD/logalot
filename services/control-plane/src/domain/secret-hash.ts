import { createHash, timingSafeEqual } from 'node:crypto';

// sha256 returns the SHA-256 of a high-entropy secret as 32 raw bytes — the single
// source of truth for how BOTH api_keys.key_hash and refresh_tokens.token_hash are
// derived (migrations 000005 / 000012). SHA-256 (not a slow KDF) is correct here
// because the secrets are random, not human passwords (ADR-0007). Must stay
// byte-identical to the Go side's hashing so a key minted here verifies there.
export function sha256(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

// constantTimeEqual compares two digests without leaking, via timing, where they
// first differ. Returns false for length mismatches (timingSafeEqual throws on
// unequal lengths, so guard first).
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
