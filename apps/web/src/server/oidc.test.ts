import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BFF OIDC relay — unit tests for startGoogleSignin and completeGoogleSignin.
// The trust-critical behaviours tested here:
//   1. returnTo open-redirect validation (schema catches absolute / proto-relative URLs)
//   2. Session cookies are written on success (lg_at / lg_rt)
//   3. 4xx upstream errors collapse to one generic message (no enumeration)
//   4. Handshake cookies (lg_oidc_tenant / lg_oidc_return / lg_oidc_state) are cleared on all exits
//   5. State is extracted from redirectUrl and bound to the browser via lg_oidc_state cookie (R4 / T3)
//   6. completeGoogleSignin rejects mismatched state before relaying to the control-plane
//
// `createServerFn(...).validator(...).handler(fn)` -> a callable that runs `fn`
// directly when called with `{ data }`.  We stub it the same way auth.test.ts does.

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
  setResponseHeader: vi.fn(),
}));

vi.mock('./control-plane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./control-plane')>();
  return {
    ...actual, // keep the real ControlPlaneError class for `instanceof`
    cpOidcAuthorize: vi.fn(),
    cpOidcCallback: vi.fn(),
  };
});

import type { TokenPair } from '@logalot/contracts';
import {
  deleteCookie,
  getCookie,
  setCookie,
  setResponseHeader,
} from '@tanstack/react-start/server';
import { ControlPlaneError, cpOidcAuthorize, cpOidcCallback } from './control-plane';
import {
  completeGoogleSignin,
  getInviteTenantSlug,
  getOidcTenantSlug,
  INVITE_TOKEN_COOKIE,
  OIDC_RETURN_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_TENANT_COOKIE,
  startGoogleSignin,
  stashInviteToken,
} from './oidc';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './session';

const mockGetCookie = vi.mocked(getCookie);
const mockSetCookie = vi.mocked(setCookie);
const mockDeleteCookie = vi.mocked(deleteCookie);
const mockSetResponseHeader = vi.mocked(setResponseHeader);
const mockCpOidcAuthorize = vi.mocked(cpOidcAuthorize);
const mockCpOidcCallback = vi.mocked(cpOidcCallback);

/** Configure the cookie jar `getCookie` reads from for a test. */
function cookies(jar: Partial<Record<string, string>>): void {
  mockGetCookie.mockImplementation((name: string) => jar[name]);
}

/** Build an unsigned JWT-shaped token for testing. */
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

