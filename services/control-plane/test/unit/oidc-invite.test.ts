/**
 * Unit tests for the invite branch wired into OidcAuthenticator (issue #150).
 *
 * Verifies ADR-0012 requirements:
 *   R-INV-6  — uniform 401 body (no enumeration oracle)
 *   R-INV-8  — invite branch is new-principal-only (existing user bypasses it)
 *   R-INV-9  — audit outcomes never carry the raw token or provider_sub
 *
 * All repos are faked in-memory; no I/O.
 */
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OidcAuthenticator, type OidcAuthenticatorDeps } from '../../src/app/oidc-authenticator';
import type {
  AuthRecord,
  Clock,
  GoogleIdTokenClaims,
  GoogleIdTokenVerifier,
  GoogleTokenExchangeClient,
  GoogleTokenExchangeResult,
  IdGenerator,
  InviteProvisioner,
  NewRefreshToken,
  OAuthAuditEvent,
  OAuthAuditLogger,
  OAuthAuditOutcome,
  OAuthIdentityRef,
  OAuthIdentityRepository,
  OAuthStateRecord,
  OAuthStateStore,
  ProvisionFromInviteInput,
  RefreshTokenRepository,
  SecretGenerator,
  TokenService,
  UserRepository,
} from '../../src/app/ports';
import type { OAuthProvider } from '../../src/domain/entities';
import { UnauthorizedError } from '../../src/domain/errors';
import type { Role } from '../../src/domain/roles';

// ── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const PROVISIONED_USER_ID = '00000000-0000-0000-0000-000000000003';
const GOOGLE_SUB = 'google-sub-invite-001';
const INVITE_TOKEN_HASH = createHash('sha256').update('plaintext-token', 'utf8').digest('hex');
const REDIRECT_URI = 'https://app.logalot.dev/auth/oidc/google/callback';

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeOAuthStateStore implements OAuthStateStore {
  private readonly entries = new Map<string, OAuthStateRecord>();

  async put(record: OAuthStateRecord): Promise<void> {
    this.entries.set(record.state, record);
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const record = this.entries.get(state);
    if (!record) return null;
    this.entries.delete(state);
    return record;
  }

  seed(record: OAuthStateRecord): void {
    this.entries.set(record.state, record);
  }
}

class FakeTokenExchangeClient implements GoogleTokenExchangeClient {
  async exchange(_params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<GoogleTokenExchangeResult> {
    return {
      idToken: 'fake.id.token',
      accessToken: 'goog-access',
      tokenType: 'Bearer',
      expiresIn: 3600,
    };
  }
}

class FakeIdTokenVerifier implements GoogleIdTokenVerifier {
  private claims: GoogleIdTokenClaims = {
    sub: GOOGLE_SUB,
    email: 'invited@example.com',
    email_verified: true,
    nonce: 'valid-nonce',
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  setClaims(c: GoogleIdTokenClaims): void {
    this.claims = c;
  }

  async verify(_idToken: string, _nonce: string): Promise<GoogleIdTokenClaims> {
    return this.claims;
  }
}

class FakeOAuthIdentityRepo implements OAuthIdentityRepository {
  private identities = new Map<string, OAuthIdentityRef>();
  linkFirstCallCount = 0;
  touchLastLoginCallCount = 0;

  seed(provider: string, sub: string, ref: OAuthIdentityRef): void {
    this.identities.set(`${provider}:${sub}`, ref);
  }

  async findByProviderSub(
    _tenantId: string,
    provider: OAuthProvider,
    sub: string,
  ): Promise<OAuthIdentityRef | null> {
    return this.identities.get(`${provider}:${sub}`) ?? null;
  }

  async touchLastLogin(_tenantId: string, _id: string, _now: Date): Promise<void> {
    this.touchLastLoginCallCount++;
  }

  async linkFirst(_tenantId: string, input: { userId: string }): Promise<OAuthIdentityRef> {
    this.linkFirstCallCount++;
    return { id: randomUUID(), userId: input.userId };
  }

  async findById(): Promise<null> {
    return null;
  }
}

class FakeUserRepo implements UserRepository {
  private credsByEmail = new Map<string, AuthRecord>();
  private credsById = new Map<string, AuthRecord>();

  seedEmail(email: string, record: AuthRecord): void {
    this.credsByEmail.set(email, record);
    this.credsById.set(record.id, record);
  }

  seedId(id: string, record: AuthRecord): void {
    this.credsById.set(id, record);
  }

  async findCredentialsByEmail(_tenantId: string, email: string): Promise<AuthRecord | null> {
    return this.credsByEmail.get(email) ?? null;
  }

  async findCredentialsById(_tenantId: string, id: string): Promise<AuthRecord | null> {
    return this.credsById.get(id) ?? null;
  }

