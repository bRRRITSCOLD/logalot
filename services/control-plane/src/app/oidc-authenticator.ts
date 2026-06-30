import { createHash, randomBytes } from 'node:crypto';
import { normalizeEmail } from '../domain/email';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../domain/errors';
import { assembleRefreshToken } from '../domain/refresh-token';
import type { Role } from '../domain/roles';
import { sha256 } from '../domain/secret-hash';
import type {
  Clock,
  GoogleIdTokenVerifier,
  GoogleTokenExchangeClient,
  IdGenerator,
  InviteProvisioner,
  OAuthAuditEvent,
  OAuthAuditLogger,
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
  /**
   * SHA-256 hex digest of the one-time invite token, present when the browser
   * carries the invite cookie through the OIDC callback (ADR-0012). When absent
   * (normal login), the invite branch is skipped and the old behavior is preserved.
   * NEVER the plaintext token — only the pre-hashed value (R-INV-9).
   */
  inviteTokenHash?: string;
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
  /**
   * Structured audit logger for OIDC callback outcomes.
   * Defaults to a no-op when absent (backwards-compatible for tests that don't
   * assert on audit events).
   */
  auditLogger?: OAuthAuditLogger;
  /**
   * JIT invite provisioner (ADR-0012). When injected alongside an
   * `inviteTokenHash` on the callback command, enables the invite-acceptance
   * path: atomic consume + user+membership creation + identity link in one
   * tenant-armed transaction. Optional — absent = invite branch disabled,
   * old `reject_no_provisioned_user` behavior fully preserved.
   */
  inviteProvisioner?: InviteProvisioner;
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
// NO_OP_AUDIT_LOGGER is used when no auditLogger is injected — backwards-
// compatible default that never throws.
const NO_OP_AUDIT_LOGGER: OAuthAuditLogger = { log: () => {} };

export class OidcAuthenticator {
  private readonly stateTtlSeconds: number;
  private readonly auditLogger: OAuthAuditLogger;

  constructor(private readonly deps: OidcAuthenticatorDeps) {
    this.stateTtlSeconds = deps.stateTtlSeconds ?? OAUTH_STATE_TTL_SECONDS;
    this.auditLogger = deps.auditLogger ?? NO_OP_AUDIT_LOGGER;
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
  //
  // Audit: every exit path emits an OAuthAuditEvent via the injected auditLogger.
  // The raw provider_sub is NEVER logged — only its SHA-256 hex digest (hashedSub).
  async handleCallback(cmd: OidcCallbackCommand): Promise<OidcCallbackResult> {
    const { deps } = this;

    // 1. Consume state — single-use, returns null if missing/expired/already consumed.
    //    MUST happen BEFORE any outbound call to Google (acceptance criteria AC-1, R11).
    const stateRecord = await deps.stateStore.consume(cmd.state);
    if (!stateRecord) {
      this.audit({
        tenantId: null,
        userId: null,
        hashedSub: null,
        outcome: 'reject_invalid_state',
      });
      throw new UnauthorizedError('invalid or expired OAuth state');
    }

    const { tenantId } = stateRecord;
    const codeVerifier = stateRecord.meta.codeVerifier;
    const nonce = stateRecord.meta.nonce;
    const returnTo = stateRecord.meta.returnTo ?? '/';

    if (!codeVerifier || !nonce) {
      // Corrupt state record — should never happen in a correct flow.
      this.audit({ tenantId, userId: null, hashedSub: null, outcome: 'reject_invalid_state' });
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
      this.audit({ tenantId, userId: null, hashedSub: null, outcome: 'reject_exchange_failure' });
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
      this.audit({ tenantId, userId: null, hashedSub: null, outcome: 'reject_invalid_token' });
      if (err instanceof ServiceUnavailableError) throw err;
      throw new UnauthorizedError('id_token verification failed');
    }

    // Sub is now known — pre-compute the hashed value for all remaining audit calls.
    const hashedSub = hashProviderSub(claims.sub);

    // 4. Resolve identity within the tenant (invite-only: no self-signup).
    const normalizedEmail = normalizeEmail(claims.email);
    let userId: string;
    let isFirstLink: boolean;

    const existingIdentity = await deps.oauthIdentities.findByProviderSub(
      tenantId,
      'google',
      claims.sub,
    );

    if (existingIdentity) {
      userId = existingIdentity.userId;
      isFirstLink = false;
    } else {
      // First login for this Google account — look up the provisioned user by email.
      // invite-only: if no user exists for this email, try the invite path if an
      // inviteProvisioner and inviteTokenHash are both present. Otherwise reject.
      const userRecord = await deps.users.findCredentialsByEmail(tenantId, normalizedEmail);
      if (!userRecord) {
        const { inviteProvisioner } = deps;
        const { inviteTokenHash } = cmd;

        if (inviteProvisioner && inviteTokenHash) {
          // Invite branch (ADR-0012): delegate atomic consume + user creation +
          // identity link to the provisioner. Returns { userId } on success, null
          // on any consume miss (expired, revoked, already consumed, race loser).
          // invite_provisioned audit is emitted inside the provisioner (T9).
          const provisioned = await inviteProvisioner.provisionFromInvite(tenantId, {
            email: normalizedEmail,
            inviteTokenHash,
            providerSub: claims.sub,
            now: deps.clock.now(),
          });

          if (provisioned) {
            // Provisioner performed the atomic linkFirst — skip the in-branch
            // linkFirst below. isFirstLink=true drives the first_link audit at step 7.
            userId = provisioned.userId;
            isFirstLink = true;
          } else {
            // Consume miss: expired, revoked, already used, or race loser.
            // Uniform 401 — body identical to reject_no_provisioned_user (R-INV-6).
            this.audit({ tenantId, userId: null, hashedSub, outcome: 'reject_no_valid_invite' });
            throw new UnauthorizedError('no provisioned account for this Google identity');
          }
        } else {
          // No invite path configured (or no token presented): unchanged old behavior.
          this.audit({ tenantId, userId: null, hashedSub, outcome: 'reject_no_provisioned_user' });
          throw new UnauthorizedError('no provisioned account for this Google identity');
        }
      } else {
        // Link the Google identity to the existing user. Idempotent on a concurrent
        // SAME-sub first-link (23505 on the sub uniqueness → returns the winner). But a
        // DIFFERENT-sub conflict for an already-linked user (23505 on
        // UNIQUE(tenant_id,user_id,provider)) is surfaced as a ConflictError: this user
        // is sub-pinned to another Google identity (threat model R13), so reject 401 —
        // never silently re-link, and never leak which constraint tripped.
        let linked: Awaited<ReturnType<typeof deps.oauthIdentities.linkFirst>>;
        try {
          linked = await deps.oauthIdentities.linkFirst(tenantId, {
            userId: userRecord.id,
            provider: 'google',
            providerSub: claims.sub,
            email: normalizedEmail,
          });
        } catch (err) {
          if (err instanceof ConflictError) {
            this.audit({ tenantId, userId: null, hashedSub, outcome: 'reject_identity_conflict' });
            throw new UnauthorizedError('no provisioned account for this Google identity');
          }
          throw err;
        }
        userId = linked.userId;
        isFirstLink = true;
      }
    }

    // 5. Load user credentials (status + role) — required for session claims.
    const record = await deps.users.findCredentialsById(tenantId, userId);
    if (record?.status !== 'active' || record.role === null) {
      this.audit({ tenantId, userId, hashedSub, outcome: 'reject_account_inactive' });
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

    // 7. Emit success audit event (first_link or login).
    this.audit({
      tenantId,
      userId: record.id,
      hashedSub,
      outcome: isFirstLink ? 'first_link' : 'login',
    });

    return { tokens, returnTo };
  }

  // audit emits a structured OAuthAuditEvent via the injected logger. Failures
  // in the logger are swallowed — audit logging must never abort the auth flow.
  private audit(
    fields: Pick<OAuthAuditEvent, 'tenantId' | 'userId' | 'hashedSub' | 'outcome'>,
  ): void {
    try {
      this.auditLogger.log({
        ...fields,
        provider: 'google',
        ts: this.deps.clock.now(),
      });
    } catch {
      // Non-fatal: audit failure must never propagate to the caller.
    }
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

// hashProviderSub returns the SHA-256 hex digest of a provider subject
// identifier (Google's stable `sub`). The raw sub is NEVER logged — only this
// digest — so the audit trail is a privacy-safe correlator (threat model R17).
function hashProviderSub(sub: string): string {
  return createHash('sha256').update(sub, 'utf8').digest('hex');
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
