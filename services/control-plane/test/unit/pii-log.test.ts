import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { piiHash } from '../../src/domain/pii-log';

describe('piiHash', () => {
  it('returns an 8-character lowercase hex string', () => {
    const result = piiHash('alice@example.com');
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic — same input produces same output', () => {
    const a = piiHash('google-sub-12345');
    const b = piiHash('google-sub-12345');
    expect(a).toBe(b);
  });

  it('produces different digests for different inputs', () => {
    expect(piiHash('alice@example.com')).not.toBe(piiHash('bob@example.com'));
    expect(piiHash('sub-001')).not.toBe(piiHash('sub-002'));
  });

  it('matches the first 8 hex chars of SHA-256', () => {
    const input = 'alice@example.com';
    const expected = createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 8);
    expect(piiHash(input)).toBe(expected);
  });

  it('handles an empty string without throwing', () => {
    expect(() => piiHash('')).not.toThrow();
    expect(piiHash('')).toHaveLength(8);
  });

  it('does NOT contain the raw input value', () => {
    const email = 'alice@example.com';
    expect(piiHash(email)).not.toContain('alice');
    expect(piiHash(email)).not.toContain('example');
  });
});
