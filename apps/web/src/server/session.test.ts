import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_COOKIE,
  type ClientSession,
  decodeAccessClaims,
  isExpired,
  serializeSessionCookie,
  sessionCookieAttributes,
  sessionCookieSecure,
  sessionFromClaims,
} from './session';

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

// The session-cookie policy is a SINGLE source of truth shared by the framework
// setCookie path (auth.ts) and the SSE proxy's raw Set-Cookie path (tail-proxy.ts).
describe('session cookie policy', () => {
  const original = { COOKIE_SECURE: process.env.COOKIE_SECURE, NODE_ENV: process.env.NODE_ENV };
  afterEach(() => {
    process.env.COOKIE_SECURE = original.COOKIE_SECURE;
    process.env.NODE_ENV = original.NODE_ENV;
  });

  it('defaults Secure ON, and only plain-http local dev opts out', () => {
    process.env.COOKIE_SECURE = undefined;
    process.env.NODE_ENV = 'production';
    expect(sessionCookieSecure()).toBe(true);
    process.env.NODE_ENV = 'staging';
    expect(sessionCookieSecure()).toBe(true); // not keyed off NODE_ENV===production
    process.env.NODE_ENV = 'development';
    expect(sessionCookieSecure()).toBe(false);
  });

  it('honours an explicit COOKIE_SECURE override', () => {
    process.env.NODE_ENV = 'development';
    process.env.COOKIE_SECURE = 'true';
    expect(sessionCookieSecure()).toBe(true);
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = 'false';
    expect(sessionCookieSecure()).toBe(false);
  });

  it('attribute set and the raw Set-Cookie string agree (HttpOnly/SameSite/Secure/Max-Age)', () => {
    process.env.COOKIE_SECURE = 'true';
    const attrs = sessionCookieAttributes();
    expect(attrs).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });

    const raw = serializeSessionCookie(ACCESS_COOKIE, 'tok');
    expect(raw).toContain(`${ACCESS_COOKIE}=tok`);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Secure');
    expect(raw).toContain(`Max-Age=${attrs.maxAge}`);
    expect(raw).toContain('Path=/');
  });

  it('omits Secure from the raw cookie when the policy says insecure', () => {
    process.env.COOKIE_SECURE = 'false';
    expect(serializeSessionCookie(ACCESS_COOKIE, 'tok')).not.toContain('Secure');
  });
});
