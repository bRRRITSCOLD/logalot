import {
  oidcAuthorizeRequestSchema,
  oidcCallbackRequestSchema,
  parseInviteTenantSlug,
  type TokenPair,
} from '@logalot/contracts';

import { createServerFn } from '@tanstack/react-start';
import {
  deleteCookie,
  getCookie,
  setCookie,
  setResponseHeader,
} from '@tanstack/react-start/server';
import { z } from 'zod';
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
//
// A fourth, related cookie is stashed by the `/invite/accept` route (not this
// file's authorize step, since an invite flow skips it) and consumed here:
//   lg_invite_token — the plaintext invite token, moved out of the URL into
//                     this httpOnly cookie the moment `/invite/accept` is hit
//                     (R-INV-11). `completeGoogleSignin` reads it and relays
//                     it to the control-plane callback endpoint in the request
//                     BODY only (R-INV-12) — it is NEVER placed in the
//                     onward redirect to Google (R-INV-11).

/** Cookie names — never read by client JS (httpOnly). */
export const OIDC_TENANT_COOKIE = 'lg_oidc_tenant';
export const OIDC_RETURN_COOKIE = 'lg_oidc_return';
export const OIDC_STATE_COOKIE = 'lg_oidc_state';
export const INVITE_TOKEN_COOKIE = 'lg_invite_token';

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
  // Every exit path of completeGoogleSignin calls this, so the invite
  // handshake cookie is cleared alongside the others on both success and
  // failure — no separate call site needed.
  deleteCookie(INVITE_TOKEN_COOKIE, { path: '/' });
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
 *
 * If an `/invite/accept` flow stashed a `lg_invite_token` cookie, its plaintext
 * value is read here and merged into the control-plane relay body as
 * `inviteToken` (R-INV-12: body only, never a query param, and never accepted
 * as caller-supplied input — it comes solely from the httpOnly cookie).
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

    // Thread the invite token (if any) into the relay body only — it never
    // travels as a query param and the caller cannot inject one via `data`
    // (oidcCallbackRequestSchema is `.strict()`, so `data.inviteToken` here
    // can only have come from this cookie read, not the client call site).
    const inviteToken = getCookie(INVITE_TOKEN_COOKIE) ?? undefined;
    const callbackBody = inviteToken ? { ...data, inviteToken } : data;

    try {
      const pair = await cpOidcCallback(callbackBody);
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

// ── Invite-accept handshake ─────────────────────────────────────────────────
// Consumed by `/invite/accept` (apps/web/src/routes/invite/accept.tsx). That
// route is the ONLY writer of `lg_invite_token`; `completeGoogleSignin` above
// is the only reader that forwards it onward (to the control-plane, in the
// body — R-INV-12). Kept in this file because it is part of the same OIDC
// handshake-cookie family and lifecycle (10-minute TTL, cleared on every exit
// path of the callback).

export type StashInviteTokenResult = { ok: true } | { ok: false };

/**
 * Move an invite token out of the URL and into the httpOnly `lg_invite_token`
 * handshake cookie (R-INV-11). Also sets `Referrer-Policy: no-referrer` on
 * this response so the token-bearing URL is never leaked via the Referer
 * header of any onward navigation (R-INV-11).
 *
 * The token is validated for SHAPE only (non-secret prefix + tenant public id
 * parse) — malformed input is rejected and nothing is stashed, so the accept
 * route fails closed once it finds no usable cookie. The secret component is
 * never inspected or logged here; it travels opaquely inside the cookie value
 * until the control-plane consumes it.
 */
export const stashInviteToken = createServerFn({ method: 'POST' })
  .validator(z.object({ token: z.string().min(1).max(512) }))
  .handler(({ data }): StashInviteTokenResult => {
    // Set unconditionally, before any validation branch, so the header is
    // present on this response regardless of how the token turns out.
    setResponseHeader('Referrer-Policy', 'no-referrer');

    if (!parseInviteTenantSlug(data.token)) {
      return { ok: false };
    }

    setCookie(INVITE_TOKEN_COOKIE, data.token, oidcCookieAttributes());
    return { ok: true };
  });

/**
 * Read the NON-SECRET tenant slug embedded in the stashed invite token
 * (`lg_invite_token`). Used by the accept route, after the token has been
 * moved out of the URL, to drive `startGoogleSignin({ tenantSlug })` without
 * ever letting the invitee supply their own tenant/workspace value (R-INV-20).
 */
export const getInviteTenantSlug = createServerFn({ method: 'GET' }).handler((): string | null => {
  const token = getCookie(INVITE_TOKEN_COOKIE);
  return token ? parseInviteTenantSlug(token) : null;
});