  async create(): Promise<never> {
    throw new Error('stub');
  }
  async list(): Promise<never[]> {
    return [];
  }
  async findById(): Promise<null> {
    return null;
  }
  async update(): Promise<null> {
    return null;
  }
  async delete(): Promise<boolean> {
    return false;
  }
}

class FakeRefreshTokenRepo implements RefreshTokenRepository {
  createCallCount = 0;

  async create(_tenantId: string, _input: NewRefreshToken): Promise<{ id: string }> {
    this.createCallCount++;
    return { id: randomUUID() };
  }

  async findById(): Promise<null> {
    return null;
  }
  async rotate(): Promise<null> {
    return null;
  }
  async revokeFamily(): Promise<void> {}
}

class FakeTokenService implements TokenService {
  async issueAccess(claims: { tenantId: string; principalId: string; role: Role }) {
    return {
      token: `fake.access.${claims.principalId}`,
      expiresInSeconds: 900,
    };
  }

  async verifyAccess(): Promise<never> {
    throw new Error('stub');
  }
}

/** Controllable InviteProvisioner fake. */
class FakeInviteProvisioner implements InviteProvisioner {
  callCount = 0;
  lastInput: (ProvisionFromInviteInput & { tenantId: string }) | null = null;
  private result: { userId: string } | null = { userId: PROVISIONED_USER_ID };

  setResult(r: { userId: string } | null): void {
    this.result = r;
  }

  async provisionFromInvite(
    tenantId: string,
    input: ProvisionFromInviteInput,
  ): Promise<{ userId: string } | null> {
    this.callCount++;
    this.lastInput = { tenantId, ...input };
    return this.result;
  }
}

/** Capturing audit logger. */
class CapturingAuditLogger implements OAuthAuditLogger {
  readonly events: OAuthAuditEvent[] = [];

  log(event: OAuthAuditEvent): void {
    this.events.push(event);
  }

