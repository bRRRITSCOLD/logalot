import { describe, expect, it } from 'vitest';
import { type ClientSession, decodeAccessClaims, isExpired, sessionFromClaims } from './session';

// Build an unsigned JWT-shaped string with the given payload. The BFF decodes
// (does not verify) claims, so a fake signature is sufficient for these tests.
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const claims = {
  sub: '00000000-0000-0000-0000-000000000001',
  tenant_id: '00000000-0000-0000-0000-0000000000aa',
  role: 'tenant_admin' as const,
  iat: 1_000,
  exp: 2_000_000_000,
};

describe('decodeAccessClaims', () => {
  it('decodes valid claims from a JWT payload segment', () => {
    expect(decodeAccessClaims(fakeJwt(claims))).toEqual(claims);
  });

  it('returns null for undefined / malformed / wrong-shape tokens', () => {
    expect(decodeAccessClaims(undefined)).toBeNull();
    expect(decodeAccessClaims('not-a-jwt')).toBeNull();
    expect(decodeAccessClaims('only.two')).toBeNull();
    // Valid base64 JSON but missing required claims -> rejected by the contract.
    expect(decodeAccessClaims(fakeJwt({ sub: 'x' }))).toBeNull();
  });

  it('rejects a role outside the shared roles contract', () => {
    expect(decodeAccessClaims(fakeJwt({ ...claims, role: 'superuser' }))).toBeNull();
  });
});

describe('isExpired', () => {
  const now = 1_700_000_000_000; // fixed "now" in ms
  it('is false for a token comfortably in the future', () => {
    expect(isExpired({ exp: 1_700_000_900 }, now)).toBe(false);
  });
  it('is true once past expiry', () => {
    expect(isExpired({ exp: 1_699_999_000 }, now)).toBe(true);
  });
  it('treats a token inside the skew window as expired (refresh early)', () => {
    // exp is 10s ahead but default skew is 30s -> considered expired.
    expect(isExpired({ exp: Math.floor(now / 1000) + 10 }, now)).toBe(true);
  });
});

describe('sessionFromClaims', () => {
  it('maps JWT claims onto the server-derived ClientSession (tenant from claims)', () => {
    const session: ClientSession = sessionFromClaims(claims);
    expect(session).toEqual({
      userId: claims.sub,
      tenantId: claims.tenant_id,
      role: 'tenant_admin',
      expiresAt: claims.exp,
    });
  });
});