/** A redirect URL that includes an OIDC state parameter (as the CP would produce). */
const REDIRECT_WITH_STATE = (state: string) =>
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=${encodeURIComponent(state)}`;

beforeEach(() => {
  vi.clearAllMocks();
  cookies({});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── startGoogleSignin ────────────────────────────────────────────────────────

describe('startGoogleSignin', () => {
  it('returns the redirect URL, sets lg_oidc_state, and stashes tenantSlug + returnTo cookies on success', async () => {
    const redirectUrl = REDIRECT_WITH_STATE('csrf-token-abc');
    mockCpOidcAuthorize.mockResolvedValue({ redirectUrl });

    const result = await startGoogleSignin({
      data: { tenantSlug: 'acme', returnTo: '/dashboard' },
    });

    expect(result).toEqual({ ok: true, redirectUrl });
    // State MUST be bound to this browser before redirecting.
    expect(mockSetCookie).toHaveBeenCalledWith(
      OIDC_STATE_COOKIE,
      'csrf-token-abc',
      expect.any(Object),
    );
    expect(mockSetCookie).toHaveBeenCalledWith(OIDC_TENANT_COOKIE, 'acme', expect.any(Object));
    expect(mockSetCookie).toHaveBeenCalledWith(
      OIDC_RETURN_COOKIE,
      '/dashboard',
      expect.any(Object),
    );
  });

  it('does not set a return cookie when returnTo is absent', async () => {
    mockCpOidcAuthorize.mockResolvedValue({ redirectUrl: REDIRECT_WITH_STATE('s1') });

    await startGoogleSignin({ data: { tenantSlug: 'acme' } });

    expect(mockSetCookie).not.toHaveBeenCalledWith(
      OIDC_RETURN_COOKIE,
      expect.anything(),
      expect.anything(),
    );
    // State cookie MUST still be set.
    expect(mockSetCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, 's1', expect.any(Object));
  });

  it('fails closed when the redirectUrl contains no state parameter', async () => {
    // A redirect URL without a state param violates OIDC spec — the BFF must not proceed.
    mockCpOidcAuthorize.mockResolvedValue({
      redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
    });

    const result = await startGoogleSignin({ data: { tenantSlug: 'acme' } });

    expect(result).toEqual({
      ok: false,
      message: 'Sign-in is temporarily unavailable. Please try again.',
    });
    // No cookies must be written when state extraction fails.
    expect(mockSetCookie).not.toHaveBeenCalled();
  });

  it.each([
    ['//evil.com'],
    ['https://evil.com'],
    ['\\\\\\\\ evil.com'],
    [' https://evil.com'],
  ])('schema rejects returnTo=%s — never reaches the control-plane', async (badReturnTo) => {
    // The oidcAuthorizeRequestSchema validator should reject the call before the handler runs.
    // Because the validator stub in createServerFn is a no-op (it just calls handler directly),
    // we test the schema directly instead.
    const { oidcAuthorizeRequestSchema } = await import('@logalot/contracts');
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme',
      returnTo: badReturnTo,
    });
    expect(result.success).toBe(false);
    expect(mockCpOidcAuthorize).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'not_found'],
    [422, 'invalid_request'],
  ])('collapses a %s (%s) upstream 4xx to a workspace-specific generic message', async (status, code) => {
    mockCpOidcAuthorize.mockRejectedValue(new ControlPlaneError(status, code, `raw: ${code}`));

    const result = await startGoogleSignin({ data: { tenantSlug: 'ghost' } });

    expect(result).toEqual({
      ok: false,
      message: 'Sign-in with Google is unavailable for this workspace.',
    });
  });

  it.each([
    [500, 'internal'],
    [503, 'upstream_unreachable'],
  ])('collapses a %s upstream 5xx to a generic availability message', async (status, code) => {
    mockCpOidcAuthorize.mockRejectedValue(new ControlPlaneError(status, code, 'down'));

    const result = await startGoogleSignin({ data: { tenantSlug: 'acme' } });

    expect(result).toEqual({
      ok: false,
      message: 'Sign-in is temporarily unavailable. Please try again.',
    });
  });
});

// ── completeGoogleSignin ─────────────────────────────────────────────────────

describe('completeGoogleSignin', () => {
  it('writes session cookies, clears handshake cookies, and returns session + returnTo on success', async () => {
    const access = fakeJwt({ ...baseClaims, exp: FAR_FUTURE });
    mockCpOidcCallback.mockResolvedValue(tokenPair(access));
    cookies({
      [OIDC_RETURN_COOKIE]: '/settings',
      [OIDC_STATE_COOKIE]: 'matching-state',
    });

    const result = await completeGoogleSignin({
      data: { tenantSlug: 'acme', code: 'auth-code', state: 'matching-state' },
    });

    expect(result).toEqual({
      ok: true,
      session: {
        userId: baseClaims.sub,
        tenantId: baseClaims.tenant_id,
        role: 'member',
        expiresAt: FAR_FUTURE,
      },
      returnTo: '/settings',
    });
    expect(mockSetCookie).toHaveBeenCalledWith(ACCESS_COOKIE, access, expect.any(Object));
    expect(mockSetCookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'rt-new', expect.any(Object));
    // All handshake cookies MUST be cleared after a successful exchange.
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_TENANT_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_RETURN_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, expect.any(Object));
  });

  it('merges inviteToken from the lg_invite_token cookie into the control-plane relay body (R-INV-12)', async () => {
    const access = fakeJwt({ ...baseClaims, exp: FAR_FUTURE });
    mockCpOidcCallback.mockResolvedValue(tokenPair(access));
    cookies({
      [OIDC_STATE_COOKIE]: 's',
      [INVITE_TOKEN_COOKIE]: 'lginv_acme-corp_deadbeef',
    });

    await completeGoogleSignin({ data: { tenantSlug: 'acme-corp', code: 'code', state: 's' } });

    expect(mockCpOidcCallback).toHaveBeenCalledWith({
      tenantSlug: 'acme-corp',
      code: 'code',
      state: 's',
      inviteToken: 'lginv_acme-corp_deadbeef',
    });
  });

  it('does not add an inviteToken field when no invite cookie is present', async () => {
    const access = fakeJwt({ ...baseClaims, exp: FAR_FUTURE });
    mockCpOidcCallback.mockResolvedValue(tokenPair(access));
    cookies({ [OIDC_STATE_COOKIE]: 's' });

    await completeGoogleSignin({ data: { tenantSlug: 'acme-corp', code: 'code', state: 's' } });

    const calledWith = mockCpOidcCallback.mock.calls[0]?.[0];
    expect(calledWith).not.toHaveProperty('inviteToken');
  });

  it('ignores a client-supplied inviteToken in the request body when no lg_invite_token cookie is present', async () => {
    // Guards against reusing the BFF -> control-plane wire schema as the
    // client -> BFF input validator: even if a caller's payload carried an
    // `inviteToken` (bypassing the request-schema boundary -- e.g. in a test
    // harness that stubs out server-fn validation), the handler must never
    // forward it. The relay body is rebuilt field-by-field from `data`
    // (never spread), so `inviteToken` can only ever come from the cookie.
    const access = fakeJwt({ ...baseClaims, exp: FAR_FUTURE });
    mockCpOidcCallback.mockResolvedValue(tokenPair(access));
    cookies({ [OIDC_STATE_COOKIE]: 's' }); // no lg_invite_token cookie

    const maliciousData = {
      tenantSlug: 'acme-corp',
      code: 'code',
      state: 's',
      inviteToken: 'lginv_attacker-tenant_deadbeef',
      // biome-ignore lint/suspicious/noExplicitAny: simulating a payload that smuggles a field the client-facing schema does not declare.
    } as any;

    await completeGoogleSignin({ data: maliciousData });

    expect(mockCpOidcCallback).toHaveBeenCalledWith({
      tenantSlug: 'acme-corp',
      code: 'code',
      state: 's',
    });
    const calledWith = mockCpOidcCallback.mock.calls[0]?.[0];
    expect(calledWith).not.toHaveProperty('inviteToken');
  });

  it('clears the lg_invite_token cookie on a successful callback', async () => {
    const access = fakeJwt({ ...baseClaims, exp: FAR_FUTURE });
    mockCpOidcCallback.mockResolvedValue(tokenPair(access));
    cookies({ [OIDC_STATE_COOKIE]: 's', [INVITE_TOKEN_COOKIE]: 'lginv_acme-corp_deadbeef' });

    await completeGoogleSignin({ data: { tenantSlug: 'acme-corp', code: 'code', state: 's' } });

    expect(mockDeleteCookie).toHaveBeenCalledWith(INVITE_TOKEN_COOKIE, expect.any(Object));
  });

  it('clears the lg_invite_token cookie even when the callback fails', async () => {
    mockCpOidcCallback.mockRejectedValue(new ControlPlaneError(400, 'bad_request', 'raw'));
    cookies({ [OIDC_STATE_COOKIE]: 's', [INVITE_TOKEN_COOKIE]: 'lginv_acme-corp_deadbeef' });

    await completeGoogleSignin({ data: { tenantSlug: 'acme-corp', code: 'code', state: 's' } });

    expect(mockDeleteCookie).toHaveBeenCalledWith(INVITE_TOKEN_COOKIE, expect.any(Object));
  });

  it('returns null returnTo when the return cookie is absent', async () => {
    const access = fakeJwt({ ...baseClaims, exp: FAR_FUTURE });
    mockCpOidcCallback.mockResolvedValue(tokenPair(access));
    cookies({ [OIDC_STATE_COOKIE]: 's' });

    const result = await completeGoogleSignin({
      data: { tenantSlug: 'acme', code: 'code', state: 's' },
    });

    expect(result).toMatchObject({ ok: true, returnTo: null });
  });

  it('rejects and clears cookies when the URL state does not match the browser-bound state cookie (login-CSRF)', async () => {
    // The attacker's state_A is in the URL, but the victim's browser has state_B from
    // their own (or no) authorize call — the mismatch must be detected before relay.
    cookies({ [OIDC_STATE_COOKIE]: 'state-B' });

    const result = await completeGoogleSignin({
      data: { tenantSlug: 'acme', code: 'code-A', state: 'state-A' },
    });

    expect(result).toEqual({ ok: false, message: 'Sign-in failed' });
    // Control-plane MUST NOT be called when state validation fails.
    expect(mockCpOidcCallback).not.toHaveBeenCalled();
    // Handshake cookies MUST be cleared to abort the stale flow.
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, expect.any(Object));
  });

  it('rejects and clears cookies when the state cookie is absent (flow not initiated in this browser)', async () => {
    cookies({}); // No state cookie.

    const result = await completeGoogleSignin({
      data: { tenantSlug: 'acme', code: 'code', state: 'some-state' },
    });

    expect(result).toEqual({ ok: false, message: 'Sign-in failed' });
    expect(mockCpOidcCallback).not.toHaveBeenCalled();
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, expect.any(Object));
  });

  it('fails closed and clears handshake cookies when the CP returns an undecodable token', async () => {
    mockCpOidcCallback.mockResolvedValue(tokenPair('not-a-jwt'));
    cookies({ [OIDC_STATE_COOKIE]: 's' });

    const result = await completeGoogleSignin({
      data: { tenantSlug: 'acme', code: 'code', state: 's' },
    });

    expect(result).toEqual({ ok: false, message: 'Sign-in failed' });
    expect(mockSetCookie).not.toHaveBeenCalled();
    // All handshake cookies MUST be cleared even on failure.
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_TENANT_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_RETURN_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, expect.any(Object));
  });

  it.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ])('collapses a %s (%s) callback 4xx to a generic sign-in failed message', async (status, code) => {
    mockCpOidcCallback.mockRejectedValue(new ControlPlaneError(status, code, `raw: ${code}`));
    cookies({ [OIDC_STATE_COOKIE]: 's' });

    const result = await completeGoogleSignin({
      data: { tenantSlug: 'acme', code: 'code', state: 's' },
    });

    expect(result).toEqual({ ok: false, message: 'Sign-in failed' });
    expect(mockSetCookie).not.toHaveBeenCalled();
    // Handshake cookies MUST be cleared after any error path.
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_TENANT_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, expect.any(Object));
  });

  it.each([
    [500, 'internal'],
    [503, 'upstream_unreachable'],
  ])('collapses a %s callback 5xx to a generic availability message', async (status, code) => {
    mockCpOidcCallback.mockRejectedValue(new ControlPlaneError(status, code, 'down'));
    cookies({ [OIDC_STATE_COOKIE]: 's' });

    const result = await completeGoogleSignin({
      data: { tenantSlug: 'acme', code: 'code', state: 's' },
    });

    expect(result).toEqual({
      ok: false,
      message: 'Sign-in is temporarily unavailable. Please try again.',
    });
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_TENANT_COOKIE, expect.any(Object));
    expect(mockDeleteCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, expect.any(Object));
  });
});

// ── getOidcTenantSlug ────────────────────────────────────────────────────────

describe('getOidcTenantSlug', () => {
  it('returns the tenant slug from the handshake cookie', async () => {
    cookies({ [OIDC_TENANT_COOKIE]: 'acme' });
    expect(await getOidcTenantSlug()).toBe('acme');
  });

  it('returns null when the cookie is absent', async () => {
    cookies({});
    expect(await getOidcTenantSlug()).toBeNull();
  });
});

// ── stashInviteToken ─────────────────────────────────────────────────────────

describe('stashInviteToken', () => {
  it('sets the lg_invite_token cookie and Referrer-Policy: no-referrer for a well-formed token', async () => {
    const result = await stashInviteToken({ data: { token: 'lginv_acme-corp_deadbeef' } });

    expect(result).toEqual({ ok: true });
    expect(mockSetCookie).toHaveBeenCalledWith(
      INVITE_TOKEN_COOKIE,
      'lginv_acme-corp_deadbeef',
      expect.any(Object),
    );
    expect(mockSetResponseHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });

  it('sets Referrer-Policy: no-referrer even for a malformed token (R-INV-11)', async () => {
    const result = await stashInviteToken({ data: { token: 'not-an-invite-token' } });

    expect(result).toEqual({ ok: false });
    expect(mockSetResponseHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });

  it('does not set the cookie for a malformed token — fails closed', async () => {
    await stashInviteToken({ data: { token: 'not-an-invite-token' } });
    expect(mockSetCookie).not.toHaveBeenCalled();
  });
});

// ── getInviteTenantSlug ──────────────────────────────────────────────────────

describe('getInviteTenantSlug', () => {
  it('returns the tenant slug parsed from the stashed invite token', async () => {
    cookies({ [INVITE_TOKEN_COOKIE]: 'lginv_acme-corp_deadbeef' });
    expect(await getInviteTenantSlug()).toBe('acme-corp');
  });

  it('returns null when no invite token cookie is present', async () => {
    cookies({});
    expect(await getInviteTenantSlug()).toBeNull();
  });

  it('returns null when the stashed token is malformed', async () => {
    cookies({ [INVITE_TOKEN_COOKIE]: 'garbage' });
    expect(await getInviteTenantSlug()).toBeNull();
  });
});