  lastOutcome(): OAuthAuditOutcome | undefined {
    return this.events.at(-1)?.outcome;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeStateRecord(overrides?: Partial<OAuthStateRecord>): OAuthStateRecord {
  return {
    state: 'valid-state-token',
    tenantId: TENANT_ID,
    meta: {
      provider: 'google',
      codeVerifier: 'valid-code-verifier',
      nonce: 'valid-nonce',
      returnTo: '/dashboard',
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeUserRecord(overrides?: Partial<AuthRecord>): AuthRecord {
  return {
    id: USER_ID,
    passwordHash: 'irrelevant',
    status: 'active',
    role: 'member',
    ...overrides,
  };
}

function makeProvisionedUserRecord(overrides?: Partial<AuthRecord>): AuthRecord {
  return {
    id: PROVISIONED_USER_ID,
    passwordHash: 'irrelevant',
    status: 'active',
    role: 'member',
    ...overrides,
  };
}

interface FakeContext {
  sut: OidcAuthenticator;
  stateStore: FakeOAuthStateStore;
  identityRepo: FakeOAuthIdentityRepo;
  userRepo: FakeUserRepo;
  refreshTokenRepo: FakeRefreshTokenRepo;
  inviteProvisioner: FakeInviteProvisioner;
  auditLogger: CapturingAuditLogger;
}

function makeDepsWithInvite(overrides?: Partial<OidcAuthenticatorDeps>): FakeContext {
  const stateStore = new FakeOAuthStateStore();
  const exchangeClient = new FakeTokenExchangeClient();
  const idTokenVerifier = new FakeIdTokenVerifier();
  const identityRepo = new FakeOAuthIdentityRepo();
  const userRepo = new FakeUserRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const tokenService = new FakeTokenService();
  const inviteProvisioner = new FakeInviteProvisioner();
  const auditLogger = new CapturingAuditLogger();

  const clock: Clock = { now: () => new Date('2025-01-01T00:00:00Z') };
  const secrets: SecretGenerator = { generate: () => 'fake-secret-32-bytes-long-enough' };
  const ids: IdGenerator = { uuid: () => randomUUID() };

  const deps: OidcAuthenticatorDeps = {
    tenants: {
      create: vi.fn(),
      list: vi.fn(),
      findById: vi.fn(),
      findByPublicId: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    stateStore,
    clientId: 'google-client-id',
    redirectUri: REDIRECT_URI,
    authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    stateTtlSeconds: 600,
    tokenExchangeClient: exchangeClient,
    idTokenVerifier,
    oauthIdentities: identityRepo,
    users: userRepo as unknown as OidcAuthenticatorDeps['users'],
    refreshTokens: refreshTokenRepo,
    tokens: tokenService,
    secrets,
    ids,
    clock,
    refreshTtlSeconds: 604800,
    inviteProvisioner,
    auditLogger,
    ...overrides,
  };

  return {
    sut: new OidcAuthenticator(deps),
    stateStore,
    identityRepo,
    userRepo,
    refreshTokenRepo,
    inviteProvisioner,
    auditLogger,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OidcAuthenticator — invite branch (ADR-0012)', () => {
  // ── AC: unchanged behavior when no invite involved ────────────────────────

  describe('control preservation: no provisioner + no inviteTokenHash', () => {
    it('audits reject_no_provisioned_user (old outcome, unchanged)', async () => {
      // No inviteProvisioner, no inviteTokenHash — should be byte-for-byte old behavior.
      const { sut, stateStore, auditLogger } = makeDepsWithInvite({
        inviteProvisioner: undefined,
      });
      stateStore.seed(makeStateRecord());
      // No identity, no user in repo → invite-only rejection path.

      await sut.handleCallback({ code: 'code', state: 'valid-state-token' }).catch(() => {});

      expect(auditLogger.lastOutcome()).toBe('reject_no_provisioned_user');
    });

    it('throws UnauthorizedError with the same message as the old path', async () => {
      const { sut, stateStore } = makeDepsWithInvite({ inviteProvisioner: undefined });
      stateStore.seed(makeStateRecord());

      await expect(
        sut.handleCallback({ code: 'code', state: 'valid-state-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('audits reject_no_provisioned_user when provisioner is injected but no token hash presented', async () => {
      // Provisioner present, but no inviteTokenHash in cmd → same old behavior.
      const { sut, stateStore, auditLogger, inviteProvisioner } = makeDepsWithInvite();
      stateStore.seed(makeStateRecord());

      await sut
        .handleCallback({ code: 'code', state: 'valid-state-token' /* no inviteTokenHash */ })
        .catch(() => {});

      // Provisioner must NOT be called (no token was presented).
      expect(inviteProvisioner.callCount).toBe(0);
      expect(auditLogger.lastOutcome()).toBe('reject_no_provisioned_user');
    });
  });

  // ── AC: reject_no_valid_invite when provisioner returns null ──────────────

  describe('provisioner returns null (consume miss)', () => {
    let ctx: FakeContext;

    beforeEach(() => {
      ctx = makeDepsWithInvite();
      ctx.stateStore.seed(makeStateRecord());
      ctx.inviteProvisioner.setResult(null); // simulate consume miss
    });

    it('throws UnauthorizedError', async () => {
      await expect(
        ctx.sut.handleCallback({
          code: 'code',
          state: 'valid-state-token',
          inviteTokenHash: INVITE_TOKEN_HASH,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('audits reject_no_valid_invite', async () => {
      await ctx.sut
        .handleCallback({
          code: 'code',
          state: 'valid-state-token',
          inviteTokenHash: INVITE_TOKEN_HASH,
        })
        .catch(() => {});

      expect(ctx.auditLogger.lastOutcome()).toBe('reject_no_valid_invite');
    });

    it('error message is identical to reject_no_provisioned_user path (R-INV-6)', async () => {
      // Both paths must throw the same UnauthorizedError message — no enumeration oracle.
      let inviteErrMsg = '';
      await ctx.sut
        .handleCallback({
          code: 'code',
          state: 'valid-state-token',
          inviteTokenHash: INVITE_TOKEN_HASH,
        })
        .catch((err: unknown) => {
          if (err instanceof UnauthorizedError) inviteErrMsg = err.message;
        });

      // Capture the old-path message.
      const { sut: oldSut, stateStore: oldStore } = makeDepsWithInvite({
        inviteProvisioner: undefined,
      });
      oldStore.seed(makeStateRecord({ state: 'old-path-state' }));
      let oldErrMsg = '';
      await oldSut
        .handleCallback({ code: 'code', state: 'old-path-state' })
        .catch((err: unknown) => {
          if (err instanceof UnauthorizedError) oldErrMsg = err.message;
        });

      expect(inviteErrMsg).toBe(oldErrMsg);
      expect(inviteErrMsg).toBeTruthy();
    });

    it('passes the correct inputs to the provisioner (R-INV-9 — no raw token)', async () => {
      await ctx.sut
        .handleCallback({
          code: 'code',
          state: 'valid-state-token',
          inviteTokenHash: INVITE_TOKEN_HASH,
        })
        .catch(() => {});

      expect(ctx.inviteProvisioner.callCount).toBe(1);
      // lastInput is set by the fake when callCount > 0 — guaranteed by the assertion above.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const input = ctx.inviteProvisioner.lastInput as NonNullable<
        typeof ctx.inviteProvisioner.lastInput
      >;
      // Tenant must be passed correctly.
      expect(input.tenantId).toBe(TENANT_ID);
      // Email must be the normalized value from the id_token.
      expect(input.email).toBe('invited@example.com');
      // inviteTokenHash is the pre-hashed value — not the raw plaintext.
      expect(input.inviteTokenHash).toBe(INVITE_TOKEN_HASH);
      // providerSub from the verified token.
      expect(input.providerSub).toBe(GOOGLE_SUB);
      // Audit log must NOT contain raw sub or token.
      const auditedSub = ctx.auditLogger.events.some(
        (e) => (e as OAuthAuditEvent & { sub?: string }).sub === GOOGLE_SUB,
      );
      expect(auditedSub).toBe(false);
    });
  });

  // ── AC: successful provisioning mints a session ───────────────────────────

  describe('provisioner returns { userId } (happy path)', () => {
    let ctx: FakeContext;

    beforeEach(() => {
      ctx = makeDepsWithInvite();
      ctx.stateStore.seed(makeStateRecord());
      ctx.inviteProvisioner.setResult({ userId: PROVISIONED_USER_ID });
      // Seed the provisioned user by id so findCredentialsById returns an active record.
      ctx.userRepo.seedId(PROVISIONED_USER_ID, makeProvisionedUserRecord());
    });

    it('returns session tokens for the provisioned user', async () => {
      const result = await ctx.sut.handleCallback({
        code: 'code',
        state: 'valid-state-token',
        inviteTokenHash: INVITE_TOKEN_HASH,
      });

      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.refreshToken).toBeTruthy();
      expect(result.tokens.tokenType).toBe('Bearer');
      expect(result.tokens.userId).toBe(PROVISIONED_USER_ID);
      expect(result.tokens.tenantId).toBe(TENANT_ID);
    });

    it('audits first_link on successful provisioning (OIDC-level outcome)', async () => {
      await ctx.sut.handleCallback({
        code: 'code',
        state: 'valid-state-token',
        inviteTokenHash: INVITE_TOKEN_HASH,
      });

      // The OIDC authenticator emits first_link (isFirstLink=true path).
      // invite_provisioned is emitted by the provisioner itself (T9).
      expect(ctx.auditLogger.lastOutcome()).toBe('first_link');
    });

    it('does NOT call oauthIdentities.linkFirst (provisioner already linked — R-INV-8)', async () => {
      await ctx.sut.handleCallback({
        code: 'code',
        state: 'valid-state-token',
        inviteTokenHash: INVITE_TOKEN_HASH,
      });

      expect(ctx.identityRepo.linkFirstCallCount).toBe(0);
    });

    it('creates a refresh token row', async () => {
      await ctx.sut.handleCallback({
        code: 'code',
        state: 'valid-state-token',
        inviteTokenHash: INVITE_TOKEN_HASH,
      });

      expect(ctx.refreshTokenRepo.createCallCount).toBe(1);
    });

    it('returns the returnTo from the state record', async () => {
      const result = await ctx.sut.handleCallback({
        code: 'code',
        state: 'valid-state-token',
        inviteTokenHash: INVITE_TOKEN_HASH,
      });

      expect(result.returnTo).toBe('/dashboard');
    });
  });

  // ── AC: existing user bypasses the provisioner entirely (R-INV-8) ─────────

  describe('existing user path (email already provisioned) — bypasses provisioner', () => {
    it('does NOT call the provisioner when findCredentialsByEmail returns a record', async () => {
      const ctx = makeDepsWithInvite();
      ctx.stateStore.seed(makeStateRecord());
      // Seed the user by email — simulates an already-provisioned account.
      ctx.userRepo.seedEmail('invited@example.com', makeUserRecord());
      // No identity in repo → will attempt linkFirst (normal first-login path).

      await ctx.sut
        .handleCallback({
          code: 'code',
          state: 'valid-state-token',
          inviteTokenHash: INVITE_TOKEN_HASH,
        })
        .catch(() => {});

      expect(ctx.inviteProvisioner.callCount).toBe(0);
    });

    it('does NOT call the provisioner when there is an existing identity (returning user)', async () => {
      const ctx = makeDepsWithInvite();
      ctx.stateStore.seed(makeStateRecord());
      // Identity already linked → returning user path.
      ctx.identityRepo.seed('google', GOOGLE_SUB, { id: randomUUID(), userId: USER_ID });
      ctx.userRepo.seedId(USER_ID, makeUserRecord());

      await ctx.sut.handleCallback({
        code: 'code',
        state: 'valid-state-token',
        inviteTokenHash: INVITE_TOKEN_HASH,
      });

      expect(ctx.inviteProvisioner.callCount).toBe(0);
    });
  });
});
