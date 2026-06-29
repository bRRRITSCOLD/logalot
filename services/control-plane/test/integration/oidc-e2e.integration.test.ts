import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JoseGoogleIdTokenVerifier } from '../../src/adapters/crypto/jose-google-verifier';
import { JoseTokenService } from '../../src/adapters/crypto/jose-token-service';
import { NodeIdGenerator, NodeSecretGenerator } from '../../src/adapters/crypto/node-random';
import { SystemClock } from '../../src/adapters/crypto/system-clock';
import { buildServer } from '../../src/adapters/http/server';
import { PgOAuthIdentityRepository } from '../../src/adapters/postgres/oauth-identity-repository';
import { PgRefreshTokenRepository } from '../../src/adapters/postgres/refresh-token-repository';
import { PgTenantRepository } from '../../src/adapters/postgres/tenant-repository';
import { PgUserRepository } from '../../src/adapters/postgres/user-repository';
import { InMemoryOAuthStateStore } from '../../src/adapters/redis/in-memory-oauth-state-store';
import { OidcAuthenticator } from '../../src/app/oidc-authenticator';
import type { GoogleTokenExchangeClient, GoogleTokenExchangeResult } from '../../src/app/ports';
import { buildContainer } from '../../src/container';
import { armedQuery, type ItEnv, seedPlatformOperator, setupEnv, teardownEnv } from './helpers';

// ── Cross-service OIDC end-to-end (issue #106) ──────────────────────────────
//
// Tests the full authorize → callback → link → mint flow using:
//   - A real Fastify server + real Postgres (testcontainers, migrations applied).
//   - An in-memory OAuth state store (single-process test; Redis not needed).
//   - A fake Google: signs RS256 JWTs with a freshly-generated key pair; the
//     JoseGoogleIdTokenVerifier receives the matching JWKS via createLocalJWKSet
//     (no network calls to Google in CI).
//
// Slice-style: every layer from HTTP routing down through OidcAuthenticator,
// OAuthIdentityRepository, RefreshTokenRepository, and Postgres is exercised.
//
// Coverage:
//   happy-path-first-link  — first login: email matched, identity created.
//   happy-path-subsequent  — returning login: identity resolved by sub.
//   multi-tenant           — same Google sub linked in tenant A AND B independently.
//   cross-tenant-isolation — sub only in A → login via B page → 401.
//   R1  (validation)       — missing/invalid fields → 400.
//   R2  (invite-only)      — email not provisioned in tenant → 401.
//   R4  (state replay)     — state consumed once; second use → 401.
//   R5  (nonce)            — id_token nonce ≠ state nonce → 401.
//   R6  (PKCE)             — exchange failure (bad verifier) → 401.
//   R10 (fresh family)     — reuse a rotated refresh token → 401 + family revoke.
//   R13 (sub-pinned)       — sub A linked in tenant → sub B for same email → 401.
//   R14 (normalization)    — uppercase email in id_token matches provisioned lower.

// ── Fake Google OIDC ─────────────────────────────────────────────────────────

const FAKE_CLIENT_ID = 'fake-google-client-id';
const FAKE_REDIRECT_URI = 'https://app.logalot.dev/auth/oidc/google/callback';
const FAKE_ISSUER = 'https://accounts.google.com';
const FAKE_KEY_ID = 'fake-kid-1';

interface FakeCodeEntry {
  sub: string;
  email: string;
  nonce: string;
  emailVerified: boolean;
}

/**
 * FakeGoogleOidc holds an RSA key pair and issues signed RS256 id_tokens.
 * It acts as both the JWKS source (for JoseGoogleIdTokenVerifier) and the
 * token-exchange stub (returned from FakeGoogleTokenExchangeClient).
 */
class FakeGoogleOidc {
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;
  private readonly codes = new Map<string, FakeCodeEntry>();

  async init(): Promise<void> {
    const kp = await generateKeyPair('RS256', { extractable: true });
    this.privateKey = kp.privateKey;
    this.publicKey = kp.publicKey;
  }

