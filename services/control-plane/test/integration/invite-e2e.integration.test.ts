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
import { PgInviteProvisioner } from '../../src/adapters/postgres/pg-invite-provisioner';
import { PgRefreshTokenRepository } from '../../src/adapters/postgres/refresh-token-repository';
import { PgTenantRepository } from '../../src/adapters/postgres/tenant-repository';
import { PgUserRepository } from '../../src/adapters/postgres/user-repository';
import { InMemoryOAuthStateStore } from '../../src/adapters/redis/in-memory-oauth-state-store';
import { OidcAuthenticator } from '../../src/app/oidc-authenticator';
import type { GoogleTokenExchangeClient, GoogleTokenExchangeResult } from '../../src/app/ports';
import { buildContainer } from '../../src/container';
import { armedQuery, type ItEnv, seedPlatformOperator, setupEnv, teardownEnv } from './helpers';

// ── Cross-service invite end-to-end (issue #160, epic #140) ────────────────
//
// Drives create -> accept -> callback through the REAL HTTP surface + a real
// Postgres (testcontainers, migrations applied), mirroring the fake-Google +
// testcontainers pattern from oidc-e2e.integration.test.ts (commit 4097b6a).
//
// The invite-acceptance path is exercised via the SAME /v1/auth/oidc/google/callback
// route the browser hits: an admin issues an invite (POST /v1/invites), the
// invitee completes an OIDC login carrying the invite token, and the callback
// atomically consumes the invite + provisions the user + membership + identity
// (ADR-0012 §5, PgInviteProvisioner).
//
// Matrix (spec §137 / threat model), each row -> R-INV-*:
//   happy path              — user+membership(role)+identity+consumed (R-INV-1, R-INV-8)
//   email mismatch           — 401, invite NOT consumed (R-INV-3)
//   expired                  — 401 (R-INV-4)
//   revoked                  — 401 (R-INV-5)
//   concurrent double-accept — provisioned exactly once (R-INV-3)
//   no invite at all         — unchanged reject_no_provisioned_user 401 control (R-INV-6)
//   cross-tenant list/revoke — absent / 404 (R-INV-15)
//   EMAIL_PROVIDER=none      — create succeeds, link returned, no send (R-INV-14)

// ── Fake Google OIDC (same shape as oidc-e2e.integration.test.ts) ──────────

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

class FakeGoogleOidc {
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;
  private readonly codes = new Map<string, FakeCodeEntry>();

  async init(): Promise<void> {
    const kp = await generateKeyPair('RS256', { extractable: true });
    this.privateKey = kp.privateKey;
    this.publicKey = kp.publicKey;
  }

  async makeJwksGetKey() {
    const jwk = await exportJWK(this.publicKey);
    return createLocalJWKSet({
      keys: [{ ...jwk, kid: FAKE_KEY_ID, use: 'sig', alg: 'RS256' }],
    });
  }

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

// ── InviteEnv ─────────────────────────────────────────────────────────────

interface InviteEnv extends ItEnv {
  inviteApp: FastifyInstance;
  fakeGoogle: FakeGoogleOidc;
}

async function setupInviteEnv(): Promise<InviteEnv> {
  // 1. Start Postgres testcontainer + apply migrations. EMAIL_PROVIDER defaults
  //    to 'none' (see config/env.ts) — no SMTP config needed for this suite.
  const base = await setupEnv();
  const { appPool, config } = base;

  // 2. Build a fake Google OIDC provider (real RS256 key pair; matching JWKS).
  const fakeGoogle = new FakeGoogleOidc();
  await fakeGoogle.init();

  // 3. Build the real container — services.invites is the REAL InviteService
  //    (real repo, real secret generator, real clock, NoOp email sender since
  //    EMAIL_PROVIDER=none). We only replace the OIDC callback-half adapters.
  const container = buildContainer(appPool, config);

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

  const stateStore = new InMemoryOAuthStateStore();
  const jwksGetKey = await fakeGoogle.makeJwksGetKey();
  const idTokenVerifier = new JoseGoogleIdTokenVerifier({
    clientId: FAKE_CLIENT_ID,
    jwksGetKey,
  });
  const tokenExchangeClient = new FakeGoogleTokenExchangeClient(fakeGoogle);

  // Real invite provisioner (same adapter production uses) against the SAME
  // Postgres pool the invite HTTP routes write through — a single tenant-armed
  // transaction per accept (ADR-0012 §5, R-INV-17).
  const inviteProvisioner = new PgInviteProvisioner({ pool: appPool });

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
    inviteProvisioner,
  });

  const inviteApp = buildServer({
    services: container.services,
    tokenService,
    oidcAuthenticator,
    ping: async () => true,
    logger: false,
    trustProxy: false,
    // Lift both the OIDC callback AND invite-create rate limits (same ceiling,
    // see routes.ts) — every test hits from the loopback IP.
    oidcRateLimitMax: 100_000,
  });
  await inviteApp.ready();

  await container.shutdown();

  return { ...base, inviteApp, fakeGoogle };
}

