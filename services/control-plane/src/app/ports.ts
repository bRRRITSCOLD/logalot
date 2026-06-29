import type { KeyMaterial } from '../domain/api-key';
import type {
  AlertComparator,
  AlertRule,
  ApiKeyRecord,
  Dashboard,
  DashboardLayout,
  NotifyChannel,
  OAuthIdentity,
  OAuthProvider,
  RetentionPolicy,
  RuleQuery,
  SavedQuery,
  SavedQueryFilters,
  Tenant,
  TenantStatus,
  User,
} from '../domain/entities';
import type { MembershipRole, Role } from '../domain/roles';

// ── Driven ports (the application core depends on these; adapters implement them).

// PasswordHasher abstracts the password KDF. Implemented with bcrypt for v1
// (argon2 is a drop-in alternative behind this port). Passwords are low-entropy
// human secrets, so a slow KDF is correct here (contrast: API-key / refresh-token
// secrets use fast SHA-256 because they are high-entropy — ADR-0007).
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(plaintext: string, hash: string): Promise<boolean>;
}

// SessionClaims are carried inside the access JWT. tenant + role come from the
// verified credential, never the request — this is what feeds TenantContext at
// the edge.
export interface SessionClaims {
  tenantId: string;
  principalId: string;
  role: Role;
}

// SessionTokens is the wire response of /login and /refresh — shape matches the
// shared `tokenPairSchema` contract (@logalot/contracts).
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  // Access-token lifetime in seconds (what the client uses to schedule refresh).
  expiresIn: number;
  tokenType: 'Bearer';
  role: Role;
  tenantId: string;
  userId: string;
}

// TokenService issues and verifies the short-lived, STATELESS access JWT
// (ADR-0007: signature-verified at every service edge). The stateful, rotating
// refresh credential is handled separately (RefreshTokenRepository) so it can be
// revoked — the access token's revocation story is its short TTL.
export interface TokenService {
  issueAccess(claims: SessionClaims): Promise<{ token: string; expiresInSeconds: number }>;
  verifyAccess(token: string): Promise<SessionClaims>;
}

// KeyMaterialGenerator produces the random keyId + secret for a new API key.
// Injected so minting is deterministic in tests; the production adapter uses the
// CSPRNG with the exact byte sizes the Go side uses.
export interface KeyMaterialGenerator {
  generate(): KeyMaterial;
}

// SecretGenerator yields a high-entropy hex secret (refresh-token secrets).
export interface SecretGenerator {
  generate(): string;
}

// IdGenerator yields UUIDs (refresh-token family ids) without coupling the
// application core to node:crypto.
export interface IdGenerator {
  uuid(): string;
}

export interface Clock {
  now(): Date;
}

// AuthRecord is the ONLY projection that carries a password hash out of the
// persistence layer, used exclusively by the authentication path. `role` folds in
// the platform-operator rule: platform_operator when users.is_platform_operator,
// else the membership role (or null when the user has neither — no access).
export interface AuthRecord {
  id: string;
  passwordHash: string;
  status: string;
  role: Role | null;
}

// ── Repository ports. Tenant-owned repos take `tenantId` and run every statement
// inside a transaction that arms RLS (`SET LOCAL app.tenant_id`). The `tenants`
// registry repo is unscoped (no RLS — model.md §4.5); access is gated by role.

export interface NewTenant {
  publicId: string;
  name: string;
}

export interface TenantPatch {
  name?: string;
  status?: TenantStatus;
}

export interface TenantRepository {
  create(input: NewTenant): Promise<Tenant>;
  list(): Promise<Tenant[]>;
  findById(id: string): Promise<Tenant | null>;
  findByPublicId(publicId: string): Promise<Tenant | null>;
  update(id: string, patch: TenantPatch): Promise<Tenant | null>;
  delete(id: string): Promise<boolean>;
}

export interface NewUser {
  email: string;
  passwordHash: string;
  displayName?: string | null;
  role: MembershipRole;
}

export interface UserPatch {
  displayName?: string | null;
  status?: string;
  role?: MembershipRole;
  passwordHash?: string;
}

