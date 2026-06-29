import { createHash, randomBytes } from 'node:crypto';
import { normalizeEmail } from '../domain/email';
import { NotFoundError, ServiceUnavailableError, UnauthorizedError } from '../domain/errors';
import { assembleRefreshToken } from '../domain/refresh-token';
import type { Role } from '../domain/roles';
import { sha256 } from '../domain/secret-hash';
import type {
  Clock,
  GoogleIdTokenVerifier,
  GoogleTokenExchangeClient,
  IdGenerator,
  OAuthIdentityRepository,
  OAuthStateStore,
  RefreshTokenRepository,
  SecretGenerator,
  SessionTokens,
  TenantRepository,
  TokenService,
  UserRepository,
} from './ports';

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

export interface OidcCallbackCommand {
  code: string;
  state: string;
}

export interface OidcCallbackResult {
  tokens: SessionTokens;
  /** Relative URL the client should redirect to after login (from the state record). */
  returnTo: string;
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
  // ── Callback-half deps (required when handleCallback is invoked) ──────────
  /** Exchanges the authorization code for tokens at Google's token endpoint. */
  tokenExchangeClient: GoogleTokenExchangeClient;
  /** Verifies the Google id_token (RS256, iss, aud, exp, nonce). */
  idTokenVerifier: GoogleIdTokenVerifier;
  /** OAuth identity link persistence (oauth_identities table). */
  oauthIdentities: OAuthIdentityRepository;
  /** User credential queries (status + role needed for session minting). */
  users: UserRepository;
  /** Stateful rotating refresh-token persistence. */
  refreshTokens: RefreshTokenRepository;
  /** Access JWT issuer. */
  tokens: TokenService;
  /** Refresh-token secret generator. */
  secrets: SecretGenerator;
  /** UUID generator for refresh-token family ids. */
  ids: IdGenerator;
  /** Wall-clock — injected for deterministic testing. */
  clock: Clock;
  /** Refresh-token lifetime in seconds. */
  refreshTtlSeconds: number;
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
    if (tenant?.status !== 'active') {
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

  // handleCallback completes the OIDC Authorization Code + PKCE flow.
  //
  // Steps:
  //   1. Consume state (single-use) — 401 with ZERO Google calls if unknown/expired/consumed.
  //   2. Exchange code + verifier at Google's token endpoint — 401 on any exchange error.
  //   3. Verify id_token (alg, iss, aud, exp, nonce) — 401 on mismatch.
  //   4. Resolve identity: findByProviderSub → linkFirst on first login (invite-only: 401 when
  //      no provisioned user matches the email from the id_token).
  //   5. Mint session (access + rotating refresh token) and return it alongside returnTo.
  //
  // Security invariants:
  //   - state consumption is atomic (OAuthStateStore.consume is retrieve-and-delete).
  //   - The nonce in the state record must equal the nonce in the verified id_token claims.
  //   - No secret material (idToken, code_verifier) is ever returned or logged.
  async handleCallback(cmd: OidcCallbackCommand): Promise<OidcCallbackResult> {
    const { deps } = this;

    // 1. Consume state — single-use, returns null if missing/expired/already consumed.
    //    MUST happen BEFORE any outbound call to Google (acceptance criteria AC-1, R11).
    const stateRecord = await deps.stateStore.consume(cmd.state);
    if (!stateRecord) {
      throw new UnauthorizedError('invalid or expired OAuth state');
    }

    const { tenantId } = stateRecord;
    const codeVerifier = stateRecord.meta.codeVerifier;
    const nonce = stateRecord.meta.nonce;
    const returnTo = stateRecord.meta.returnTo ?? '/';

    if (!codeVerifier || !nonce) {
      // Corrupt state record — should never happen in a correct flow.
      throw new UnauthorizedError('malformed OAuth state record');
    }

    // 2. Exchange code for tokens at Google's token endpoint.
    //    A 4xx/5xx from Google (bad code, mismatched verifier, etc.) → 401 here.
    let idToken: string;
    try {
      const exchangeResult = await deps.tokenExchangeClient.exchange({
        code: cmd.code,
        redirectUri: deps.redirectUri,
        codeVerifier,
      });
      idToken = exchangeResult.idToken;
    } catch (err) {
      // Distinguish a genuine Google outage (5xx / network) from an auth rejection
      // (4xx). Both become 401 from the caller's perspective — we never expose which
      // Google endpoint was contacted or what it returned.
      if (err instanceof ServiceUnavailableError) throw err;
      throw new UnauthorizedError('token exchange failed');
    }

    // 3. Verify id_token: alg=RS256, iss, aud, exp (jose layer), nonce equality.
    //    GoogleIdTokenVerifier throws on any mismatch — we catch and re-throw as 401.
    //    ServiceUnavailableError (Google JWKS unreachable) is re-thrown as 503, not 401,
    //    consistent with the exchange step above.
    let claims: Awaited<ReturnType<GoogleIdTokenVerifier['verify']>>;
    try {
      claims = await deps.idTokenVerifier.verify(idToken, nonce);
    } catch (err) {
      if (err instanceof ServiceUnavailableError) throw err;
      throw new UnauthorizedError('id_token verification failed');
    }

    // 4. Resolve identity within the tenant (invite-only: no self-signup).
    const normalizedEmail = normalizeEmail(claims.email);
    let userId: string;

    const existingIdentity = await deps.oauthIdentities.findByProviderSub(
      tenantId,
      'google',
      claims.sub,
    );

    if (existingIdentity) {
      userId = existingIdentity.userId;
    } else {
      // First login for this Google account — look up the provisioned user by email.
      // invite-only: if no user exists for this email, reject with 401.
      const userRecord = await deps.users.findCredentialsByEmail(tenantId, normalizedEmail);
      if (!userRecord) {
        throw new UnauthorizedError('no provisioned account for this Google identity');
      }
      // Link the Google identity to the existing user (idempotent on 23505).
      const linked = await deps.oauthIdentities.linkFirst(tenantId, {
        userId: userRecord.id,
        provider: 'google',
        providerSub: claims.sub,
        email: normalizedEmail,
      });
      userId = linked.userId;
    }

    // 5. Load user credentials (status + role) — required for session claims.
    const record = await deps.users.findCredentialsById(tenantId, userId);
    if (record?.status !== 'active' || record.role === null) {
      throw new UnauthorizedError('account is not active');
    }

    // Fire-and-forget last-login timestamp update for returning users only.
    // Placed AFTER the active/role check so a suspended user does not have
    // last_login_at bumped before the 401 is thrown.
    if (existingIdentity) {
      const now = deps.clock.now();
      deps.oauthIdentities.touchLastLogin(tenantId, existingIdentity.id, now).catch(() => {
        // Non-fatal: login still succeeds even if the touch fails.
      });
    }

    // 6. Mint session: access JWT + rotating refresh token.
    const tokens = await this.mintSession(tenantId, record.id, record.role);
    return { tokens, returnTo };
  }

  // mintSession issues a short-lived access JWT and a stateful rotating refresh
  // token. Mirrors AuthService.login's session-minting path so token format and
  // TTL are identical regardless of the credential type used.
  private async mintSession(tenantId: string, userId: string, role: Role): Promise<SessionTokens> {
    const { deps } = this;
    const familyId = deps.ids.uuid();
    const secret = deps.secrets.generate();
    const now = deps.clock.now();
    const expiresAt = new Date(now.getTime() + deps.refreshTtlSeconds * 1000);

    const { id: tokenId } = await deps.refreshTokens.create(tenantId, {
      familyId,
      userId,
      tokenHash: sha256(secret),
      expiresAt,
    });

    const access = await deps.tokens.issueAccess({ tenantId, principalId: userId, role });
    return {
      accessToken: access.token,
      refreshToken: assembleRefreshToken(tenantId, tokenId, secret),
      expiresIn: access.expiresInSeconds,
      tokenType: 'Bearer',
      role,
      tenantId,
      userId,
    };
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
