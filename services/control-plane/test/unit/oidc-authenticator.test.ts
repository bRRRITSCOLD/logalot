import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OidcAuthenticator, type OidcAuthenticatorDeps } from '../../src/app/oidc-authenticator';
import type { OAuthStateRecord, OAuthStateStore } from '../../src/app/ports';
import type { Tenant } from '../../src/domain/entities';
import { NotFoundError } from '../../src/domain/errors';

// ── Minimal in-memory fakes ──────────────────────────────────────────────────

const TENANT: Tenant = {
  id: '00000000-0000-0000-0000-000000000001',
  publicId: 'acme',
  name: 'Acme Corp',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

class FakeTenantRepo {
  constructor(private readonly tenants: Tenant[]) {}
  async findByPublicId(slug: string): Promise<Tenant | null> {
    return this.tenants.find((t) => t.publicId === slug) ?? null;
  }
  async findById(id: string): Promise<Tenant | null> {
    return this.tenants.find((t) => t.id === id) ?? null;
  }
}

class FakeOAuthStateStore implements OAuthStateStore {
  private readonly entries = new Map<string, { record: OAuthStateRecord; ttl: number }>();

  async put(record: OAuthStateRecord, ttlSeconds: number): Promise<void> {
    this.entries.set(record.state, { record, ttl: ttlSeconds });
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const entry = this.entries.get(state);
    if (!entry) return null;
    this.entries.delete(state);
    return entry.record;
  }

  /** Test helper: inspect without consuming. */
  _peek(state: string): { record: OAuthStateRecord; ttl: number } | undefined {
    return this.entries.get(state);
  }

  /** Test helper: count entries. */
  _size(): number {
    return this.entries.size;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CLIENT_ID = 'google-client-id.apps.googleusercontent.com';
const REDIRECT_URI = 'https://app.logalot.dev/auth/oidc/google/callback';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

// Stub fakes for the callback-half deps that the beginAuthorize tests don't exercise.
const NEVER_CALLED_EXCHANGE: OidcAuthenticatorDeps['tokenExchangeClient'] = {
  exchange: () => Promise.reject(new Error('not expected in these tests')),
};
const NEVER_CALLED_VERIFIER: OidcAuthenticatorDeps['idTokenVerifier'] = {
  verify: () => Promise.reject(new Error('not expected in these tests')),
};
const NEVER_CALLED_IDENTITIES: OidcAuthenticatorDeps['oauthIdentities'] = {
  findByProviderSub: () => Promise.resolve(null),
  linkFirst: () => Promise.reject(new Error('not expected in these tests')),
  touchLastLogin: () => Promise.resolve(),
  findById: () => Promise.resolve(null),
};
const NEVER_CALLED_USERS: OidcAuthenticatorDeps['users'] = {
  create: () => Promise.reject(new Error('not expected in these tests')),
  list: () => Promise.resolve([]),
  findById: () => Promise.resolve(null),
  update: () => Promise.resolve(null),
  delete: () => Promise.resolve(false),
  findCredentialsByEmail: () => Promise.resolve(null),
  findCredentialsById: () => Promise.resolve(null),
};
const NEVER_CALLED_REFRESH_TOKENS: OidcAuthenticatorDeps['refreshTokens'] = {
  create: () => Promise.reject(new Error('not expected in these tests')),
  findById: () => Promise.resolve(null),
  rotate: () => Promise.resolve(null),
  revokeFamily: () => Promise.resolve(),
};
const NEVER_CALLED_TOKENS: OidcAuthenticatorDeps['tokens'] = {
  issueAccess: () => Promise.reject(new Error('not expected in these tests')),
  verifyAccess: () => Promise.reject(new Error('not expected in these tests')),
};
const NEVER_CALLED_SECRETS: OidcAuthenticatorDeps['secrets'] = {
  generate: () => {
    throw new Error('not expected in these tests');
  },
};
const NEVER_CALLED_IDS: OidcAuthenticatorDeps['ids'] = {
  uuid: () => {
    throw new Error('not expected in these tests');
  },
};
const NEVER_CALLED_CLOCK: OidcAuthenticatorDeps['clock'] = {
  now: () => {
    throw new Error('not expected in these tests');
  },
};

function makeDeps(overrides?: Partial<OidcAuthenticatorDeps>): OidcAuthenticatorDeps {
  return {
    tenants: new FakeTenantRepo([TENANT]) as unknown as OidcAuthenticatorDeps['tenants'],
    stateStore: new FakeOAuthStateStore(),
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    authEndpoint: AUTH_ENDPOINT,
    stateTtlSeconds: 600,
    tokenExchangeClient: NEVER_CALLED_EXCHANGE,
    idTokenVerifier: NEVER_CALLED_VERIFIER,
    oauthIdentities: NEVER_CALLED_IDENTITIES,
    users: NEVER_CALLED_USERS,
    refreshTokens: NEVER_CALLED_REFRESH_TOKENS,
    tokens: NEVER_CALLED_TOKENS,
    secrets: NEVER_CALLED_SECRETS,
    ids: NEVER_CALLED_IDS,
    clock: NEVER_CALLED_CLOCK,
    refreshTtlSeconds: 604800,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OidcAuthenticator.beginAuthorize', () => {
  let stateStore: FakeOAuthStateStore;
  let sut: OidcAuthenticator;

  beforeEach(() => {
    stateStore = new FakeOAuthStateStore();
    sut = new OidcAuthenticator(makeDeps({ stateStore }));
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  describe('redirect URL params', () => {
    it('returns an absolute URL pointing at the configured auth endpoint', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      expect(redirectUrl.startsWith(`${AUTH_ENDPOINT}?`)).toBe(true);
    });

    it('includes code_challenge and code_challenge_method=S256', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const params = new URL(redirectUrl).searchParams;

      const challenge = params.get('code_challenge');
      expect(challenge).toBeTruthy();
      expect(params.get('code_challenge_method')).toBe('S256');

      // The stored verifier must hash to the advertised challenge (S256).
      const stateValue = params.get('state') ?? '';
      const stored = stateStore._peek(stateValue);
      expect(stored).toBeDefined();
      const verifier = stored?.record.meta.codeVerifier ?? '';
      expect(verifier).toBeTruthy();
      const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
      expect(challenge).toBe(expected);
    });

    it('includes a non-empty state parameter', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const state = new URL(redirectUrl).searchParams.get('state');
      expect(state).toBeTruthy();
    });

    it('includes a non-empty nonce parameter', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const nonce = new URL(redirectUrl).searchParams.get('nonce');
      expect(nonce).toBeTruthy();
    });

    it('uses the FIXED redirect_uri from config — never from the request', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const uri = new URL(redirectUrl).searchParams.get('redirect_uri');
      expect(uri).toBe(REDIRECT_URI);
    });

    it('includes scope=openid email', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const scope = new URL(redirectUrl).searchParams.get('scope');
      expect(scope).toBe('openid email');
    });

    it('includes response_type=code', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const responseType = new URL(redirectUrl).searchParams.get('response_type');
      expect(responseType).toBe('code');
    });
  });

  // ── State ≥128-bit entropy ────────────────────────────────────────────────

  describe('state entropy', () => {
    it('state is ≥128 bits (≥16 bytes) when decoded from base64url', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const stateParam = new URL(redirectUrl).searchParams.get('state') ?? '';
      // base64url: every 4 chars encodes 3 bytes; 22 chars → 16.5 bytes → 128 bits.
      // We generate 32 bytes (256 bit), so decoded length = 32.
      const decoded = Buffer.from(stateParam, 'base64url');
      expect(decoded.length).toBeGreaterThanOrEqual(16); // ≥128 bits
    });

    it('generates a different state on each invocation (CSPRNG)', async () => {
      const r1 = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const r2 = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const s1 = new URL(r1.redirectUrl).searchParams.get('state');
      const s2 = new URL(r2.redirectUrl).searchParams.get('state');
      expect(s1).not.toBe(s2);
    });
  });

  // ── OAuthStateStore persistence ──────────────────────────────────────────

  describe('state store', () => {
    it('persists the state record before returning', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const state = new URL(redirectUrl).searchParams.get('state') ?? '';
      expect(stateStore._peek(state)).toBeDefined();
    });

    it('stored record carries tenantId, provider, codeVerifier, nonce, returnTo', async () => {
      const { redirectUrl } = await sut.beginAuthorize({
        tenantSlug: 'acme',
        returnTo: '/dashboard',
      });
      const state = new URL(redirectUrl).searchParams.get('state') ?? '';
      const entry = stateStore._peek(state);
      expect(entry).toBeDefined();
      const record = entry?.record;
      expect(record.tenantId).toBe(TENANT.id);
      expect(record.meta.provider).toBe('google');
      expect(record.meta.codeVerifier).toBeTruthy();
      expect(record.meta.nonce).toBeTruthy();
      expect(record.meta.returnTo).toBe('/dashboard');
    });

    it('record is retrievable exactly once (single-use)', async () => {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme' });
      const state = new URL(redirectUrl).searchParams.get('state') ?? '';

      const first = await stateStore.consume(state);
      const second = await stateStore.consume(state);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('uses the configured stateTtlSeconds', async () => {
      const customSut = new OidcAuthenticator(makeDeps({ stateStore, stateTtlSeconds: 300 }));
      const { redirectUrl } = await customSut.beginAuthorize({ tenantSlug: 'acme' });
      const state = new URL(redirectUrl).searchParams.get('state') ?? '';
      const entry = stateStore._peek(state);
      expect(entry?.ttl).toBe(300);
    });
  });

  // ── returnTo allowlist ───────────────────────────────────────────────────

  describe('returnTo allowlist', () => {
    async function getStoredReturnTo(returnTo?: string): Promise<string> {
      const { redirectUrl } = await sut.beginAuthorize({ tenantSlug: 'acme', returnTo });
      const state = new URL(redirectUrl).searchParams.get('state') ?? '';
      return stateStore._peek(state)?.record.meta.returnTo ?? '';
    }

    it('stores a valid relative path as-is', async () => {
      expect(await getStoredReturnTo('/dashboard')).toBe('/dashboard');
    });

    it('stores a valid relative path with query string', async () => {
      expect(await getStoredReturnTo('/tenant/acme/logs?page=2')).toBe('/tenant/acme/logs?page=2');
    });

    it('falls back to "/" when returnTo is undefined', async () => {
      expect(await getStoredReturnTo(undefined)).toBe('/');
    });

    it('falls back to "/" for protocol-relative path (//evil)', async () => {
      expect(await getStoredReturnTo('//evil.example.com')).toBe('/');
    });

    it('falls back to "/" for backslash protocol-relative (/\\\\evil)', async () => {
      // /\evil is an IE open-redirect bypass.
      expect(await getStoredReturnTo('/\\evil')).toBe('/');
    });

    it('falls back to "/" for absolute http URL', async () => {
      expect(await getStoredReturnTo('https://evil.example.com/steal')).toBe('/');
    });

    it('falls back to "/" for absolute URL with leading space (whitespace bypass)', async () => {
      expect(await getStoredReturnTo(' https://evil.example.com')).toBe('/');
    });

    it('falls back to "/" for returnTo containing a TAB control character', async () => {
      // "/\t/evil" collapses to "//evil" in WHATWG URL parsing — reject it.
      expect(await getStoredReturnTo('/\t/evil')).toBe('/');
    });

    it('falls back to "/" for returnTo containing a LF control character', async () => {
      expect(await getStoredReturnTo('/\n/evil')).toBe('/');
    });

    it('falls back to "/" for returnTo containing a CR control character', async () => {
      expect(await getStoredReturnTo('/\r/evil')).toBe('/');
    });

    it('falls back to "/" for an empty string', async () => {
      expect(await getStoredReturnTo('')).toBe('/');
    });
  });

  // ── Tenant validation ────────────────────────────────────────────────────

  describe('tenant validation', () => {
    it('throws NotFoundError for an unknown tenant slug', async () => {
      await expect(sut.beginAuthorize({ tenantSlug: 'unknown' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('throws NotFoundError when the tenant is not active (suspended)', async () => {
      const suspendedTenant: Tenant = { ...TENANT, publicId: 'suspended', status: 'suspended' };
      const localSut = new OidcAuthenticator(
        makeDeps({
          stateStore,
          tenants: new FakeTenantRepo([
            suspendedTenant,
          ]) as unknown as OidcAuthenticatorDeps['tenants'],
        }),
      );
      await expect(localSut.beginAuthorize({ tenantSlug: 'suspended' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
