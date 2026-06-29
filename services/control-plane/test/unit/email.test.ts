import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../../src/domain/email';

describe('normalizeEmail', () => {
  it('lowercases an already-trimmed address', () => {
    expect(normalizeEmail('User@X.com')).toBe('user@x.com');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
    expect(normalizeEmail('\tuser@example.com\n')).toBe('user@example.com');
  });

  it('applies NFC normalization so decomposed and precomposed forms are equal', () => {
    // 'ä' can appear as U+00E4 (precomposed) or U+0061 U+0308 (a + combining diaeresis).
    const precomposed = 'uäser@example.com'; // NFC ä
    const decomposed = 'uäser@example.com'; // NFD a + combining diaeresis
    expect(normalizeEmail(decomposed)).toBe(normalizeEmail(precomposed));
  });

  it('is idempotent', () => {
    const raw = '  User@X.com ';
    expect(normalizeEmail(normalizeEmail(raw))).toBe(normalizeEmail(raw));
  });

  it('does NOT fold homograph characters (Cyrillic а ≠ Latin a)', () => {
    const cyrillic = 'а'; // Cyrillic small letter а
    const latin = 'a';
    expect(normalizeEmail(`${cyrillic}dmin@example.com`)).not.toBe(
      normalizeEmail(`${latin}dmin@example.com`),
    );
  });

  it('handles addresses that are already normalized', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com');
  });

  it('lowercases mixed-case local parts and domains', () => {
    expect(normalizeEmail('ALICE@EXAMPLE.COM')).toBe('alice@example.com');
  });
});
