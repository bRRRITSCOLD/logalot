import { describe, expect, it } from 'vitest';
import { BcryptHasher } from '../../src/adapters/crypto/bcrypt-hasher';

describe('BcryptHasher', () => {
  const hasher = new BcryptHasher(4); // low cost for fast tests

  it('produces a hash that is not the plaintext and verifies correctly', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).not.toContain('correct horse');
    expect(await hasher.verify('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hasher.hash('right-password');
    expect(await hasher.verify('wrong-password', hash)).toBe(false);
  });
});