export interface UserRepository {
  create(tenantId: string, input: NewUser): Promise<User>;
  list(tenantId: string): Promise<User[]>;
  findById(tenantId: string, id: string): Promise<User | null>;
  update(tenantId: string, id: string, patch: UserPatch): Promise<User | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
  // Authentication projections (carry the password hash + effective role).
  findCredentialsByEmail(tenantId: string, email: string): Promise<AuthRecord | null>;
  findCredentialsById(tenantId: string, id: string): Promise<AuthRecord | null>;
}

export interface NewApiKey {
  keyId: string;
  name: string;
  keyHash: Buffer;
  scopes: string[];
  createdBy: string | null;
  expiresAt: Date | null;
}

export interface ApiKeyRepository {
  create(tenantId: string, input: NewApiKey): Promise<ApiKeyRecord>;
  list(tenantId: string): Promise<ApiKeyRecord[]>;
  revoke(tenantId: string, keyId: string, now: Date): Promise<boolean>;
}

export interface RetentionInput {
  hotDays: number;
  coldDays: number;
  updatedBy: string | null;
}

export interface RetentionRepository {
  get(tenantId: string): Promise<RetentionPolicy | null>;
  upsert(tenantId: string, input: RetentionInput): Promise<RetentionPolicy>;
}

// Alert-rule persistence (Alerting context, migrations 000009 + 000013). The
// control-plane owns rule CRUD; the alert-evaluator worker owns state/evaluation,
// so this repo never writes state/last_evaluated_at/transition_seq.
export interface NewAlertRule {
  name: string;
  savedQueryId: string | null;
  query: RuleQuery;
  comparator: AlertComparator;
  threshold: number;
  windowSeconds: number;
  severity: string;
  enabled: boolean;
  notifyChannels: NotifyChannel[];
  createdBy: string | null;
}

export interface AlertRulePatch {
  name?: string;
  savedQueryId?: string | null;
  query?: RuleQuery;
  comparator?: AlertComparator;
  threshold?: number;
  windowSeconds?: number;
  severity?: string;
  enabled?: boolean;
  notifyChannels?: NotifyChannel[];
}

export interface AlertRuleRepository {
  create(tenantId: string, input: NewAlertRule): Promise<AlertRule>;
  list(tenantId: string): Promise<AlertRule[]>;
  findById(tenantId: string, id: string): Promise<AlertRule | null>;
  update(tenantId: string, id: string, patch: AlertRulePatch): Promise<AlertRule | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

// ── Saved-query repository (migration 000007) ─────────────────────────────────
// The control-plane owns SavedQuery CRUD. Alert-evaluator and panel-data read
// saved queries by identity — never through this port (the evaluator uses the
// logalot_evaluator role directly; panel-data uses the query-service LogStore).

export interface NewSavedQuery {
  name: string;
  description?: string | null;
  queryText: string;
  filters: SavedQueryFilters;
  timeRange: Record<string, unknown>;
  createdBy: string | null;
}

export interface SavedQueryPatch {
  name?: string;
  description?: string | null;
  queryText?: string;
  filters?: SavedQueryFilters;
  timeRange?: Record<string, unknown>;
}

export interface SavedQueryRepository {
  create(tenantId: string, input: NewSavedQuery): Promise<SavedQuery>;
  list(tenantId: string): Promise<SavedQuery[]>;
  findById(tenantId: string, id: string): Promise<SavedQuery | null>;
  update(tenantId: string, id: string, patch: SavedQueryPatch): Promise<SavedQuery | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

// ── Dashboard repository (migration 000008) ────────────────────────────────────

export interface NewDashboard {
  name: string;
  description?: string | null;
  layout: DashboardLayout;
  createdBy: string | null;
}

export interface DashboardPatch {
  name?: string;
  description?: string | null;
  layout?: DashboardLayout;
}

export interface DashboardRepository {
  create(tenantId: string, input: NewDashboard): Promise<Dashboard>;
  list(tenantId: string): Promise<Dashboard[]>;
  findById(tenantId: string, id: string): Promise<Dashboard | null>;
  update(tenantId: string, id: string, patch: DashboardPatch): Promise<Dashboard | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

// ── OAuth in-flight state store (issue #89) ──────────────────────────────────
// Holds the opaque `state` parameter that the control-plane generates at the
// start of an OAuth 2.0 Authorization Code flow and verifies on callback.
// Single-use: consume() atomically retrieves AND deletes in one operation.
// TTL (~10 min) mirrors the max OAuth round-trip latency (D1).

export interface OAuthStateRecord {
  /** Opaque random string that is the Redis key (also sent as OAuth `state`). */
  state: string;
  /** Tenant/user that initiated the flow — used to bind the callback. */
  tenantId: string;
  /** Arbitrary metadata (e.g. provider name, PKCE verifier, redirect uri). */
  meta: Record<string, string>;
  /** Wall-clock time the record was created, ISO-8601. */
  createdAt: string;
}

export interface OAuthStateStore {
  /**
   * Persist an OAuth state record with the given TTL (seconds).
   * The `record.state` value is used as the storage key.
   */
  put(record: OAuthStateRecord, ttlSeconds: number): Promise<void>;