async function teardownInviteEnv(env: InviteEnv): Promise<void> {
  await env.inviteApp.close();
  await teardownEnv(env);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

const OPS_TENANT_ID = '00000000-0000-0000-0000-0000000000f2';

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function opsLogin(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenantSlug: 'ops-inv', email: 'ops@logalot.dev', password: 'ops-password' },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { accessToken: string }).accessToken;
}

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

async function provisionAdmin(
  app: FastifyInstance,
  opsToken: string,
  tenantId: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/tenants/${tenantId}/admin`,
    headers: authHeader(opsToken),
    payload: { email, password },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function adminLogin(
  app: FastifyInstance,
  tenantSlug: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenantSlug, email, password },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { accessToken: string }).accessToken;
}

interface CreatedInvite {
  id: string;
  email: string;
  role: string;
  status: string;
  inviteUrl: string;
  tokenPlaintext: string;
}

/** Issues an invite via POST /v1/invites (tenant_admin only) and returns the parsed record. */
async function createInvite(
  app: FastifyInstance,
  adminToken: string,
  email: string,
  role: 'member' | 'admin' = 'member',
): Promise<CreatedInvite> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/invites',
    headers: authHeader(adminToken),
    payload: { email, role },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    id: string;
    email: string;
    role: string;
    status: string;
    inviteUrl: string;
  };
  const tokenPlaintext = new URL(body.inviteUrl).searchParams.get('token') ?? '';
  expect(tokenPlaintext).not.toBe('');
  return { ...body, tokenPlaintext };
}

async function beginAuthorize(
  app: FastifyInstance,
  tenantSlug: string,
): Promise<{ state: string; nonce: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/oidc/google/authorize',
    payload: { tenantSlug },
  });
  expect(res.statusCode).toBe(200);
  const { redirectUrl } = res.json() as { redirectUrl: string };
  const url = new URL(redirectUrl);
  const state = url.searchParams.get('state') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';
  return { state, nonce };
}

/** Completes the OIDC callback WITH an inviteToken, returning the raw response. */
async function acceptInvite(
  app: FastifyInstance,
  fakeGoogle: FakeGoogleOidc,
  opts: {
    tenantSlug: string;
    state: string;
    nonce: string;
    sub: string;
    email: string;
    inviteToken?: string;
  },
) {
  const code = randomUUID();
  fakeGoogle.registerCode(code, { sub: opts.sub, email: opts.email, nonce: opts.nonce });
  return app.inject({
    method: 'POST',
    url: '/v1/auth/oidc/google/callback',
    payload: {
      tenantSlug: opts.tenantSlug,
      code,
      state: opts.state,
      ...(opts.inviteToken ? { inviteToken: opts.inviteToken } : {}),
    },
  });
}

async function getInviteStatus(env: InviteEnv, inviteId: string): Promise<string> {
  const res = await env.adminPool.query<{ status: string }>(
    'SELECT status FROM invites WHERE id = $1',
    [inviteId],
  );
  return (res.rows[0] as { status: string }).status;
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('Invite end-to-end (fake Google, testcontainers Postgres)', () => {
  let env: InviteEnv;
  let app: FastifyInstance;
  let fakeGoogle: FakeGoogleOidc;

  let opsToken: string;
  let tenantAId: string;
  let tenantBId: string;
  let adminAToken: string;
  let adminBToken: string;

  beforeAll(async () => {
    env = await setupInviteEnv();
    app = env.inviteApp;
    fakeGoogle = env.fakeGoogle;

    await seedPlatformOperator(env, {
      tenantId: OPS_TENANT_ID,
      slug: 'ops-inv',
      email: 'ops@logalot.dev',
      password: 'ops-password',
    });
    opsToken = await opsLogin(app);

    tenantAId = await createTenant(app, opsToken, 'inv-tenant-a', 'Invite Tenant A');
    tenantBId = await createTenant(app, opsToken, 'inv-tenant-b', 'Invite Tenant B');

    await provisionAdmin(app, opsToken, tenantAId, 'admin-a@inv.example', 'admin-a-pass1');
    await provisionAdmin(app, opsToken, tenantBId, 'admin-b@inv.example', 'admin-b-pass1');

    adminAToken = await adminLogin(app, 'inv-tenant-a', 'admin-a@inv.example', 'admin-a-pass1');
    adminBToken = await adminLogin(app, 'inv-tenant-b', 'admin-b@inv.example', 'admin-b-pass1');
  });

  afterAll(() => teardownInviteEnv(env));

  // ── Happy path: user+membership(role)+identity+consumed (R-INV-1, R-INV-8) ──

  describe('happy path — create, accept, provision', () => {
    it('create succeeds with EMAIL_PROVIDER=none: link returned, no send (R-INV-14)', async () => {
      const email = `happy-${randomUUID()}@inv.example`;
      const invite = await createInvite(app, adminAToken, email, 'admin');

      expect(invite.status).toBe('pending');
      expect(invite.email).toBe(email);
      expect(invite.inviteUrl).toContain('/invite/accept?token=lginv_');
      expect(invite.tokenPlaintext).toMatch(/^lginv_inv-tenant-a_/);
    });

    it('accept provisions user+membership(role)+identity and consumes the invite', async () => {
      const email = `accept-${randomUUID()}@inv.example`;
      const sub = `sub-accept-${randomUUID()}`;
      const invite = await createInvite(app, adminAToken, email, 'admin');

      const { state, nonce } = await beginAuthorize(app, 'inv-tenant-a');
      const res = await acceptInvite(app, fakeGoogle, {
        tenantSlug: 'inv-tenant-a',
        state,
        nonce,
        sub,
        email,
        inviteToken: invite.tokenPlaintext,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        accessToken: string;
        refreshToken: string;
        tenantId: string;
        userId: string;
        role: string;
      };
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).toBeTruthy();
      expect(body.tenantId).toBe(tenantAId);
      expect(body.role).toBe('tenant_admin'); // translated from invite role 'admin'

      // User + membership(role) committed.
      const users = await armedQuery<{ email: string }>(
        env.appPool,
        tenantAId,
        'SELECT email FROM users WHERE id = $1',
        [body.userId],
      );
      expect(users).toHaveLength(1);
      expect(users[0]?.email).toBe(email);

      const memberships = await armedQuery<{ role: string }>(
        env.appPool,
        tenantAId,
        'SELECT role FROM memberships WHERE user_id = $1',
        [body.userId],
      );
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.role).toBe('tenant_admin');

      // Identity linked.
      const identities = await armedQuery<{ provider_sub: string }>(
        env.appPool,
        tenantAId,
        `SELECT provider_sub FROM oauth_identities WHERE user_id = $1 AND provider = 'google'`,
        [body.userId],
      );
      expect(identities).toHaveLength(1);
      expect(identities[0]?.provider_sub).toBe(sub);

      // Invite consumed (single-use, R-INV-3).
      expect(await getInviteStatus(env, invite.id)).toBe('consumed');
    });
  });

  // ── Email mismatch → 401, invite NOT consumed (R-INV-3) ────────────────────

  it('email mismatch on the id_token → 401 and the invite stays pending', async () => {
    const invitedEmail = `mismatch-${randomUUID()}@inv.example`;
    const wrongEmail = `wrong-${randomUUID()}@inv.example`;
    const invite = await createInvite(app, adminAToken, invitedEmail, 'member');

    const { state, nonce } = await beginAuthorize(app, 'inv-tenant-a');
    const res = await acceptInvite(app, fakeGoogle, {
      tenantSlug: 'inv-tenant-a',
      state,
      nonce,
      sub: `sub-mismatch-${randomUUID()}`,
      email: wrongEmail, // Google identity email != invited email
      inviteToken: invite.tokenPlaintext,
    });

    expect(res.statusCode).toBe(401);
    expect(await getInviteStatus(env, invite.id)).toBe('pending');
  });

  // ── Expired → 401 (R-INV-4) ─────────────────────────────────────────────────

  it('expired invite → 401 and stays pending (not silently transitioned)', async () => {
    const email = `expired-${randomUUID()}@inv.example`;
    const sub = `sub-expired-${randomUUID()}`;
    const invite = await createInvite(app, adminAToken, email, 'member');

    // Force expiry directly via the admin (superuser) pool — bypasses RLS,
    // mirrors the pattern in invite-provisioner.integration.test.ts.
    await env.adminPool.query(
      "UPDATE invites SET expires_at = now() - interval '1 hour' WHERE id = $1",
      [invite.id],
    );

    const { state, nonce } = await beginAuthorize(app, 'inv-tenant-a');
    const res = await acceptInvite(app, fakeGoogle, {
      tenantSlug: 'inv-tenant-a',
      state,
      nonce,
      sub,
      email,
      inviteToken: invite.tokenPlaintext,
    });

    expect(res.statusCode).toBe(401);
    expect(await getInviteStatus(env, invite.id)).toBe('pending');
  });

  // ── Revoked → 401 (R-INV-5) ──────────────────────────────────────────────────

  it('revoked invite → 401', async () => {
    const email = `revoked-${randomUUID()}@inv.example`;
    const sub = `sub-revoked-${randomUUID()}`;
    const invite = await createInvite(app, adminAToken, email, 'member');

    const revokeRes = await app.inject({
      method: 'POST',
      url: `/v1/invites/${invite.id}/revoke`,
      headers: authHeader(adminAToken),
    });
    expect(revokeRes.statusCode).toBe(204);
    expect(await getInviteStatus(env, invite.id)).toBe('revoked');

    const { state, nonce } = await beginAuthorize(app, 'inv-tenant-a');
    const res = await acceptInvite(app, fakeGoogle, {
      tenantSlug: 'inv-tenant-a',
      state,
      nonce,
      sub,
      email,
      inviteToken: invite.tokenPlaintext,
    });

    expect(res.statusCode).toBe(401);
    expect(await getInviteStatus(env, invite.id)).toBe('revoked');
  });

  // ── Concurrent double-accept → provisioned exactly once (R-INV-3) ──────────

  it('concurrent accept of the same invite provisions exactly one principal', async () => {
    const email = `race-${randomUUID()}@inv.example`;
    const invite = await createInvite(app, adminAToken, email, 'member');

    const authA = await beginAuthorize(app, 'inv-tenant-a');
    const authB = await beginAuthorize(app, 'inv-tenant-a');

    const [resA, resB] = await Promise.all([
      acceptInvite(app, fakeGoogle, {
        tenantSlug: 'inv-tenant-a',
        state: authA.state,
        nonce: authA.nonce,
        sub: `sub-race-a-${randomUUID()}`,
        email,
        inviteToken: invite.tokenPlaintext,
      }),
      acceptInvite(app, fakeGoogle, {
        tenantSlug: 'inv-tenant-a',
        state: authB.state,
        nonce: authB.nonce,
        sub: `sub-race-b-${randomUUID()}`,
        email,
        inviteToken: invite.tokenPlaintext,
      }),
    ]);

    const statusCodes = [resA.statusCode, resB.statusCode].sort();
    // Exactly one 200 (won the atomic consume), one 401 (lost the race).
    expect(statusCodes).toEqual([200, 401]);

    const users = await env.adminPool.query<{ id: string }>(
      'SELECT id FROM users WHERE tenant_id = $1 AND email = $2',
      [tenantAId, email],
    );
    expect(users.rows).toHaveLength(1);

    const winnerUserId = (users.rows[0] as { id: string }).id;
    const identities = await env.adminPool.query<{ provider_sub: string }>(
      `SELECT provider_sub FROM oauth_identities WHERE tenant_id = $1 AND user_id = $2 AND provider = 'google'`,
      [tenantAId, winnerUserId],
    );
    expect(identities.rows).toHaveLength(1);

    expect(await getInviteStatus(env, invite.id)).toBe('consumed');
  });

  // ── No invite at all → unchanged reject_no_provisioned_user control (R-INV-6) ─

  it('no invite at all: unprovisioned email → 401, byte-identical control behavior', async () => {
    const email = `nocontrol-${randomUUID()}@inv.example`;
    const sub = `sub-nocontrol-${randomUUID()}`;

    const { state, nonce } = await beginAuthorize(app, 'inv-tenant-a');
    // No inviteToken at all — exercises the pre-feature `reject_no_provisioned_user`
    // path, which must remain fully intact regardless of invite-feature wiring.
    const res = await acceptInvite(app, fakeGoogle, {
      tenantSlug: 'inv-tenant-a',
      state,
      nonce,
      sub,
      email,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json() as { message?: string };
    expect(body.message).toBe('no provisioned account for this Google identity');

    // No user, no identity — nothing was silently provisioned.
    const users = await env.adminPool.query(
      'SELECT id FROM users WHERE tenant_id = $1 AND email = $2',
      [tenantAId, email],
    );
    expect(users.rows).toHaveLength(0);
  });

  // ── Cross-tenant list/revoke → absent/404 (R-INV-15) ────────────────────────

  describe('cross-tenant isolation', () => {
    it("an invite created in tenant A is absent from tenant B's list", async () => {
      const email = `crosslist-${randomUUID()}@inv.example`;
      const invite = await createInvite(app, adminAToken, email, 'member');

      const listA = await app.inject({
        method: 'GET',
        url: '/v1/invites',
        headers: authHeader(adminAToken),
      });
      expect(listA.statusCode).toBe(200);
      const invitesA = (listA.json() as { invites: Array<{ id: string }> }).invites;
      expect(invitesA.some((i) => i.id === invite.id)).toBe(true);

      const listB = await app.inject({
        method: 'GET',
        url: '/v1/invites',
        headers: authHeader(adminBToken),
      });
      expect(listB.statusCode).toBe(200);
      const invitesB = (listB.json() as { invites: Array<{ id: string }> }).invites;
      expect(invitesB.some((i) => i.id === invite.id)).toBe(false);
    });

    it('revoking a tenant-A invite id as a tenant-B admin → 404 (not 403; RLS hides it)', async () => {
      const email = `crossrevoke-${randomUUID()}@inv.example`;
      const invite = await createInvite(app, adminAToken, email, 'member');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/invites/${invite.id}/revoke`,
        headers: authHeader(adminBToken),
      });
      expect(res.statusCode).toBe(404);

      // Untouched — still pending under its own tenant.
      expect(await getInviteStatus(env, invite.id)).toBe('pending');
    });
  });
});
