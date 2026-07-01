import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConsumedInvite, Invite, InviteRef } from '../../src/domain/entities';
import {
  assembleInviteToken,
  hashInviteSecret,
  INVITE_PREFIX,
  INVITE_SECRET_BYTES,
  mintInviteToken,
  parseInviteToken,
} from '../../src/domain/invite';

describe('invite token — wire format (lginv)', () => {
  it('assembles the plaintext as lginv_<publicId>_<secret>', () => {
    expect(assembleInviteToken('acme', 'mysecret')).toBe('lginv_acme_mysecret');
  });

  it('parse(assemble(publicId, secret)) round-trips', () => {
    const publicId = 'acme';
    const secret = randomBytes(INVITE_SECRET_BYTES).toString('hex');
    const token = assembleInviteToken(publicId, secret);
    const parsed = parseInviteToken(token);
    expect(parsed.publicId).toBe(publicId);
    expect(parsed.secret).toBe(secret);
  });

  it('preserves a secret that itself contains the "_" separator (remainder semantics)', () => {
    // splitN(..., 3) means only two '_' are consumed; the secret is the remainder.
    const parsed = parseInviteToken('lginv_acme_a_b_c');
    expect(parsed.publicId).toBe('acme');
    expect(parsed.secret).toBe('a_b_c');
  });

  it('rejects wrong prefix', () => {
    expect(() => parseInviteToken('lgk_acme_secret')).toThrow();
  });

  it('rejects token with only two components (missing secret)', () => {
    // splitN on 'lginv_acme' with n=3 gives ['lginv','acme'] then '' as remainder,
    // but the empty-string guard fires.
    expect(() => parseInviteToken('lginv_acme')).toThrow();
  });

  it('rejects empty publicId', () => {
    expect(() => parseInviteToken('lginv__secret')).toThrow();
  });

  it('rejects completely empty input', () => {
    expect(() => parseInviteToken('')).toThrow();
  });

  it('INVITE_PREFIX is exactly "lginv"', () => {
    expect(INVITE_PREFIX).toBe('lginv');
  });
});

describe('invite token — minting', () => {
  it('mintInviteToken returns plaintext matching assemble()', () => {
    const token = mintInviteToken('acme', 'topsecret');
    expect(token.plaintext).toBe('lginv_acme_topsecret');
    expect(token.publicId).toBe('acme');
    expect(token.secret).toBe('topsecret');
  });

  it('mintInviteToken + parseInviteToken round-trips end-to-end', () => {
    const secret = randomBytes(INVITE_SECRET_BYTES).toString('hex');
    const minted = mintInviteToken('tenant-slug', secret);
    const parsed = parseInviteToken(minted.plaintext);
    expect(parsed.publicId).toBe('tenant-slug');
    expect(parsed.secret).toBe(secret);
  });
});

describe('hashInviteSecret — sha256 at rest (R-INV-2)', () => {
  it('returns exactly 32 bytes', () => {
    const hash = hashInviteSecret('any-secret');
    expect(hash.length).toBe(32);
  });

  it('equals the plain sha256 of the secret', () => {
    const secret = 'devsecret0123456789';
    const expected = createHash('sha256').update(secret, 'utf8').digest();
    expect(hashInviteSecret(secret).equals(expected)).toBe(true);
  });

  it('a CSPRNG secret of INVITE_SECRET_BYTES hashes to 32 bytes', () => {
    const secret = randomBytes(INVITE_SECRET_BYTES).toString('hex');
    const hash = hashInviteSecret(secret);
    expect(hash.length).toBe(32);
  });
});

describe('Invite projection — no plaintext outward (R-INV-2)', () => {
  it('Invite type carries metadata only — no token or tokenHash fields', () => {
    // Structural check: build a valid Invite and confirm the type has no secret
    // fields. This is primarily a type-level guard; the runtime check confirms
    // the shape by verifying which keys are present on a real value.
    const invite: Invite = {
      id: 'uuid-1',
      tenantId: 'tenant-uuid',
      email: 'user@example.com',
      role: 'member',
      status: 'pending',
      createdBy: null,
      expiresAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const keys = Object.keys(invite);
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('tokenHash');
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('secretHash');
  });

  it('InviteRef carries no secret fields', () => {
    const ref: InviteRef = { id: 'uuid-1', tenantId: 'tenant-uuid', email: 'u@e.com' };
    const keys = Object.keys(ref);
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('secret');
  });

  it('ConsumedInvite carries no secret fields', () => {
    const consumed: ConsumedInvite = {
      inviteId: 'uuid-1',
      role: 'member',
      email: 'user@example.com',
      consumedAt: new Date(),
    };
    const keys = Object.keys(consumed);
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('tokenHash');
    expect(keys).not.toContain('secretHash');
  });
});
