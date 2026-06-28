import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Trust-critical BFF auth orchestration. These tests exercise the fail-closed /
// silent-refresh branches of `getSession`, the enumeration-safe `loginFn` error
// mapping, and the best-effort `logoutFn` — by mocking the two side-effecting
// dependencies (cookie accessors + the control-plane client) and the thin
// `createServerFn` wrapper so the handler body is invoked directly.

// `createServerFn(...).validator(...).handler(fn)` -> a callable that runs `fn`.
// We stub it so each server fn under test IS its handler, called with its input.
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const builder = {
      validator: () => builder,
      handler: (fn: (input: unknown) => unknown) => (input?: unknown) => fn(input ?? {}),
    };
    return builder;
  },
}));

vi.mock('@tanstack/react-start/server', () => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

vi.mock('./control-plane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./control-plane')>();
  return {
    ...actual, // keep the real ControlPlaneError class for `instanceof`
    cpLogin: vi.fn(),
    cpRefresh: vi.fn(),
    cpLogout: vi.fn(),
  };
});

import type { TokenPair } from '@logalot/contracts';
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server';
import { getSession, loginFn, logoutFn } from './auth';
import { ControlPlaneError, cpLogin, cpLogout, cpRefresh } from './control-plane';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './session';

const mockGetCookie = vi.mocked(getCookie);
const mockSetCookie = vi.mocked(setCookie);
const mockDeleteCookie = vi.mocked(deleteCookie);
const mockCpLogin = vi.mocked(cpLogin);
const mockCpRefresh = vi.mocked(cpRefresh);
const mockCpLogout = vi.mocked(cpLogout);

// Unsigned JWT-shaped string (the BFF decodes, never verifies, claims).
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const baseClaims = {
  sub: '00000000-0000-0000-0000-000000000001',
  tenant_id: '00000000-0000-0000-0000-0000000000aa',
  role: 'member' as const,
  iat: 1_000,
};
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

function tokenPair(accessToken: string): TokenPair {
  return {
    accessToken,
    refreshToken: 'rt-new',
    expiresIn: 900,
    tokenType: 'Bearer',
    role: 'member',
    tenantId: baseClaims.tenant_id,
    userId: baseClaims.sub,
  };
}