  /**
   * Atomically retrieve-and-delete the record for `state`.
   * Returns null when the key is absent (expired or already consumed).
   */
  consume(state: string): Promise<OAuthStateRecord | null>;
}

// Refresh-token persistence (migration 000012). Stored hashed; rotation + family
// reuse-detection logic lives in AuthService, this port is pure storage.
export interface NewRefreshToken {
  familyId: string;
  userId: string;
  tokenHash: Buffer;
  expiresAt: Date;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface RefreshTokenRepository {
  // Inserts a token row, returning its DB-generated id (embedded in the plaintext).
  create(tenantId: string, input: NewRefreshToken): Promise<{ id: string }>;
  findById(tenantId: string, id: string): Promise<RefreshTokenRow | null>;
  // Atomically consumes the presented token and mints its successor in ONE tx.
  // The consume is a conditional UPDATE (only when the token is still un-rotated
  // and un-revoked); it is the concurrency guard against two racing presentations
  // of the same token. Returns the successor's id, or null when the token could
  // not be consumed (already rotated/revoked) — which the caller treats as reuse.
  rotate(
    tenantId: string,
    presentedId: string,
    now: Date,
    successor: NewRefreshToken,
  ): Promise<{ id: string } | null>;
  // Revokes every still-live token in a family (reuse detection / logout).
  revokeFamily(tenantId: string, familyId: string, now: Date): Promise<void>;
}

// ── Google OIDC id_token verifier + token-exchange client (issue #94) ─────────

// GoogleIdTokenClaims is the verified, strongly-typed claim set extracted from a
// Google OIDC id_token. Only the fields the auth flow actually consumes are
// declared here; the raw JWT may carry more. email_verified is always present in
// Google id_tokens and is required to be true before the claims are returned.
export interface GoogleIdTokenClaims {
  /** Stable Google account identifier (provider_sub). */
  sub: string;
  email: string;
  email_verified: boolean;
  /** The nonce the control-plane embedded at authorize time, needed to prevent replay. */
  nonce: string;
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  name?: string;
  picture?: string;
}

// GoogleIdTokenVerifier verifies a raw Google id_token (RS256 only) against
// Google's published JWKS. Enforces:
//   - alg=RS256 (none/HS* rejected at the JOSE layer before signature check)
//   - iss = https://accounts.google.com
//   - aud = configured GOOGLE_CLIENT_ID
//   - exp (jose enforces automatically)
//   - email_verified = true
//   - nonce equality (constant-time compare not needed — nonce is public)
// client_secret and id_token are NEVER logged or returned.
export interface GoogleIdTokenVerifier {
  verify(idToken: string, expectedNonce: string): Promise<GoogleIdTokenClaims>;
}

// GoogleTokenExchangeResult is the subset of Google's token-endpoint response
// the auth flow needs. client_secret is consumed inside the adapter and never
// propagates outward.
export interface GoogleTokenExchangeResult {
  /** Raw id_token JWT — caller should immediately verify it via GoogleIdTokenVerifier. */
  idToken: string;
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope?: string;
}

// GoogleTokenExchangeClient exchanges a Google authorization code (PKCE flow) for
// a token pair. The client_secret is injected from config (SSM-backed in
// production) and is never logged or returned to callers.
export interface GoogleTokenExchangeClient {
  exchange(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<GoogleTokenExchangeResult>;
}

// ── OAuthAuditLogger — structured audit trail for the OIDC auth flow ──────────
// Emitted on every outcome (success or rejection) of handleCallback. The audit
// record intentionally does NOT carry the raw provider_sub — only its SHA-256
// hex digest (hashedSub) — so the log is a privacy-safe audit trail: you can
// correlate events for a given Google account across tenants without revealing
// the sub itself (privacy-by-design, threat model R17).
//
// Outcomes:
//   first_link     — Google account linked for the first time in this tenant; session minted.
//   login          — Returning user resolved by (provider, sub); session minted.
//   reject_invalid_state    — state missing / expired / already consumed; ZERO Google calls.
//   reject_exchange_failure — Google token endpoint returned an error.
//   reject_invalid_token    — id_token failed alg/iss/aud/exp/nonce verification.
//   reject_no_provisioned_user — no email-matched user in this tenant (invite-only guard).
//   reject_account_inactive    — user exists but is suspended / role-stripped.

export type OAuthAuditOutcome =
  | 'first_link'
  | 'login'
  | 'reject_invalid_state'
  | 'reject_exchange_failure'
  | 'reject_invalid_token'
  | 'reject_no_provisioned_user'
  | 'reject_account_inactive';

export interface OAuthAuditEvent {
  /** Tenant that owns the auth flow — null only on reject_invalid_state (state is absent). */
  tenantId: string | null;
  /** Resolved user id — present only on 'first_link' and 'login' outcomes. */
  userId: string | null;
  provider: 'google';
  /** SHA-256 hex digest of provider_sub — null when sub is not yet known (e.g. invalid state). */
  hashedSub: string | null;
  outcome: OAuthAuditOutcome;
  ts: Date;
}

export interface OAuthAuditLogger {
  log(event: OAuthAuditEvent): void;
}

// ── OAuthIdentity repository (migration 000017) ────────────────────────────────
// Stores the link between an existing logalot user and an external OIDC identity
// (Google for v1). Invite-only: linkFirst() NEVER creates a user — it only writes
// a row when the caller has already resolved a matching provisioned user. Every
// statement runs under RLS armed with the tenant from OAuth `state`.

// OAuthIdentityRef is the minimal projection returned by findByProviderSub and
// linkFirst — just enough for the auth flow to mint a session.
export interface OAuthIdentityRef {
  id: string;
  userId: string;
}

export interface NewOAuthIdentity {
  userId: string;
  provider: OAuthProvider;
  providerSub: string;
  // Link-time snapshot of the matched, app-normalised email (lowercase + trim + NFC).
  email: string;
}

export interface OAuthIdentityRepository {
  // Looks up the link by (provider, provider_sub) within the armed tenant. Returns
  // the ref (id + userId) when found, null when the sub has never been linked in
  // this tenant (triggers the first-link email path in the auth flow).
  findByProviderSub(
    tenantId: string,
    provider: OAuthProvider,
    providerSub: string,
  ): Promise<OAuthIdentityRef | null>;

  // Inserts a new link row under RLS. Catches 23505 (UNIQUE violation on
  // (tenant_id, provider, provider_sub)) and re-resolves the existing row
  // idempotently — so concurrent first-link calls converge to the same identity
  // rather than raising a ConflictError. Returns the ref for the winner.
  linkFirst(tenantId: string, input: NewOAuthIdentity): Promise<OAuthIdentityRef>;

  // Updates last_login_at to now() for the given identity row under RLS. Fire-and-
  // forget from the caller's perspective; failure does NOT abort the auth flow.
  touchLastLogin(tenantId: string, id: string, now: Date): Promise<void>;

  // Full projection for debugging / admin — not used in the hot auth path.
  findById(tenantId: string, id: string): Promise<OAuthIdentity | null>;
}
