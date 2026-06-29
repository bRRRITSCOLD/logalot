import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OidcAuthenticator,
  type OidcAuthenticatorDeps,
} from '../../src/app/oidc-authenticator';
import type {
  AuthRecord,
  Clock,
  GoogleIdTokenClaims,
  GoogleIdTokenVerifier,
  GoogleTokenExchangeClient,
  GoogleTokenExchangeResult,
  IdGenerator,
  NewRefreshToken,
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
import { UnauthorizedError } from '../../src/domain/errors';
import type { Role } from '../../src/domain/roles';

// ── Fakes ────────────────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';

// A minimal in-memory OAuthStateStore (single-use: consume deletes the entry).
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

  /** Seed a state record directly. */
  seed(record: OAuthStateRecord): void {
    this.entries.set(record.state, record);
  }
}

// A controlled fake for GoogleTokenExchangeClient.
class FakeTokenExchangeClient implements GoogleTokenExchangeClient {
  callCount = 0;
  private result: GoogleTokenExchangeResult | Error = {
    idToken: 'fake.id.token',
    accessToken: 'goog-access',
    tokenType: 'Bearer',
    expiresIn: 3600,
  };

  setResult(r: GoogleTokenExchangeResult | Error): void {
    this.result = r;
  }

  async exchange(_params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<GoogleTokenExchangeResult> {
    this.callCount++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

// A controlled fake for GoogleIdTokenVerifier.
class FakeIdTokenVerifier implements GoogleIdTokenVerifier {
  callCount = 0;
  private claims: GoogleIdTokenClaims | Error = {
    sub: 'google-sub-001',
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

  async verify(_idToken: string, _nonce: string): Promise<GoogleIdTokenClaims> {
    this.callCount++;
    if (this.claims instanceof Error) throw this.claims;
    return this.claims;
  }
}

// A minimal fake OAuthIdentityRepository.
class FakeOAuthIdentityRepo implements OAuthIdentityRepository {
  private identities = new Map<string, { id: string; userId: string }>(); // key: `${provider}:${sub}`

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

  touchLastLoginCallCount = 0;
  async touchLastLogin(_tenantId: string, _id: string, _now: Date): Promise<void> {
    this.touchLastLoginCallCount++;
  }

  linkFirstCallCount = 0;
  async linkFirst(_tenantId: string, input: { userId: string }): Promise<OAuthIdentityRef> {
    this.linkFirstCallCount++;
    const id = randomUUID();
    return { id, userId: input.userId };
  }

  async findById(): Promise<null> {
    return null;
  }
}

// A minimal fake UserRepository.
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

  // Unused stubs
  async create(): Promise<never> { throw new Error('stub'); }
  async list(): Promise<never[]> { return []; }
  async findById(): Promise<null> { return null; }
  async update(): Promise<null> { return null; }
  async delete(): Promise<boolean> { return false; }
}

// A minimal fake RefreshTokenRepository.
class FakeRefreshTokenRepo implements RefreshTokenRepository {
  createCallCount = 0;
  async create(_tenantId: string, _input: NewRefreshToken): Promise<{ id: string }> {
    this.createCallCount++;
    return { id: randomUUID() };
  }

  async findById(): Promise<null> { return null; }
  async rotate(): Promise<null> { return null; }
  async revokeFamily(): Promise<void> {}
}

// A minimal fake TokenService.
class FakeTokenService implements TokenService {
  async issueAccess(claims: { tenantId: string; principalId: string; role: Role }) {
    return {
      token: `fake.access.${claims.principalId}`,
      expiresInSeconds: 900,
    };
  }

  async verifyAccess(): Promise<never> { throw new Error('stub'); }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REDIRECT_URI = 'https://app.logalot.dev/auth/oidc/google/callback';

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

function makeDeps(
  overrides?: Partial<OidcAuthenticatorDeps>,
): {
  sut: OidcAuthenticator;
  stateStore: FakeOAuthStateStore;
  exchangeClient: FakeTokenExchangeClient;
  idTokenVerifier: FakeIdTokenVerifier;
  identityRepo: FakeOAuthIdentityRepo;
  userRepo: FakeUserRepo;
  refreshTokenRepo: FakeRefreshTokenRepo;
  tokenService: FakeTokenService;
} {
  const stateStore = new FakeOAuthStateStore();
  const exchangeClient = new FakeTokenExchangeClient();
  const idTokenVerifier = new FakeIdTokenVerifier();
  const identityRepo = new FakeOAuthIdentityRepo();
  const userRepo = new FakeUserRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const tokenService = new FakeTokenService();

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
    ...overrides,
  };

  return {
    sut: new OidcAuthenticator(deps),
    stateStore,
    exchangeClient,
    idTokenVerifier,
    identityRepo,
    userRepo,
    refreshTokenRepo,
    tokenService,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OidcAuthenticator.handleCallback', () => {
  let stateStore: FakeOAuthStateStore;
  let exchangeClient: FakeTokenExchangeClient;
  let idTokenVerifier: FakeIdTokenVerifier;
  let identityRepo: FakeOAuthIdentityRepo;
  let userRepo: FakeUserRepo;
  let refreshTokenRepo: FakeRefreshTokenRepo;
  let sut: OidcAuthenticator;

  beforeEach(() => {
    const fakes = makeDeps();
    sut = fakes.sut;
    stateStore = fakes.stateStore;
    exchangeClient = fakes.exchangeClient;
    idTokenVerifier = fakes.idTokenVerifier;
    identityRepo = fakes.identityRepo;
    userRepo = fakes.userRepo;
    refreshTokenRepo = fakes.refreshTokenRepo;
  });

  // ── AC-1: unknown / expired / missing state → 401, ZERO Google calls ──────

  describe('state validation (pre-exchange guard)', () => {
    it('throws UnauthorizedError when state is missing (not in store)', async () => {
      await expect(
        sut.handleCallback({ code: 'some-code', state: 'missing-state' }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('makes ZERO exchange calls when state is missing', async () => {
      await sut.handleCallback({ code: 'code', state: 'missing' }).catch(() => {});
      expect(exchangeClient.callCount).toBe(0);
    });

    it('makes ZERO verifier calls when state is missing', async () => {
      await sut.handleCallback({ code: 'code', state: 'missing' }).catch(() => {});
      expect(idTokenVerifier.callCount).toBe(0);
    });

    it('throws UnauthorizedError on replay (state already consumed)', async () => {
      // Seed and consume once successfully (or manually consume first).
      stateStore.seed(makeStateRecord());
      identityRepo.seed('google', 'google-sub-001', { id: randomUUID(), userId: USER_ID });
      userRepo.seedId(USER_ID, makeUserRecord());
      // First call should succeed (consuming the state).
      await sut.handleCallback({ code: 'code', state: 'valid-state-token' }).catch(() => {});

      // Second call with the same state → state is gone.
      await expect(
        sut.handleCallback({ code: 'code', state: 'valid-state-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('makes ZERO exchange calls on replay', async () => {
      // Force replay: state is consumed on first attempt, then absent on second.
      stateStore.seed(makeStateRecord());
      identityRepo.seed('google', 'google-sub-001', { id: randomUUID(), userId: USER_ID });
      userRepo.seedId(USER_ID, makeUserRecord());
      await sut.handleCallback({ code: 'code', state: 'valid-state-token' }).catch(() => {});

      const callsBefore = exchangeClient.callCount;
      await sut.handleCallback({ code: 'code', state: 'valid-state-token' }).catch(() => {});
      expect(exchangeClient.callCount).toBe(callsBefore); // no additional calls
    });
  });

  // ── AC-2: exchange failure → 401 ──────────────────────────────────────────

  describe('code exchange failure', () => {
    beforeEach(() => {
      stateStore.seed(makeStateRecord());
      exchangeClient.setResult(new Error('bad_code'));
    });

    it('throws UnauthorizedError when exchange fails', async () => {
      await expect(
        sut.handleCallback({ code: 'bad-code', state: 'valid-state-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('does NOT call the id_token verifier when exchange fails', async () => {
      await sut.handleCallback({ code: 'bad-code', state: 'valid-state-token' }).catch(() => {});
      expect(idTokenVerifier.callCount).toBe(0);
    });
  });

  // ── AC-3: nonce mismatch → 401 ────────────────────────────────────────────

  describe('nonce mismatch', () => {
    beforeEach(() => {
      stateStore.seed(makeStateRecord()); // nonce = 'valid-nonce'
      idTokenVerifier.setClaims(new Error('nonce mismatch'));
    });

    it('throws UnauthorizedError when id_token verification fails (nonce mismatch)', async () => {
      await expect(
        sut.handleCallback({ code: 'code', state: 'valid-state-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  // ── AC-4: no provisioned user (invite-only) → 401 ─────────────────────────

  describe('invite-only guard', () => {
    beforeEach(() => {
      stateStore.seed(makeStateRecord());
      // No identity linked, no user seeded → invite-only rejection.
    });

    it('throws UnauthorizedError when no provisioned user matches the email', async () => {
      await expect(
        sut.handleCallback({ code: 'code', state: 'valid-state-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  // ── AC-5: inactive / deactivated user → 401 ──────────────────────────────

  describe('deactivated user', () => {
    beforeEach(() => {
      stateStore.seed(makeStateRecord());
      identityRepo.seed('google', 'google-sub-001', { id: randomUUID(), userId: USER_ID });
      userRepo.seedId(USER_ID, makeUserRecord({ status: 'suspended', role: 'member' }));
    });

    it('throws UnauthorizedError when the account is suspended', async () => {
      await expect(
        sut.handleCallback({ code: 'code', state: 'valid-state-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  // ── Happy path: returning user (identity already linked) ──────────────────

  describe('returning user (identity found by providerSub)', () => {
    const IDENTITY_ID = '00000000-0000-0000-0000-000000000099';

    beforeEach(() => {
      stateStore.seed(makeStateRecord());
      identityRepo.seed('google', 'google-sub-001', { id: IDENTITY_ID, userId: USER_ID });
      userRepo.seedId(USER_ID, makeUserRecord());
    });

    it('returns session tokens on success', async () => {
      const result = await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.refreshToken).toBeTruthy();
      expect(result.tokens.tokenType).toBe('Bearer');
      expect(result.tokens.role).toBe('member');
      expect(result.tokens.tenantId).toBe(TENANT_ID);
      expect(result.tokens.userId).toBe(USER_ID);
    });

    it('returns the returnTo from the state record', async () => {
      const result = await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      expect(result.returnTo).toBe('/dashboard');
    });

    it('touches last_login_at for the returning user', async () => {
      await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      // touchLastLogin is fire-and-forget; give the microtask a chance to run.
      await Promise.resolve();
      expect(identityRepo.touchLastLoginCallCount).toBeGreaterThan(0);
    });

    it('does NOT call linkFirst for a returning user', async () => {
      await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      expect(identityRepo.linkFirstCallCount).toBe(0);
    });

    it('creates a refresh token row', async () => {
      await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      expect(refreshTokenRepo.createCallCount).toBe(1);
    });
  });

  // ── Happy path: first login (identity not yet linked) ─────────────────────

  describe('first login (no existing identity → linkFirst)', () => {
    beforeEach(() => {
      stateStore.seed(makeStateRecord());
      // No identity in repo → triggers first-link path.
      // Seed user by email so the invite-only check passes.
      userRepo.seedEmail('alice@example.com', makeUserRecord());
    });

    it('returns session tokens on first login', async () => {
      const result = await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.userId).toBe(USER_ID);
    });

    it('calls linkFirst to create the identity link', async () => {
      await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      expect(identityRepo.linkFirstCallCount).toBe(1);
    });

    it('does NOT call touchLastLogin on first login', async () => {
      await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      await Promise.resolve();
      expect(identityRepo.touchLastLoginCallCount).toBe(0);
    });

    it('returns returnTo "/" when state record has no returnTo', async () => {
      stateStore.seed(
        makeStateRecord({
          state: 'no-return-to-state',
          meta: { provider: 'google', codeVerifier: 'v', nonce: 'valid-nonce' },
        }),
      );
      const result = await sut.handleCallback({ code: 'code', state: 'no-return-to-state' });
      expect(result.returnTo).toBe('/');
    });
  });

  // ── Single-use state guarantee ─────────────────────────────────────────────

  describe('single-use state guarantee', () => {
    it('a valid state can only be consumed once (idempotent rejection on replay)', async () => {
      stateStore.seed(makeStateRecord());
      identityRepo.seed('google', 'google-sub-001', { id: randomUUID(), userId: USER_ID });
      userRepo.seedId(USER_ID, makeUserRecord());

      const first = await sut.handleCallback({ code: 'code', state: 'valid-state-token' });
      expect(first.tokens.accessToken).toBeTruthy();

      await expect(
        sut.handleCallback({ code: 'code', state: 'valid-state-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });
});
