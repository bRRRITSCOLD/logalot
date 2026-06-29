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
  NewRefreshToken,
  OAuthAuditEvent,
  OAuthAuditLogger,
  OAuthAuditOutcome,
  OAuthIdentityRef,
  OAuthIdentityRepository,
  OAuthStateRecord,
  OAuthStateStore,
  RefreshTokenRepository,
  SecretGenerator,
  TokenService,
  UserRepository,
} from '../../src/app/ports';
import type { OAuthProvider } from '../../src/domain/entities';
import type { Role } from '../../src/domain/roles';

// ── Fakes ────────────────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const GOOGLE_SUB = 'google-sub-001';
const EXPECTED_HASHED_SUB = createHash('sha256').update(GOOGLE_SUB, 'utf8').digest('hex');

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
  private result: GoogleTokenExchangeResult | Error = {
    idToken: 'fake.id.token',
    accessToken: 'goog-access',
    tokenType: 'Bearer',
    expiresIn: 3600,
  };

  setResult(r: GoogleTokenExchangeResult | Error): void {
    this.result = r;
  }

  async exchange(): Promise<GoogleTokenExchangeResult> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

class FakeIdTokenVerifier implements GoogleIdTokenVerifier {
  private claims: GoogleIdTokenClaims | Error = {
    sub: GOOGLE_SUB,
    email: 'alice@example.com',
    email_verified: true,
    nonce: 'valid-nonce',
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  setClaims(c: GoogleIdTokenClaims | Error): void {
    this.claims = c;
  }

  async verify(): Promise<GoogleIdTokenClaims> {
    if (this.claims instanceof Error) throw this.claims;
    return this.claims;
  }
}

class FakeOAuthIdentityRepo implements OAuthIdentityRepository {
  private identities = new Map<string, { id: string; userId: string }>();

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

  async touchLastLogin(): Promise<void> {}