/** Configure the cookie jar `getCookie` reads from for a test. */
function cookies(jar: Partial<Record<string, string>>): void {
  mockGetCookie.mockImplementation((name: string) => jar[name]);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('getSession', () => {
  it('returns the session for a valid, unexpired access token (no refresh)', async () => {
    cookies({ [ACCESS_COOKIE]: fakeJwt({ ...baseClaims, exp: FAR_FUTURE }) });

    const session = await getSession();

    expect(session).toEqual({
      userId: baseClaims.sub,
      tenantId: baseClaims.tenant_id,
      role: 'member',
      expiresAt: FAR_FUTURE,
    });
    expect(mockCpRefresh).not.toHaveBeenCalled();
    expect(mockDeleteCookie).not.toHaveBeenCalled();
  });

  it('silently refreshes an expired token: rotates cookies and returns the fresh session', async () => {
    cookies({ [ACCESS_COOKIE]: fakeJwt({ ...baseClaims, exp: PAST }), [REFRESH_COOKIE]: 'rt-old' });
    const fresh = fakeJwt({ ...baseClaims, exp: FAR_FUTURE });
    mockCpRefresh.mockResolvedValue(tokenPair(fresh));

    const session = await getSession();

    expect(mockCpRefresh).toHaveBeenCalledWith('rt-old');
    expect(session).toMatchObject({ tenantId: baseClaims.tenant_id, expiresAt: FAR_FUTURE });
    // New cookies written for both access + refresh.
    expect(mockSetCookie).toHaveBeenCalledWith(ACCESS_COOKIE, fresh, expect.any(Object));
    expect(mockSetCookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'rt-new', expect.any(Object));
    expect(mockDeleteCookie).not.toHaveBeenCalled();
  });

  it('fails closed when the access token is expired and there is no refresh cookie', async () => {
    cookies({ [ACCESS_COOKIE]: fakeJwt({ ...baseClaims, exp: PAST }) });

    const session = await getSession();

    expect(session).toBeNull();
    expect(mockCpRefresh).not.toHaveBeenCalled();
    expect(mockDeleteCookie).toHaveBeenCalledWith(ACCESS_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(REFRESH_COOKIE, expect.any(Object));
  });

  it('fails closed and clears cookies when refresh is rejected (revoked/expired)', async () => {
    cookies({ [ACCESS_COOKIE]: fakeJwt({ ...baseClaims, exp: PAST }), [REFRESH_COOKIE]: 'rt-old' });
    mockCpRefresh.mockRejectedValue(new ControlPlaneError(401, 'unauthorized', 'expired'));

    const session = await getSession();

    expect(session).toBeNull();
    expect(mockDeleteCookie).toHaveBeenCalledWith(ACCESS_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(REFRESH_COOKIE, expect.any(Object));
    expect(mockSetCookie).not.toHaveBeenCalled();
  });

  it('fails closed when refresh returns an undecodable access token', async () => {
    cookies({ [ACCESS_COOKIE]: fakeJwt({ ...baseClaims, exp: PAST }), [REFRESH_COOKIE]: 'rt-old' });
    mockCpRefresh.mockResolvedValue(tokenPair('not-a-jwt'));

    const session = await getSession();

    expect(session).toBeNull();
    expect(mockDeleteCookie).toHaveBeenCalledWith(ACCESS_COOKIE, expect.any(Object));
    expect(mockSetCookie).not.toHaveBeenCalled();
  });
});

describe('loginFn (enumeration-safe error mapping)', () => {
  it('writes session cookies and returns the session on success', async () => {
    const access = fakeJwt({ ...baseClaims, exp: FAR_FUTURE });
    mockCpLogin.mockResolvedValue(tokenPair(access));

    const result = await loginFn({
      data: { tenantSlug: 'acme', email: 'user@acme.test', password: 'hunter2hunter2' },
    });

    expect(result).toEqual({
      ok: true,
      session: {
        userId: baseClaims.sub,
        tenantId: baseClaims.tenant_id,
        role: 'member',
        expiresAt: FAR_FUTURE,
      },
    });
    expect(mockSetCookie).toHaveBeenCalledWith(ACCESS_COOKIE, access, expect.any(Object));
  });

  it.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
  ])('collapses a %s (%s) auth failure to one generic message', async (status, code) => {
    mockCpLogin.mockRejectedValue(new ControlPlaneError(status, code, `raw upstream: ${code}`));

    const result = await loginFn({
      data: { tenantSlug: 'ghost', email: 'who@ghost.test', password: 'hunter2hunter2' },
    });

    // Identical message regardless of which 4xx it was — no enumeration signal,
    // and never the raw upstream `error.message`.
    expect(result).toEqual({ ok: false, message: 'Invalid credentials' });
    expect(mockSetCookie).not.toHaveBeenCalled();
  });

  it.each([
    [500, 'internal'],
    [503, 'upstream_unreachable'],
  ])('surfaces a distinct, non-sensitive message for a %s upstream failure', async (status, code) => {
    mockCpLogin.mockRejectedValue(new ControlPlaneError(status, code, 'stack trace leak'));

    const result = await loginFn({
      data: { tenantSlug: 'acme', email: 'user@acme.test', password: 'hunter2hunter2' },
    });

    expect(result).toEqual({
      ok: false,
      message: 'Sign-in is temporarily unavailable. Please try again.',
    });
  });
});

describe('logoutFn (best effort)', () => {
  it('revokes upstream and clears cookies when a refresh cookie is present', async () => {
    cookies({ [REFRESH_COOKIE]: 'rt-old' });
    mockCpLogout.mockResolvedValue(undefined);

    const result = await logoutFn();

    expect(mockCpLogout).toHaveBeenCalledWith('rt-old');
    expect(mockDeleteCookie).toHaveBeenCalledWith(ACCESS_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(REFRESH_COOKIE, expect.any(Object));
    expect(result).toEqual({ ok: true });
  });

  it('still clears cookies when upstream revocation fails (best effort)', async () => {
    cookies({ [REFRESH_COOKIE]: 'rt-old' });
    mockCpLogout.mockRejectedValue(new ControlPlaneError(503, 'upstream_unreachable', 'down'));

    const result = await logoutFn();

    expect(mockDeleteCookie).toHaveBeenCalledWith(REFRESH_COOKIE, expect.any(Object));
    expect(result).toEqual({ ok: true });
  });

  it('clears cookies without calling upstream when there is no refresh cookie', async () => {
    cookies({});

    const result = await logoutFn();

    expect(mockCpLogout).not.toHaveBeenCalled();
    expect(mockDeleteCookie).toHaveBeenCalledWith(ACCESS_COOKIE, expect.any(Object));
    expect(result).toEqual({ ok: true });
  });
});
