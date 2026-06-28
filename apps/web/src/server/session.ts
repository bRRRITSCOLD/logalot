import { type AccessClaims, accessClaimsSchema, type Role } from '@logalot/contracts';

// Session primitives shared by the BFF server functions. Kept pure (no cookie or
// network I/O) so the trust-critical logic — what counts as a valid, unexpired
// session and what tenant/role it carries — is unit-testable in isolation.

/** httpOnly cookie names. Deliberately opaque; never read from client JS. */
export const ACCESS_COOKIE = 'lg_at';
export const REFRESH_COOKIE = 'lg_rt';

/**
 * The session shape exposed to the client. Tenancy is SERVER-DERIVED from the
 * verified access-token claims — there is no field a client can supply to change
 * which tenant it is. Mirrors the control-plane's "tenant from credential, never
 * from request body" contract (ADR-0007 / auth-plugin.ts).
 */
export interface ClientSession {
  userId: string;
  tenantId: string;
  role: Role;
  /** Access-token expiry, seconds since epoch. */
  expiresAt: number;
}

/** Base64URL-decode a JWT segment to its UTF-8 string. */
export function base64UrlDecode(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Decode (NOT verify) an access JWT's claims. The BFF only needs the claims for
 * UX routing/expiry; cryptographic verification is the control-plane's job on
 * every proxied call (it holds JWT_SECRET, the BFF does not). A malformed or
 * non-conforming token yields null so callers can fail closed.
 */
export function decodeAccessClaims(token: string | undefined): AccessClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed = accessClaimsSchema.safeParse(JSON.parse(base64UrlDecode(parts[1] as string)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Whether a token is expired (or within the clock-skew window). A 30s skew means
 * we refresh slightly early rather than racing the boundary on a real request.
 */
export function isExpired(
  claims: Pick<AccessClaims, 'exp'>,
  nowMs: number = Date.now(),
  skewSeconds = 30,
): boolean {
  return claims.exp <= Math.floor(nowMs / 1000) + skewSeconds;
}

export function sessionFromClaims(claims: AccessClaims): ClientSession {
  return {
    userId: claims.sub,
    tenantId: claims.tenant_id,
    role: claims.role,
    expiresAt: claims.exp,
  };
}

// ── Session-cookie policy: the SINGLE source of truth ───────────────────────
// Both the normal write path (auth.ts via the framework `setCookie` helper) AND
// the streaming-response path (tail-proxy.ts, which must emit a RAW `Set-Cookie`
// header because an SSE Response can't use `setCookie`) consume these. Keeping the
// Secure / SameSite / HttpOnly / Max-Age policy in one place removes the
// silent-divergence risk of defining a security control twice.

/** Cookie lifetime; tracks the refresh-token window (control-plane default 7d). */
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/**
 * Whether to set the `Secure` cookie flag. Defaults ON (fail safe) and is driven by
 * an explicit transport signal, NOT solely `NODE_ENV`: an HTTPS staging deploy may
 * run with `NODE_ENV` unset/`staging` yet must still receive `Secure` cookies.
 * `COOKIE_SECURE=true|false` overrides explicitly; otherwise only plain-http local
 * dev (`NODE_ENV=development`) opts out so dev cookies send over http://localhost.
 */
export function sessionCookieSecure(): boolean {
  const explicit = process.env.COOKIE_SECURE;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return process.env.NODE_ENV !== 'development';
}

export interface SessionCookieAttributes {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/** The attribute set for a session cookie, for the framework `setCookie` helper. */
export function sessionCookieAttributes(): SessionCookieAttributes {
  return {
    httpOnly: true,
    secure: sessionCookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE,
  };
}

/**
 * Serialize a session cookie to a raw `Set-Cookie` header value, consistent with
 * `sessionCookieAttributes()`. Used by the SSE proxy, whose streaming Response
 * cannot go through the framework `setCookie` helper.
 */
export function serializeSessionCookie(name: string, value: string): string {
  const a = sessionCookieAttributes();
  return [
    `${name}=${value}`,
    `Max-Age=${a.maxAge}`,
    `Path=${a.path}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(a.secure ? ['Secure'] : []),
  ].join('; ');
}