  /**
   * Returns a JWKS getter compatible with JoseGoogleIdTokenVerifier's
   * `jwksGetKey` option, backed by the generated public key.
   */
  async makeJwksGetKey() {
    const jwk = await exportJWK(this.publicKey);
    // createLocalJWKSet expects a JWKS object.
    return createLocalJWKSet({
      keys: [{ ...jwk, kid: FAKE_KEY_ID, use: 'sig', alg: 'RS256' }],
    });
  }

  /** Register a code that the exchange client will accept. */
  registerCode(
    code: string,
    opts: { sub: string; email: string; nonce: string; emailVerified?: boolean },
  ): void {
    this.codes.set(code, {
      sub: opts.sub,
      email: opts.email,
      nonce: opts.nonce,
      emailVerified: opts.emailVerified ?? true,
    });
  }

  /** Mint a signed RS256 id_token for the registered code (single-use). */
  async mintIdToken(code: string): Promise<string> {
    const entry = this.codes.get(code);
    if (!entry) throw new Error(`FakeGoogleOidc: unknown code '${code}'`);
    this.codes.delete(code); // single-use

    return new SignJWT({
      sub: entry.sub,
      email: entry.email,
      email_verified: entry.emailVerified,
      nonce: entry.nonce,
      aud: FAKE_CLIENT_ID,
    })
      .setProtectedHeader({ alg: 'RS256', kid: FAKE_KEY_ID })
      .setIssuer(FAKE_ISSUER)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.privateKey);
  }
}

/**
 * FakeGoogleTokenExchangeClient wraps FakeGoogleOidc to implement the
 * GoogleTokenExchangeClient port. On exchange() it mints a signed id_token
 * for the registered code and returns it in the Google shape.
 * Throws when the code is unknown (simulates exchange failure / bad PKCE verifier).
 */
class FakeGoogleTokenExchangeClient implements GoogleTokenExchangeClient {
  constructor(private readonly fakeGoogle: FakeGoogleOidc) {}

  async exchange(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<GoogleTokenExchangeResult> {
    const idToken = await this.fakeGoogle.mintIdToken(params.code);
    return {
      idToken,
      accessToken: 'fake-access-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
    };
  }
}

// ── OidcEnv ───────────────────────────────────────────────────────────────────

interface OidcEnv extends ItEnv {
  oidcApp: FastifyInstance;
  fakeGoogle: FakeGoogleOidc;
}

async function setupOidcEnv(): Promise<OidcEnv> {
  // 1. Start Postgres testcontainer + apply migrations.
  const base = await setupEnv();
  const { appPool, config } = base;

  // 2. Build a fake Google OIDC provider.
  const fakeGoogle = new FakeGoogleOidc();
  await fakeGoogle.init();

  // 3. Build infrastructure components directly (same pattern as buildContainer,
  //    but we wire fake Google adapters in place of the live ones).
  const tokenService = new JoseTokenService({
    secret: config.jwtSecret,
    accessTtlSeconds: config.accessTokenTtlSeconds,
  });
  const secretGenerator = new NodeSecretGenerator();
  const idGenerator = new NodeIdGenerator();
  const clock = new SystemClock();

  const tenantRepo = new PgTenantRepository(appPool);
  const userRepo = new PgUserRepository(appPool);
  const refreshTokenRepo = new PgRefreshTokenRepository(appPool);
  const oauthIdentityRepo = new PgOAuthIdentityRepository(appPool);

  // 4. Build the real container for the non-OIDC services (auth, tenants, etc.).
  //    We only use its `services` bundle — the oidcAuthenticator is replaced below.
  const container = buildContainer(appPool, config);

  // 5. Build the fake-backed OidcAuthenticator.
  const stateStore = new InMemoryOAuthStateStore();
  const jwksGetKey = await fakeGoogle.makeJwksGetKey();
  const idTokenVerifier = new JoseGoogleIdTokenVerifier({
    clientId: FAKE_CLIENT_ID,
    jwksGetKey,
  });
  const tokenExchangeClient = new FakeGoogleTokenExchangeClient(fakeGoogle);

  const oidcAuthenticator = new OidcAuthenticator({
    tenants: tenantRepo,
    stateStore,
    clientId: FAKE_CLIENT_ID,
    redirectUri: FAKE_REDIRECT_URI,
    authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    stateTtlSeconds: 600,
    tokenExchangeClient,
    idTokenVerifier,
    oauthIdentities: oauthIdentityRepo,
    users: userRepo,
    refreshTokens: refreshTokenRepo,
    tokens: tokenService,
    secrets: secretGenerator,
    ids: idGenerator,
    clock,
    refreshTtlSeconds: config.refreshTokenTtlSeconds,
  });

  // 6. Build the Fastify server with the real service bundle + fake oidcAuthenticator.
  const oidcApp = buildServer({
    services: container.services,
    tokenService,
    oidcAuthenticator,
    ping: async () => true,
    logger: false,
    // Disable trustProxy so inject() resolves IPs correctly (no XFF forwarding).
    trustProxy: false,
    // Lift the callback per-IP rate limit: every test hits from the same loopback
    // IP, so the production default (20/60s) would 429 later tests. Rate-limiting
    // has its own dedicated coverage; this suite exercises the auth flow.
    oidcRateLimitMax: 100_000,
  });
  await oidcApp.ready();

  // The production container's Redis / extra resources are not used — just shut
  // it down cleanly so we don't leak connections.
  await container.shutdown();

  return { ...base, oidcApp, fakeGoogle };
}

async function teardownOidcEnv(env: OidcEnv): Promise<void> {
  await env.oidcApp.close();
  await teardownEnv(env);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const OPS_TENANT_ID = '00000000-0000-0000-0000-0000000000f1';

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function opsLogin(app: FastifyInstance) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenantSlug: 'ops', email: 'ops@logalot.dev', password: 'ops-password' },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { accessToken: string }).accessToken;
}

