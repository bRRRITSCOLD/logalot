import { createHash, randomBytes } from 'node:crypto';
import { NotFoundError } from '../domain/errors';
import type { OAuthStateStore, TenantRepository } from './ports';

// PKCE constants (RFC 7636).
// State: 32 bytes → 256 bits of entropy (≥128-bit as required by the spec).
// code_verifier: 32 bytes → base64url, satisfying the 43-128 char length requirement.
const STATE_BYTES = 32;
const NONCE_BYTES = 32;
const CODE_VERIFIER_BYTES = 32;

// DEFAULT_RETURN_TO is used when the caller supplies no returnTo or one that
// fails the allowlist check (relative path starting with a single `/`, no
// control characters — mirrors returnToSchema from @logalot/contracts).
const DEFAULT_RETURN_TO = '/';

// OAuth state TTL — 10 minutes is standard for OIDC authorization code flows.
const OAUTH_STATE_TTL_SECONDS = 600;

// FIXED_SCOPES for Google OIDC: openid + email (no profile to minimize PII
// exposure — email is all the provisioning path needs for first-link matching).
const GOOGLE_SCOPES = 'openid email';

export interface OidcAuthorizeCommand {
  tenantSlug: string;
  returnTo?: string | undefined;
}

export interface OidcAuthorizeResult {
  /** Absolute URL the client must redirect the browser to. */
  redirectUrl: string;
}

export interface OidcAuthenticatorDeps {
  tenants: TenantRepository;
  stateStore: OAuthStateStore;
  /** Google OIDC client ID (from config). */
  clientId: string;
  /** Fixed server-side redirect URI registered in Google Cloud Console. */
  redirectUri: string;
  /** Google OIDC authorization endpoint (defaults to accounts.google.com). */
  authEndpoint: string;
  /** TTL for the OAuth state record (seconds, defaults to 600). */
  stateTtlSeconds?: number;
}

// OidcAuthenticator owns the OIDC authorization-initiation half of the
// authorization code + PKCE flow (ADR-0007, R6). It:
//   1. Resolves and validates the tenant.
//   2. Generates a cryptographically random state (256-bit), nonce, and
//      code_verifier; derives the S256 code_challenge from the verifier.
//   3. Persists the state record (verifier + nonce + returnTo) in the
//      OAuthStateStore for the callback to retrieve.
//   4. Returns the IdP authorization URL — the client must redirect to it.
//
// Security invariants:
//   - redirect_uri is ALWAYS the fixed server value from config (never from the
//     request). Open-redirect prevention: the client cannot influence where the
//     IdP delivers the authorization code.
//   - state is server-generated (256-bit CSPRNG). The callback will verify it,
//     preventing CSRF.
//   - returnTo is validated against the same allowlist as returnToSchema in
//     @logalot/contracts: relative path, single leading /, no control chars.
//     Anything that fails falls back to DEFAULT_RETURN_TO.
export class OidcAuthenticator {
  private readonly stateTtlSeconds: number;

  constructor(private readonly deps: OidcAuthenticatorDeps) {
    this.stateTtlSeconds = deps.stateTtlSeconds ?? OAUTH_STATE_TTL_SECONDS;
  }

  async beginAuthorize(cmd: OidcAuthorizeCommand): Promise<OidcAuthorizeResult> {
    // 1. Resolve tenant — 404 when slug is unknown or tenant is not active.
    const tenant = await this.deps.tenants.findByPublicId(cmd.tenantSlug);
    if (!tenant || tenant.status !== 'active') {
      throw new NotFoundError(`tenant '${cmd.tenantSlug}' not found`);
    }

    // 2. Generate PKCE + anti-CSRF material.
    const stateBytes = randomBytes(STATE_BYTES); // 256-bit
    const state = stateBytes.toString('base64url');

    const nonce = randomBytes(NONCE_BYTES).toString('base64url');

    const codeVerifier = randomBytes(CODE_VERIFIER_BYTES).toString('base64url');
    const codeChallenge = codeVerifierToChallenge(codeVerifier);

    // 3. Sanitize returnTo — only accept relative paths with a single leading /.
    const returnTo = sanitizeReturnTo(cmd.returnTo);

    // 4. Persist the state record so the callback can recover the verifier and nonce.
    await this.deps.stateStore.put(
      {
        state,
        tenantId: tenant.id,
        meta: {
          provider: 'google',
          codeVerifier,
          nonce,
          returnTo,
        },
        createdAt: new Date().toISOString(),
      },
      this.stateTtlSeconds,
    );

    // 5. Build the IdP authorization URL.
    const params = new URLSearchParams({
      client_id: this.deps.clientId,
      redirect_uri: this.deps.redirectUri, // FIXED — never from request
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const redirectUrl = `${this.deps.authEndpoint}?${params.toString()}`;

    return { redirectUrl };
  }
}

// codeVerifierToChallenge computes the S256 code_challenge as defined in
// RFC 7636 §4.2: BASE64URL(SHA256(ASCII(code_verifier))).
function codeVerifierToChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// sanitizeReturnTo applies the same allowlist as returnToSchema in
// @logalot/contracts: relative path starting with exactly one `/`, no `//`,
// no `\`, and no C0/DEL control characters.  Returns DEFAULT_RETURN_TO for
// anything that doesn't pass.
//
// We intentionally do NOT import the zod schema here (no runtime dep on the
// contracts package inside the app layer), keeping the domain pure.
function sanitizeReturnTo(value: string | undefined): string {
  if (!value) return DEFAULT_RETURN_TO;
  const trimmed = value.trim();
  if (!isValidReturnTo(trimmed)) return DEFAULT_RETURN_TO;
  return trimmed;
}

function isValidReturnTo(v: string): boolean {
  if (v.length === 0 || v.length > 2000) return false;
  // Must start with exactly one `/` — not `//` (protocol-relative) or `/\` (IE open-redirect).
  if (!/^\/(?![/\\])/.test(v)) return false;
  // Reject C0 control characters (U+0000-U+001F) and DEL (U+007F).
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}
