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
