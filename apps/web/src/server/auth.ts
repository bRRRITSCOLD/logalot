import type { TokenPair } from '@logalot/contracts';
import { loginRequestSchema } from '@logalot/contracts';
import { createServerFn } from '@tanstack/react-start';
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server';
import { ControlPlaneError, cpLogin, cpLogout, cpRefresh } from './control-plane';
import {
  ACCESS_COOKIE,
  type ClientSession,
  decodeAccessClaims,
  isExpired,
  REFRESH_COOKIE,
  sessionFromClaims,
} from './session';

// ── BFF session management (server functions) ───────────────────────────────
// Tokens live ONLY in httpOnly cookies set here, server-side. They are never
// exposed to client JS (so they are not XSS-exfiltratable) and never put in
// localStorage. The browser holds opaque cookies; this BFF attaches the access
// token as a Bearer when proxying to the control-plane (see control-plane.ts).

// Cookie lifetime tracks the refresh-token window (control-plane default 7d). The
// ACCESS token's real validity is governed by its JWT `exp`, not the cookie.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

function cookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Secure in production; off on http://localhost so dev cookies are sent.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  };
}

function writeSessionCookies(pair: TokenPair): void {
  setCookie(ACCESS_COOKIE, pair.accessToken, cookieOptions());
  setCookie(REFRESH_COOKIE, pair.refreshToken, cookieOptions());
}

function clearSessionCookies(): void {
  deleteCookie(ACCESS_COOKIE, { path: '/' });
  deleteCookie(REFRESH_COOKIE, { path: '/' });
}

export type LoginResult = { ok: true; session: ClientSession } | { ok: false; message: string };

/**
 * Exchange credentials for a session. The tenant is identified by `tenantSlug`
 * (server-side), and tenancy thereafter comes only from the issued token's
 * claims — never from client input. A 401 returns a deliberately generic message
 * so the response never reveals whether the tenant/user existed.
 */
export const loginFn = createServerFn({ method: 'POST' })
  .validator(loginRequestSchema)
  .handler(async ({ data }): Promise<LoginResult> => {
    try {
      const pair = await cpLogin(data);
      const claims = decodeAccessClaims(pair.accessToken);
      if (!claims) return { ok: false, message: 'Login failed' };
      writeSessionCookies(pair);
      return { ok: true, session: sessionFromClaims(claims) };
    } catch (err) {
      if (err instanceof ControlPlaneError) {
        return { ok: false, message: err.status === 401 ? 'Invalid credentials' : err.message };
      }
      throw err;
    }
  });

/** Revoke the refresh token upstream (best effort) and clear the session cookies. */
export const logoutFn = createServerFn({ method: 'POST' }).handler(async () => {
  const refreshToken = getCookie(REFRESH_COOKIE);
  if (refreshToken) {
    await cpLogout(refreshToken).catch(() => {
      // Already-revoked / unreachable: clearing cookies below still logs the user
      // out locally, which is the user-visible contract.
    });
  }
  clearSessionCookies();
  return { ok: true } as const;
});

/**
 * Resolve the current session, silently refreshing an expired access token when a
 * refresh token is present. Returns null when there is no valid session — callers
 * (route guards) MUST treat null as unauthenticated and redirect (fail closed).
 */
export const getSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ClientSession | null> => {
    const accessToken = getCookie(ACCESS_COOKIE);
    const claims = decodeAccessClaims(accessToken);

    if (claims && !isExpired(claims)) {
      return sessionFromClaims(claims);
    }

    // Access token missing or expired -> attempt a silent refresh.
    const refreshToken = getCookie(REFRESH_COOKIE);
    if (!refreshToken) {
      clearSessionCookies();
      return null;
    }
    try {
      const pair = await cpRefresh(refreshToken);
      const fresh = decodeAccessClaims(pair.accessToken);
      if (!fresh) {
        clearSessionCookies();
        return null;
      }
      writeSessionCookies(pair);
      return sessionFromClaims(fresh);
    } catch {
      // Refresh rejected (expired/revoked) or upstream down -> fail closed.
      clearSessionCookies();
      return null;
    }
  },
);