/** Creates a tenant and returns its id. */
async function createTenant(
  app: FastifyInstance,
  opsToken: string,
  publicId: string,
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: authHeader(opsToken),
    payload: { publicId, name },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

/** Provisions the first admin for a tenant. Returns the user record. */
async function provisionAdmin(
  app: FastifyInstance,
  opsToken: string,
  tenantId: string,
  email: string,
  password: string,
): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/tenants/${tenantId}/admin`,
    headers: authHeader(opsToken),
    payload: { email, password },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

/**
 * Drives the authorize endpoint and returns the parsed { state, nonce } from
 * the redirect URL so the test can register a matching code with fakeGoogle.
 */
async function beginAuthorize(
  app: FastifyInstance,
  tenantSlug: string,
  returnTo?: string,
): Promise<{ redirectUrl: string; state: string; nonce: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/oidc/google/authorize',
    payload: { tenantSlug, returnTo },
  });
  expect(res.statusCode).toBe(200);
  const { redirectUrl } = res.json() as { redirectUrl: string };
  const url = new URL(redirectUrl);
  const state = url.searchParams.get('state') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';
  expect(state).not.toBe('');
  expect(nonce).not.toBe('');
  return { redirectUrl, state, nonce };
}

/**
 * Completes the OIDC callback and returns the session tokens.
 * Registers the code with fakeGoogle before calling the endpoint.
 *
 * `tenantSlug` is required by the shared oidcCallbackRequestSchema; the
 * authenticator ignores it (tenantId is embedded in the state), but the zod
 * validation layer will reject the request without it.
 */
async function completeCallback(
  app: FastifyInstance,
  fakeGoogle: FakeGoogleOidc,
  opts: {
    code: string;
    state: string;
    sub: string;
    email: string;
    nonce: string;
    tenantSlug?: string;
  },
): Promise<{
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  userId: string;
  role: string;
  returnTo: string;
}> {
  fakeGoogle.registerCode(opts.code, {
    sub: opts.sub,
    email: opts.email,
    nonce: opts.nonce,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/oidc/google/callback',
    payload: { tenantSlug: opts.tenantSlug ?? 'tenant-a', code: opts.code, state: opts.state },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    accessToken: string;
    refreshToken: string;
    tenantId: string;
    userId: string;
    role: string;
    returnTo: string;
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('OIDC end-to-end (fake Google, testcontainers Postgres)', () => {
  let env: OidcEnv;
  let app: FastifyInstance;
  let fakeGoogle: FakeGoogleOidc;

  let opsToken: string;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    env = await setupOidcEnv();
    app = env.oidcApp;
    fakeGoogle = env.fakeGoogle;

    // Bootstrap a platform operator.
    await seedPlatformOperator(env, {
      tenantId: OPS_TENANT_ID,
      slug: 'ops',
      email: 'ops@logalot.dev',
      password: 'ops-password',
    });
    opsToken = await opsLogin(app);

    // Provision two tenants.
    tenantAId = await createTenant(app, opsToken, 'tenant-a', 'Tenant A');
    tenantBId = await createTenant(app, opsToken, 'tenant-b', 'Tenant B');

    // Provision a user in each tenant. Passwords are irrelevant — they won't
    // log in via password; OIDC links by email.
    await provisionAdmin(app, opsToken, tenantAId, 'alice@example.com', 'pass-a-1234');
    await provisionAdmin(app, opsToken, tenantBId, 'alice@b.example.com', 'pass-b-1234');
  });

  afterAll(() => teardownOidcEnv(env));

  // Provision a FRESH user per test that needs a clean first-link. UNIQUE(tenant_id,
  // user_id, provider) pins a user to exactly one Google sub, so a test that links a
  // NEW sub to a SHARED user now (correctly) 401s — every first-link case must own its
  // user. Random emails keep each test independent of suite order.
  async function freshUserA(): Promise<string> {
    const email = `oidc-a-${randomUUID()}@example.com`;
    await provisionAdmin(app, opsToken, tenantAId, email, 'pass-fresh-1234');
    return email;
  }
  async function freshUserB(): Promise<string> {
    const email = `oidc-b-${randomUUID()}@b.example.com`;
    await provisionAdmin(app, opsToken, tenantBId, email, 'pass-fresh-1234');
    return email;
  }

  // ── Happy path: first-link ─────────────────────────────────────────────────

  describe('happy path — first-link (first Google login for this tenant)', () => {
    it('authorize returns a redirectUrl containing state and nonce', async () => {
      const { redirectUrl } = await beginAuthorize(app, 'tenant-a', '/dashboard');
      expect(redirectUrl).toContain('accounts.google.com');
      expect(redirectUrl).toContain('state=');
      expect(redirectUrl).toContain('nonce=');
      expect(redirectUrl).toContain(`client_id=${FAKE_CLIENT_ID}`);
      expect(redirectUrl).toContain('code_challenge_method=S256');
    });

    it('callback mints session tokens and creates the identity link', async () => {
      const { state, nonce } = await beginAuthorize(app, 'tenant-a', '/dashboard');
      const session = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state,
        sub: 'google-sub-alice',
        email: 'alice@example.com',
        nonce,
      });

      expect(session.accessToken).toBeTruthy();
      expect(session.refreshToken).toBeTruthy();
      expect(session.tenantId).toBe(tenantAId);
      expect(session.role).toMatch(/^(member|tenant_admin)$/);
      expect(session.returnTo).toBe('/dashboard');
    });

    it('callback persists the oauth_identity row (verifiable via armedQuery)', async () => {
      const { state, nonce } = await beginAuthorize(app, 'tenant-a');
      const code = randomUUID();
      fakeGoogle.registerCode(code, {
        sub: 'google-sub-alice',
        email: 'alice@example.com',
        nonce,
      });
      await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code, state },
      });

      // The identity row is already linked from a previous test; verify via SQL.
      const rows = await armedQuery<{ provider_sub: string }>(
        env.appPool,
        tenantAId,
        `SELECT provider_sub FROM oauth_identities WHERE provider = 'google' AND provider_sub = 'google-sub-alice'`,
        [],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.provider_sub).toBe('google-sub-alice');
    });
  });

  // ── Happy path: subsequent login (returning user) ─────────────────────────

  describe('happy path — subsequent login (returning user, identity already linked)', () => {
    it('second callback resolves session without calling linkFirst again', async () => {
      const email = await freshUserA();
      const sub = `sub-returning-${randomUUID()}`;

      // First login links the identity.
      const auth1 = await beginAuthorize(app, 'tenant-a');
      await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state: auth1.state,
        sub,
        email,
        nonce: auth1.nonce,
      });

      // Second login with the SAME sub → returning path (findByProviderSub hits,
      // no linkFirst).
      const auth2 = await beginAuthorize(app, 'tenant-a');
      const session2 = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state: auth2.state,
        sub,
        email,
        nonce: auth2.nonce,
      });

      expect(session2.accessToken).toBeTruthy();
      expect(session2.tenantId).toBe(tenantAId);
    });
  });

  // ── Multi-tenant membership (R3 structural / R17) ─────────────────────────

  describe('multi-tenant membership (same Google sub, tenant-scoped sessions)', () => {
    it('links a sub in tenant A and gets a tenant-A session', async () => {
      const emailA = await freshUserA();
      const authA = await beginAuthorize(app, 'tenant-a');
      const sessionA = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state: authA.state,
        sub: `sub-mt-a-${randomUUID()}`,
        email: emailA,
        nonce: authA.nonce,
      });

      expect(sessionA.tenantId).toBe(tenantAId);
    });

    it('links a sub in tenant B and gets a tenant-B session', async () => {
      const emailB = await freshUserB();
      const authB = await beginAuthorize(app, 'tenant-b');
      const sessionB = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state: authB.state,
        sub: `sub-mt-b-${randomUUID()}`,
        email: emailB,
        nonce: authB.nonce,
        tenantSlug: 'tenant-b',
      });

      expect(sessionB.tenantId).toBe(tenantBId);
    });

    it('the SAME Google sub links independently in A and B with distinct tenant-scoped sessions', async () => {
      // The whole point of UNIQUE(tenant_id, provider, provider_sub) being
      // tenant-leading: one Google account can be a member of multiple tenants,
      // one row per tenant, each pinned to that tenant's own user.
      const sharedSub = `sub-mt-shared-${randomUUID()}`;
      const emailA = await freshUserA();
      const emailB = await freshUserB();

      const authA = await beginAuthorize(app, 'tenant-a');
      const sessionA = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state: authA.state,
        sub: sharedSub,
        email: emailA,
        nonce: authA.nonce,
      });

      const authB = await beginAuthorize(app, 'tenant-b');
      const sessionB = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state: authB.state,
        sub: sharedSub,
        email: emailB,
        nonce: authB.nonce,
        tenantSlug: 'tenant-b',
      });

      expect(sessionA.tenantId).toBe(tenantAId);
      expect(sessionB.tenantId).toBe(tenantBId);
      expect(sessionA.tenantId).not.toBe(sessionB.tenantId);
    });
  });

  // ── Cross-tenant isolation: sub only in A → login via B → 401 ────────────

  describe('cross-tenant isolation (sub linked in A but not in B)', () => {
    it('sub linked only in tenant A: callback via tenant-B page returns 401', async () => {
      const emailA = await freshUserA();
      const sub = `sub-only-a-${randomUUID()}`;

      // Link in A.
      const authA = await beginAuthorize(app, 'tenant-a');
      await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state: authA.state,
        sub,
        email: emailA,
        nonce: authA.nonce,
      });

      // Attempt via B: same sub + same email, but that email is NOT provisioned
      // in tenant B → invite-only guard rejects with 401.
      const authB = await beginAuthorize(app, 'tenant-b');
      const codeB = `code-b-wrong-sub-${randomUUID()}`;
      fakeGoogle.registerCode(codeB, {
        sub,
        email: emailA, // provisioned only in A
        nonce: authB.nonce,
      });
      const resB = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-b', code: codeB, state: authB.state },
      });

      expect(resB.statusCode).toBe(401);
    });
  });

  // ── R1: validation failures ───────────────────────────────────────────────

  describe('R1 — input validation', () => {
    it('authorize with missing tenantSlug → 400 / validation error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/authorize',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('callback with missing code → 400 / validation error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', state: 'some-state' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('callback with missing state → 400 / validation error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code: 'some-code' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('authorize with unknown tenant slug → 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/authorize',
        payload: { tenantSlug: 'no-such-tenant' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── R2: invite-only (email not provisioned in tenant) ────────────────────

  describe('R2 — invite-only guard (email not provisioned in state tenant)', () => {
    it('first-link with unprovisioned email → 401', async () => {
      const { state, nonce } = await beginAuthorize(app, 'tenant-a');
      const code = randomUUID();
      fakeGoogle.registerCode(code, {
        sub: 'google-sub-nobody',
        email: 'nobody@example.com', // not provisioned in tenant A
        nonce,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code, state },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── R4: state replay / unknown state ────────────────────────────────────

  describe('R4 — state is single-use (replay/unknown → 401)', () => {
    it('completely unknown state → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code: 'any-code', state: 'not-a-real-state' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('replaying a consumed state → 401', async () => {
      const { state, nonce } = await beginAuthorize(app, 'tenant-a');

      // First call consumes the state.
      const code1 = randomUUID();
      fakeGoogle.registerCode(code1, {
        sub: 'google-sub-alice',
        email: 'alice@example.com',
        nonce,
      });
      await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code: code1, state },
      });

      // Second call with the same state → 401 (state already consumed).
      const code2 = randomUUID();
      fakeGoogle.registerCode(code2, {
        sub: 'google-sub-alice',
        email: 'alice@example.com',
        nonce,
      });
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code: code2, state },
      });
      expect(res2.statusCode).toBe(401);
    });
  });

  // ── R5: nonce mismatch ────────────────────────────────────────────────────

  describe('R5 — nonce mismatch in id_token → 401', () => {
    it('id_token with wrong nonce → 401', async () => {
      const { state } = await beginAuthorize(app, 'tenant-a');
      // Register code with a DIFFERENT nonce than the one stored in state.
      const code = randomUUID();
      fakeGoogle.registerCode(code, {
        sub: 'google-sub-alice',
        email: 'alice@example.com',
        nonce: 'WRONG-NONCE-that-does-not-match',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code, state },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── R6: PKCE — exchange fails when code is unknown ────────────────────────
  //
  // In the real flow Google would reject a wrong code_verifier; here we simulate
  // it by NOT registering the code with fakeGoogle, so mintIdToken throws.

  describe('R6 — token exchange failure → 401', () => {
    it('unregistered code (exchange failure) → 401', async () => {
      const { state } = await beginAuthorize(app, 'tenant-a');
      // Do NOT call fakeGoogle.registerCode — exchange will throw → 401.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code: 'unregistered-code', state },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── R10: refresh-token family reuse detection ─────────────────────────────

  describe('R10 — refresh-token family invalidation on reuse', () => {
    it('reusing a rotated refresh token revokes the family and returns 401', async () => {
      // 1. Log in via OIDC to get a refresh token.
      const { state, nonce } = await beginAuthorize(app, 'tenant-a');
      const session = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state,
        sub: 'google-sub-alice',
        email: 'alice@example.com',
        nonce,
      });
      const originalRefreshToken = session.refreshToken;

      // 2. Rotate the token once (legitimate use).
      const rotateRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: originalRefreshToken },
      });
      expect(rotateRes.statusCode).toBe(200);

      // 3. Attempt to reuse the original (now-rotated) token → 401 + family revoked.
      const reuseRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: originalRefreshToken },
      });
      expect(reuseRes.statusCode).toBe(401);
    });
  });

  // ── R13: sub-pinned (different sub for same email → 401) ─────────────────
  //
  // Once a Google sub is linked to a user, a DIFFERENT sub with the same email
  // address in the same tenant cannot hijack the account.
  // (first-link email → user; subsequent: sub must match the linked sub.)

  describe('R13 — sub-pinned: different sub for linked email → rejected', () => {
    it('different sub for an already-linked user → clean 401, original pin untouched (no 500, no silent re-link)', async () => {
      // Dedicated user so this test owns its link state regardless of suite order
      // (alice is linked/relinked by other tests; sub-pinning makes link state
      // order-dependent, so we must not piggyback on it).
      const email = 'r13-pinned@example.com';
      await provisionAdmin(app, opsToken, tenantAId, email, 'pass-r13-1234');

      // First login pins this user to the ORIGINAL sub.
      const auth1 = await beginAuthorize(app, 'tenant-a');
      const linked = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state: auth1.state,
        sub: 'r13-sub-original',
        email,
        nonce: auth1.nonce,
      });
      expect(linked.accessToken).toBeTruthy();
      const userId = linked.userId;

      // Snapshot the user's linked Google identities before the re-pin attempt.
      const before = await armedQuery<{ provider_sub: string }>(
        env.appPool,
        tenantAId,
        `SELECT provider_sub FROM oauth_identities WHERE provider = 'google' AND user_id = $1`,
        [userId],
      );
      expect(before.map((r) => r.provider_sub)).toEqual(['r13-sub-original']);

      // Same email, DIFFERENT sub. The user is already sub-pinned via
      // UNIQUE(tenant_id, user_id, provider): findByProviderSub(newSub) → null →
      // the invite-only guard finds the user → linkFirst INSERT trips THAT
      // constraint (23505), and its re-SELECT by the NEW (provider, sub) finds
      // zero rows → ConflictError → 401.
      //
      // Asserting 401 (NOT 500) locks in the fix for the rows[0]-undefined deref
      // that previously crashed this exact rejection path. Asserting the row set
      // is unchanged locks in "no silent account re-pin" — a forged-but-same-email
      // sub must never hijack an already-linked account (threat model R13).
      const auth2 = await beginAuthorize(app, 'tenant-a');
      fakeGoogle.registerCode('code-r13-different', {
        sub: 'r13-sub-different',
        email, // same email, different sub
        nonce: auth2.nonce,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'tenant-a', code: 'code-r13-different', state: auth2.state },
      });

      expect(res.statusCode).toBe(401);

      // The original pin is intact and NO new identity row was created.
      const after = await armedQuery<{ provider_sub: string }>(
        env.appPool,
        tenantAId,
        `SELECT provider_sub FROM oauth_identities WHERE provider = 'google' AND user_id = $1`,
        [userId],
      );
      expect(after.map((r) => r.provider_sub)).toEqual(['r13-sub-original']);
    });
  });

  // ── R14: email normalization ──────────────────────────────────────────────

  describe('R14 — email normalization (case-insensitive first-link match)', () => {
    it('id_token with uppercase email matches the provisioned lowercase user', async () => {
      // Provisioned lowercase; the id_token returns the UPPERCASE variant —
      // normalizeEmail must match them on first-link.
      const email = await freshUserA();
      const { state, nonce } = await beginAuthorize(app, 'tenant-a');
      const session = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state,
        sub: `sub-norm-${randomUUID()}`,
        email: email.toUpperCase(),
        nonce,
      });
      expect(session.accessToken).toBeTruthy();
      expect(session.tenantId).toBe(tenantAId);
    });

    it('id_token with mixed-case email with surrounding whitespace is normalized', async () => {
      const email = await freshUserA();
      const { state, nonce } = await beginAuthorize(app, 'tenant-a');
      const session = await completeCallback(app, fakeGoogle, {
        code: randomUUID(),
        state,
        sub: `sub-norm-ws-${randomUUID()}`,
        email: `  ${email.toUpperCase()}  `, // mixed/upper + surrounding whitespace
        nonce,
      });
      expect(session.accessToken).toBeTruthy();
      expect(session.tenantId).toBe(tenantAId);
    });
  });
});