  async linkFirst(_tenantId: string, input: { userId: string }): Promise<OAuthIdentityRef> {
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
  async create(_tenantId: string, _input: NewRefreshToken): Promise<{ id: string }> {
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
    return { token: `fake.access.${claims.principalId}`, expiresInSeconds: 900 };
  }
  async verifyAccess(): Promise<never> {
    throw new Error('stub');
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2025-01-01T12:00:00Z');

function makeStateRecord(overrides?: Partial<OAuthStateRecord>): OAuthStateRecord {
  return {
    state: 'valid-state-token',
    tenantId: TENANT_ID,
    meta: {
      provider: 'google',
      codeVerifier: 'valid-verifier',
      nonce: 'valid-nonce',
      returnTo: '/',
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

interface Fakes {
  sut: OidcAuthenticator;
  stateStore: FakeOAuthStateStore;
  exchangeClient: FakeTokenExchangeClient;
  idTokenVerifier: FakeIdTokenVerifier;
  identityRepo: FakeOAuthIdentityRepo;
  userRepo: FakeUserRepo;
  auditLogger: OAuthAuditLogger & { events: OAuthAuditEvent[] };
}

function makeFakes(overrides?: Partial<OidcAuthenticatorDeps>): Fakes {
  const stateStore = new FakeOAuthStateStore();
  const exchangeClient = new FakeTokenExchangeClient();
  const idTokenVerifier = new FakeIdTokenVerifier();
  const identityRepo = new FakeOAuthIdentityRepo();
  const userRepo = new FakeUserRepo();

  const events: OAuthAuditEvent[] = [];
  const auditLogger: OAuthAuditLogger & { events: OAuthAuditEvent[] } = {
    events,
    log(event: OAuthAuditEvent): void {
      events.push(event);
    },
  };

  const clock: Clock = { now: () => FIXED_NOW };
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
    redirectUri: 'https://app.logalot.dev/auth/oidc/google/callback',
    authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    stateTtlSeconds: 600,
    tokenExchangeClient: exchangeClient,
    idTokenVerifier,
    oauthIdentities: identityRepo,
    users: userRepo as unknown as OidcAuthenticatorDeps['users'],
    refreshTokens: new FakeRefreshTokenRepo(),
    tokens: new FakeTokenService(),
    secrets,
    ids,
    clock,
    refreshTtlSeconds: 604800,
    auditLogger,
    ...overrides,
  };

  return {
    sut: new OidcAuthenticator(deps),
    stateStore,
    exchangeClient,
    idTokenVerifier,
    identityRepo,
    userRepo,
    auditLogger,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OidcAuthenticator audit logging', () => {
  let fakes: Fakes;

  beforeEach(() => {
    fakes = makeFakes();
  });

  // ── reject_invalid_state ──────────────────────────────────────────────────

  describe('reject_invalid_state', () => {
    it('emits audit event when state is unknown/missing', async () => {
      await fakes.sut.handleCallback({ code: 'c', state: 'bad-state' }).catch(() => {});
      expect(fakes.auditLogger.events).toHaveLength(1);
      const ev = fakes.auditLogger.events[0];
      if (!ev) throw new Error('expected an audit event to be recorded');
      expect(ev.outcome).toBe<OAuthAuditOutcome>('reject_invalid_state');
      expect(ev.tenantId).toBeNull();
      expect(ev.userId).toBeNull();
      expect(ev.hashedSub).toBeNull();
      expect(ev.provider).toBe('google');
      expect(ev.ts).toEqual(FIXED_NOW);
    });

    it('emits audit event on state replay (already consumed)', async () => {
      fakes.stateStore.seed(makeStateRecord());
      fakes.identityRepo.seed('google', GOOGLE_SUB, { id: randomUUID(), userId: USER_ID });
      fakes.userRepo.seedId(USER_ID, makeUserRecord());
      // First call consumes state → succeeds.
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' });
      // Reset events so we can examine only the replay's event.
      fakes.auditLogger.events.length = 0;
      // Second call → state is gone.
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' }).catch(() => {});
      expect(fakes.auditLogger.events[0]?.outcome).toBe<OAuthAuditOutcome>('reject_invalid_state');
    });
  });

  // ── reject_exchange_failure ───────────────────────────────────────────────

  describe('reject_exchange_failure', () => {
    it('emits audit event when Google token exchange fails', async () => {
      fakes.stateStore.seed(makeStateRecord());
      fakes.exchangeClient.setResult(new Error('bad_code'));
      await fakes.sut.handleCallback({ code: 'bad', state: 'valid-state-token' }).catch(() => {});

      expect(fakes.auditLogger.events).toHaveLength(1);
      const ev = fakes.auditLogger.events[0];
      if (!ev) throw new Error('expected an audit event to be recorded');
      expect(ev.outcome).toBe<OAuthAuditOutcome>('reject_exchange_failure');
      expect(ev.tenantId).toBe(TENANT_ID);
      expect(ev.userId).toBeNull();
      expect(ev.hashedSub).toBeNull();
    });
  });

  // ── reject_invalid_token ──────────────────────────────────────────────────

  describe('reject_invalid_token', () => {
    it('emits audit event when id_token verification fails', async () => {
      fakes.stateStore.seed(makeStateRecord());
      fakes.idTokenVerifier.setClaims(new Error('nonce mismatch'));
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' }).catch(() => {});

      expect(fakes.auditLogger.events).toHaveLength(1);
      const ev = fakes.auditLogger.events[0];
      if (!ev) throw new Error('expected an audit event to be recorded');
      expect(ev.outcome).toBe<OAuthAuditOutcome>('reject_invalid_token');
      expect(ev.tenantId).toBe(TENANT_ID);
      expect(ev.hashedSub).toBeNull(); // sub not yet known at verification stage
    });
  });

  // ── reject_no_provisioned_user ────────────────────────────────────────────

  describe('reject_no_provisioned_user', () => {
    it('emits audit event with hashedSub when no user matches the email', async () => {
      fakes.stateStore.seed(makeStateRecord());
      // No identity seeded, no user seeded → first-link path → no email match.
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' }).catch(() => {});

      expect(fakes.auditLogger.events).toHaveLength(1);
      const ev = fakes.auditLogger.events[0];
      if (!ev) throw new Error('expected an audit event to be recorded');
      expect(ev.outcome).toBe<OAuthAuditOutcome>('reject_no_provisioned_user');
      expect(ev.tenantId).toBe(TENANT_ID);
      expect(ev.userId).toBeNull();
      // Sub IS known at this stage (token was verified), so hashedSub must be set.
      expect(ev.hashedSub).toBe(EXPECTED_HASHED_SUB);
    });
  });

  // ── reject_account_inactive ───────────────────────────────────────────────

  describe('reject_account_inactive', () => {
    it('emits audit event with userId and hashedSub when account is suspended', async () => {
      fakes.stateStore.seed(makeStateRecord());
      fakes.identityRepo.seed('google', GOOGLE_SUB, { id: randomUUID(), userId: USER_ID });
      fakes.userRepo.seedId(USER_ID, makeUserRecord({ status: 'suspended' }));
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' }).catch(() => {});

      expect(fakes.auditLogger.events).toHaveLength(1);
      const ev = fakes.auditLogger.events[0];
      if (!ev) throw new Error('expected an audit event to be recorded');
      expect(ev.outcome).toBe<OAuthAuditOutcome>('reject_account_inactive');
      expect(ev.tenantId).toBe(TENANT_ID);
      expect(ev.userId).toBe(USER_ID);
      expect(ev.hashedSub).toBe(EXPECTED_HASHED_SUB);
    });
  });

  // ── login (returning user) ────────────────────────────────────────────────

  describe('login (returning user)', () => {
    it('emits "login" audit event on success', async () => {
      fakes.stateStore.seed(makeStateRecord());
      fakes.identityRepo.seed('google', GOOGLE_SUB, { id: randomUUID(), userId: USER_ID });
      fakes.userRepo.seedId(USER_ID, makeUserRecord());
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' });

      expect(fakes.auditLogger.events).toHaveLength(1);
      const ev = fakes.auditLogger.events[0];
      if (!ev) throw new Error('expected an audit event to be recorded');
      expect(ev.outcome).toBe<OAuthAuditOutcome>('login');
      expect(ev.tenantId).toBe(TENANT_ID);
      expect(ev.userId).toBe(USER_ID);
      expect(ev.hashedSub).toBe(EXPECTED_HASHED_SUB);
      expect(ev.provider).toBe('google');
      expect(ev.ts).toEqual(FIXED_NOW);
    });
  });

  // ── first_link (new identity) ─────────────────────────────────────────────

  describe('first_link (first login for this Google account)', () => {
    it('emits "first_link" audit event on success', async () => {
      fakes.stateStore.seed(makeStateRecord());
      // No existing identity — first-link path.
      fakes.userRepo.seedEmail('alice@example.com', makeUserRecord());
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' });

      expect(fakes.auditLogger.events).toHaveLength(1);
      const ev = fakes.auditLogger.events[0];
      if (!ev) throw new Error('expected an audit event to be recorded');
      expect(ev.outcome).toBe<OAuthAuditOutcome>('first_link');
      expect(ev.tenantId).toBe(TENANT_ID);
      expect(ev.userId).toBe(USER_ID);
      expect(ev.hashedSub).toBe(EXPECTED_HASHED_SUB);
    });
  });

  // ── exactly one event per callback ───────────────────────────────────────

  describe('exactly one event per handleCallback invocation', () => {
    it('emits exactly one event on a successful login', async () => {
      fakes.stateStore.seed(makeStateRecord());
      fakes.identityRepo.seed('google', GOOGLE_SUB, { id: randomUUID(), userId: USER_ID });
      fakes.userRepo.seedId(USER_ID, makeUserRecord());
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' });
      expect(fakes.auditLogger.events).toHaveLength(1);
    });

    it('emits exactly one event on a rejection', async () => {
      await fakes.sut.handleCallback({ code: 'c', state: 'bad-state' }).catch(() => {});
      expect(fakes.auditLogger.events).toHaveLength(1);
    });
  });

  // ── hashedSub is SHA-256 hex of the raw sub ───────────────────────────────

  describe('hashedSub correctness', () => {
    it('hashedSub equals SHA-256(sub) in hex on a successful login', async () => {
      fakes.stateStore.seed(makeStateRecord());
      fakes.identityRepo.seed('google', GOOGLE_SUB, { id: randomUUID(), userId: USER_ID });
      fakes.userRepo.seedId(USER_ID, makeUserRecord());
      await fakes.sut.handleCallback({ code: 'c', state: 'valid-state-token' });

      const ev = fakes.auditLogger.events[0];
      if (!ev) throw new Error('expected an audit event to be recorded');
      expect(ev.hashedSub).toBe(EXPECTED_HASHED_SUB);
      // Sanity: confirm it's a 64-char hex string (256-bit).
      expect(ev.hashedSub).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── audit logger failures are swallowed ───────────────────────────────────

  describe('audit logger resilience', () => {
    it('does not propagate exceptions thrown by the audit logger', async () => {
      const throwingLogger: OAuthAuditLogger = {
        log: () => {
          throw new Error('audit sink crashed');
        },
      };
      const { sut, stateStore, identityRepo, userRepo } = makeFakes({
        auditLogger: throwingLogger,
      });
      stateStore.seed(makeStateRecord());
      identityRepo.seed('google', GOOGLE_SUB, { id: randomUUID(), userId: USER_ID });
      userRepo.seedId(USER_ID, makeUserRecord());
      // Must NOT throw even though the logger throws.
      await expect(
        sut.handleCallback({ code: 'c', state: 'valid-state-token' }),
      ).resolves.toBeDefined();
    });
  });

  // ── no auditLogger (default no-op) ────────────────────────────────────────

  describe('no auditLogger provided (backwards-compat)', () => {
    it('works without an auditLogger (no-op default)', async () => {
      const { sut, stateStore, identityRepo, userRepo } = makeFakes({ auditLogger: undefined });
      stateStore.seed(makeStateRecord());
      identityRepo.seed('google', GOOGLE_SUB, { id: randomUUID(), userId: USER_ID });
      userRepo.seedId(USER_ID, makeUserRecord());
      await expect(
        sut.handleCallback({ code: 'c', state: 'valid-state-token' }),
      ).resolves.toBeDefined();
    });
  });
});
