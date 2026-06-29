import {
  oidcAuthorizeRequestSchema,
  oidcCallbackRequestSchema,
  type TokenPair,
} from '@logalot/contracts';

import { createServerFn } from '@tanstack/react-start';
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server';
import { ControlPlaneError, cpOidcAuthorize, cpOidcCallback } from './control-plane';
import {
  ACCESS_COOKIE,
  type ClientSession,
  decodeAccessClaims,
  REFRESH_COOKIE,
  sessionCookieAttributes,
  sessionFromClaims,
} from './session';

// ── OIDC / "Sign in with Google" BFF relay (server functions) ──────────────
// Tokens flow from the control-plane OIDC callback through these server functions
// into httpOnly cookies — they never touch client JS. The BFF is a thin relay:
// it holds no OIDC secrets, does no token introspection beyond reading access-token
// claims for session construction, and delegates all OIDC state and IdP interaction
// to the control-plane (T08/T09).
//
// State continuity between the authorize step and the callback is carried by three
// short-lived, SameSite=Lax cookies set here and consumed once in the callback:
//   lg_oidc_tenant  — the tenantSlug the user typed (needed at callback time to
//                     route the relay call to the right CP endpoint)
//   lg_oidc_return  — the validated `returnTo` path (optional; never absolute)
//   lg_oidc_state   — the high-entropy CSRF token extracted from the IdP redirect
//                     URL; bound to this browser so the callback can assert the
//                     returned `state` belongs to this browser's flow (R4 / T3)
//
// All three cookies are session-scoped (no Max-Age) and cleared in every exit path
// of the callback handler to avoid leakage between flows.

/** Cookie names — never read by client JS (httpOnly). */
export const OIDC_TENANT_COOKIE = 'lg_oidc_tenant';
export const OIDC_RETURN_COOKIE = 'lg_oidc_return';
export const OIDC_STATE_COOKIE = 'lg_oidc_state';

/** Shared SameSite=Lax attributes for the short-lived OIDC handshake cookies. */
function oidcCookieAttributes() {
  return {
    httpOnly: true as const,
    // Lax is required: the Google callback is a cross-site GET redirect, and a
    // Strict cookie would be stripped — breaking the flow.
    sameSite: 'lax' as const,
    path: '/' as const,
    // 10-minute TTL: generous enough for a normal OIDC round-trip, tight enough
    // to minimise the window if the user abandons the flow.
    maxAge: 60 * 10,
    // Honour the same Secure flag policy as the session cookies (driven by
    // COOKIE_SECURE env var, not NODE_ENV alone).
    secure: sessionCookieAttributes().secure,
  };
}

function clearOidcCookies(): void {
  deleteCookie(OIDC_TENANT_COOKIE, { path: '/' });
  deleteCookie(OIDC_RETURN_COOKIE, { path: '/' });
  deleteCookie(OIDC_STATE_COOKIE, { path: '/' });
}

function writeSessionCookies(pair: TokenPair): void {
  setCookie(ACCESS_COOKIE, pair.accessToken, sessionCookieAttributes());
  setCookie(REFRESH_COOKIE, pair.refreshToken, sessionCookieAttributes());
}

// ── startGoogleSignin ────────────────────────────────────────────────────────

export type StartGoogleSigninResult =
  | { ok: true; redirectUrl: string }
  | { ok: false; message: string };

/**
 * Initiate the "Sign in with Google" OIDC flow.
 *
 * Validates the request with the SHARED `oidcAuthorizeRequestSchema` (so
 * returnTo open-redirect bypasses are caught before ever leaving the BFF), then
 * relays the request to the control-plane's authorize endpoint.  On success it
 * extracts the OIDC `state` from the IdP redirect URL, binds it to this browser
 * via an httpOnly `lg_oidc_state` cookie (login-CSRF defence R4 / T3), stashes
 * the tenantSlug and returnTo in short-lived httpOnly cookies, and returns the
 * IdP redirect URL — the client (callback route) must `window.location` to it.
 */
