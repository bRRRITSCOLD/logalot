import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KEY_PREFIX,
  assemblePlaintext,
  hashSecret,
  mintApiKey,
  parseApiKey,
} from '../../src/domain/api-key';
import { NodeKeyMaterialGenerator } from '../../src/adapters/crypto/node-key-material';

// LOAD-BEARING: a key minted here must authenticate via the Go ingest
// Authenticator. These tests pin the exact wire format and hash so the two sides
// can never drift (pkg/auth/key.go, migration 000005).
describe('api key minting / hashing (Go compatibility)', () => {
  it('hashes the secret with plain SHA-256 (32 raw bytes), matching the Go side', () => {
    // Vector from the dev seed (migrations/seeds/dev_tenant.sql), which stores
    // digest('devsecret0123456789','sha256').
    const secret = 'devsecret0123456789';
    const hash = hashSecret(secret);
    const expected = createHash('sha256').update(secret, 'utf8').digest();
    expect(hash.equals(expected)).toBe(true);
    expect(hash.length).toBe(32);
  });

  it('assembles the plaintext as lgk_<publicId>_<keyId>_<secret>', () => {
    const plaintext = assemblePlaintext('acme', { keyId: 'abc123', secret: 'sssss' });
    expect(plaintext).toBe('lgk_acme_abc123_sssss');
  });

  it('mintApiKey returns a plaintext whose stored hash is sha256 of its secret', () => {
    const minted = mintApiKey('acme', { keyId: 'kid', secret: 'topsecret' });
    expect(minted.plaintext).toBe('lgk_acme_kid_topsecret');
    const parsed = parseApiKey(minted.plaintext);
    expect(parsed).toEqual({ publicId: 'acme', keyId: 'kid', secret: 'topsecret' });
    expect(hashSecret(parsed.secret).equals(minted.keyHash)).toBe(true);
  });

  it('parseApiKey keeps a secret that itself contains the separator intact', () => {
    const parsed = parseApiKey('lgk_acme_kid_a_b_c');
    expect(parsed.secret).toBe('a_b_c');
  });

  it('rejects malformed keys (wrong prefix, too few fields, empty parts)', () => {
    expect(() => parseApiKey('nope_acme_kid_secret')).toThrow();
    expect(() => parseApiKey('lgk_acme_kid')).toThrow();
    expect(() => parseApiKey('lgk__kid_secret')).toThrow();
  });

  it('the production generator yields hex components of the Go-matching widths', () => {
    const { keyId, secret } = new NodeKeyMaterialGenerator().generate();
    expect(keyId).toMatch(/^[0-9a-f]{32}$/); // 16 bytes hex
    expect(secret).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    const minted = mintApiKey('acme', { keyId, secret });
    expect(minted.plaintext.startsWith(`${KEY_PREFIX}_acme_`)).toBe(true);
  });
});