export const startGoogleSignin = createServerFn({ method: 'POST' })
  .validator(oidcAuthorizeRequestSchema)
  .handler(async ({ data }): Promise<StartGoogleSigninResult> => {
    try {
      const { redirectUrl } = await cpOidcAuthorize(data);

      // Extract the CSRF state token from the IdP redirect URL and bind it to
      // this browser via an httpOnly cookie.  The control-plane embeds `state`
      // as a standard OIDC query parameter (RFC 6749 §4.1.1); we capture it
      // here so the callback can assert the URL-returned `state` matches what
      // was issued for THIS browser's flow — preventing login-CSRF (T3 / R4).
      let oidcState: string;
      try {
        const stateParam = new URL(redirectUrl).searchParams.get('state');
        if (!stateParam) {
          throw new Error('state absent from IdP redirect URL');
        }
        oidcState = stateParam;
      } catch {
        // The control-plane returned a redirect URL without a state parameter,
        // which violates the OIDC spec (RFC 6749 §10.12). Fail closed rather
        // than proceeding with an unbound flow.
        return { ok: false, message: 'Sign-in is temporarily unavailable. Please try again.' };
      }

      // Stash flow context in httpOnly cookies — consumed once by completeGoogleSignin.
      setCookie(OIDC_STATE_COOKIE, oidcState, oidcCookieAttributes());
      setCookie(OIDC_TENANT_COOKIE, data.tenantSlug, oidcCookieAttributes());
      if (data.returnTo) {
        setCookie(OIDC_RETURN_COOKIE, data.returnTo, oidcCookieAttributes());
      }
      return { ok: true, redirectUrl };
    } catch (err) {
      if (err instanceof ControlPlaneError) {
        console.warn(`oidc authorize failed: upstream ${err.status} ${err.code}`);
        if (err.status >= 400 && err.status < 500) {
          return { ok: false, message: 'Sign-in with Google is unavailable for this workspace.' };
        }
        return { ok: false, message: 'Sign-in is temporarily unavailable. Please try again.' };
      }
      throw err;
    }
  });

// ── completeGoogleSignin ─────────────────────────────────────────────────────

export type CompleteGoogleSigninResult =
  | { ok: true; session: ClientSession; returnTo: string | null }
  | { ok: false; message: string };

/**
 * Complete the "Sign in with Google" OIDC flow from the callback route.
 *
 * Reads the tenantSlug from the short-lived OIDC handshake cookie (set by
 * `startGoogleSignin`) and merges it with the IdP-supplied `code` + `state`
 * query params.  Before relaying to the control-plane, it asserts the
 * URL-returned `state` matches the `lg_oidc_state` cookie — this is the
 * browser-binding / login-CSRF defence required by R4 / T3.  The assembled
 * request is validated with the SHARED `oidcCallbackRequestSchema` before
 * relaying to the control-plane callback endpoint.  On success it writes the
 * session cookies and clears the handshake cookies; on failure it also clears
 * them so a stale flow cannot interfere.
 */
export const completeGoogleSignin = createServerFn({ method: 'POST' })
  .validator(oidcCallbackRequestSchema)
  .handler(async ({ data }): Promise<CompleteGoogleSigninResult> => {
    // Read the returnTo that was stashed at authorize time (may be absent).
    const returnTo = getCookie(OIDC_RETURN_COOKIE) ?? null;

    // Assert that the IdP-returned `state` matches what was bound to this browser
    // at authorize time (login-CSRF / T3 / R4). A mismatch means either the flow
    // was not started in this browser or the state was tampered with — fail closed.
    const expectedState = getCookie(OIDC_STATE_COOKIE) ?? null;
    if (!expectedState || expectedState !== data.state) {
      clearOidcCookies();
      return { ok: false, message: 'Sign-in failed' };
    }

    try {
      const pair = await cpOidcCallback(data);
      const claims = decodeAccessClaims(pair.accessToken);
      if (!claims) {
        clearOidcCookies();
        return { ok: false, message: 'Sign-in failed' };
      }
      writeSessionCookies(pair);
      clearOidcCookies();
      return { ok: true, session: sessionFromClaims(claims), returnTo };
    } catch (err) {
      clearOidcCookies();
      if (err instanceof ControlPlaneError) {
        console.warn(`oidc callback failed: upstream ${err.status} ${err.code}`);
        // Collapse all 4xx into one message — no enumeration signal.
        if (err.status >= 400 && err.status < 500) {
          return { ok: false, message: 'Sign-in failed' };
        }
        return { ok: false, message: 'Sign-in is temporarily unavailable. Please try again.' };
      }
      throw err;
    }
  });

/**
 * Read the tenantSlug from the short-lived OIDC handshake cookie.
 * Used by the callback route to reconstruct the `oidcCallbackRequestSchema`
 * payload without exposing the tenantSlug as a URL query param.
 */
export const getOidcTenantSlug = createServerFn({ method: 'GET' }).handler(
  (): string | null => getCookie(OIDC_TENANT_COOKIE) ?? null,
);
