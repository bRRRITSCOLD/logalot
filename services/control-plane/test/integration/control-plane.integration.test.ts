import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgRefreshTokenRepository } from '../../src/adapters/postgres/refresh-token-repository';
import { parseApiKey } from '../../src/domain/api-key';
import { sha256 } from '../../src/domain/secret-hash';
import { armedQuery, type ItEnv, seedPlatformOperator, setupEnv, teardownEnv } from './helpers';

// Docker-backed end-to-end proof of the load-bearing security properties (issue
// #11). Runs the REAL Fastify app over a REAL Postgres with migrations applied and
// the app connected as the NOSUPERUSER logalot_app role, so RLS genuinely bites.
//
// Run with: pnpm -C services/control-plane test:integration  (requires Docker).

const OPS_TENANT_ID = '00000000-0000-0000-0000-0000000000f1';

async function login(
  app: FastifyInstance,
  payload: { tenantSlug: string; email: string; password: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload });
  if (res.statusCode !== 200) {
    throw new Error(`login failed (${res.statusCode}): ${res.body}`);
  }
  return res.json();
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('control-plane integration', () => {
  let env: ItEnv;
  let app: FastifyInstance;

  let opsToken: string;
  let adminAToken: string;
  let memberToken: string;
  let tenantAId: string;
  let tenantBId: string;
  let bAdminUserId: string;
  let apiKeyPlaintext: string;
  let apiKeyId: string;

  beforeAll(async () => {
    env = await setupEnv();
    app = env.app;

    // Bootstrap the first platform operator, then drive everything else via HTTP.
    await seedPlatformOperator(env, {
      tenantId: OPS_TENANT_ID,
      slug: 'ops',
      email: 'ops@logalot.dev',
      password: 'ops-password-1',
    });
    opsToken = (
      await login(app, { tenantSlug: 'ops', email: 'ops@logalot.dev', password: 'ops-password-1' })
    ).accessToken;

    // platform_operator provisions two tenants...
    const createA = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: auth(opsToken),
      payload: { publicId: 'tenant-a', name: 'Tenant A' },
    });
    expect(createA.statusCode).toBe(201);
    tenantAId = createA.json().id;

    const createB = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: auth(opsToken),
      payload: { publicId: 'tenant-b', name: 'Tenant B' },
    });
    expect(createB.statusCode).toBe(201);
    tenantBId = createB.json().id;

    // ...and bootstraps each tenant's first admin.
    const adminA = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantAId}/admin`,
      headers: auth(opsToken),
      payload: { email: 'admin@a.co', password: 'admin-pass-a' },
    });
    expect(adminA.statusCode).toBe(201);
    const adminB = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantBId}/admin`,
      headers: auth(opsToken),
      payload: { email: 'admin@b.co', password: 'admin-pass-b' },
    });
    expect(adminB.statusCode).toBe(201);
    bAdminUserId = adminB.json().id;

    adminAToken = (
      await login(app, { tenantSlug: 'tenant-a', email: 'admin@a.co', password: 'admin-pass-a' })
    ).accessToken;

    // tenant_admin A creates a member.
    const createMember = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: auth(adminAToken),
      payload: { email: 'member@a.co', password: 'member-pass-a', role: 'member' },
    });
    expect(createMember.statusCode).toBe(201);
    memberToken = (
      await login(app, { tenantSlug: 'tenant-a', email: 'member@a.co', password: 'member-pass-a' })
    ).accessToken;

    // tenant_admin A issues an API key (plaintext returned once).
    const createKey = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(adminAToken),
      payload: { name: 'ci-key' },
    });
    expect(createKey.statusCode).toBe(201);
    apiKeyPlaintext = createKey.json().plaintext;
    apiKeyId = createKey.json().id;
  }, 180_000);

  afterAll(async () => {
    if (env) {
      await teardownEnv(env);
    }
  });

  // Regression: GET /v1/tenants/:id validated `:id` with raw `z.string().uuid()`,
  // which (Zod 4) rejects the structured/all-zero dev-seed ids Postgres accepts —
  // so the admin page's Workspace card got a 400 "request validation failed" for a
  // perfectly valid tenant id. The path param must use the permissive shared
  // `uuidSchema`. OPS_TENANT_ID is exactly such a structured id.
  it('TenantRoutes_GetByStructuredSeedId_DoesNotRejectAsInvalidUuid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${OPS_TENANT_ID}`,
      headers: auth(opsToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: OPS_TENANT_ID });
  });

  it('scopes a tenant_admin to its own tenant for user listings', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users', headers: auth(adminAToken) });
    expect(res.statusCode).toBe(200);
    const emails = res
      .json()
      .users.map((u: { email: string }) => u.email)
      .sort();
    expect(emails).toEqual(['admin@a.co', 'member@a.co']);
  });

  it('DENIES cross-tenant access: admin A cannot read tenant B users (RLS → 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/users/${bAdminUserId}`,
      headers: auth(adminAToken),
    });
    // B's user is invisible under A's RLS context — indistinguishable from a miss.
    expect(res.statusCode).toBe(404);
  });

  it('issued API key is stored as sha256(secret) — Go-Authenticator compatible', async () => {
    const parsed = parseApiKey(apiKeyPlaintext);
    expect(parsed.publicId).toBe('tenant-a'); // slug embedded for RLS arming
    const rows = await env.adminPool.query<{ key_hash: Buffer }>(
      'SELECT key_hash FROM api_keys WHERE id = $1',
      [parsed.keyId],
    );
    expect(rows.rows).toHaveLength(1);
    // The stored bytea equals sha256(secret) — exactly what the Go ingest
    // Authenticator computes + constant-time compares (migration 000005).
    expect(sha256(parsed.secret).equals(rows.rows[0]?.key_hash as Buffer)).toBe(true);
  });

  it('an API key is invisible across tenants at the storage layer (RLS)', async () => {
    const asA = await armedQuery(env.appPool, tenantAId, 'SELECT id FROM api_keys WHERE id = $1', [
      apiKeyId,
    ]);
    expect(asA).toHaveLength(1);
    const asB = await armedQuery(env.appPool, tenantBId, 'SELECT id FROM api_keys WHERE id = $1', [
      apiKeyId,
    ]);
    expect(asB).toHaveLength(0);
  });

  it('RBAC: a member cannot manage keys or users', async () => {
    const key = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(memberToken),
      payload: { name: 'nope' },
    });
    expect(key.statusCode).toBe(403);
    const users = await app.inject({ method: 'GET', url: '/v1/users', headers: auth(memberToken) });
    expect(users.statusCode).toBe(403);
  });

  it('RBAC: platform_operator is barred from tenant content (cannot list users)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users', headers: auth(opsToken) });
    expect(res.statusCode).toBe(403);
  });

  it('retention: admin can write, member can read but not write', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/retention',
      headers: auth(adminAToken),
      payload: { hotDays: 14, coldDays: 30 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ hotDays: 14, coldDays: 30, tenantId: tenantAId });

    const read = await app.inject({
      method: 'GET',
      url: '/v1/retention',
      headers: auth(memberToken),
    });
    expect(read.statusCode).toBe(200);

    const memberPut = await app.inject({
      method: 'PUT',
      url: '/v1/retention',
      headers: auth(memberToken),
      payload: { hotDays: 1, coldDays: 1 },
    });
    expect(memberPut.statusCode).toBe(403);
  });

  it('JWT: missing or tampered tokens are rejected (401)', async () => {
    const none = await app.inject({ method: 'GET', url: '/v1/users' });
    expect(none.statusCode).toBe(401);
    const tampered = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: auth(`${adminAToken}x`),
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('login → JWT → refresh rotation; the rotated token is rejected on reuse', async () => {
    const session = await login(app, {
      tenantSlug: 'tenant-a',
      email: 'admin@a.co',
      password: 'admin-pass-a',
    });
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refreshToken).not.toBe(session.refreshToken);

    // Reusing the now-rotated refresh token is rejected (family reuse detection).
    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('wrong password is rejected (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenantSlug: 'tenant-a', email: 'admin@a.co', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rotate() is atomic: two concurrent rotations of one token yield exactly one successor', async () => {
    // The load-bearing TOCTOU proof, at the repository level against the REAL DB so
    // the conditional UPDATE genuinely serializes (the HTTP path's findById +
    // early-reuse check can mask the race depending on timing; this cannot).
    const repo = new PgRefreshTokenRepository(env.appPool);
    const [u] = await armedQuery<{ id: string }>(
      env.appPool,
      tenantAId,
      'SELECT id FROM users WHERE email = $1',
      ['admin@a.co'],
    );
    const userId = (u as { id: string }).id;
    const familyId = randomUUID();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const created = await repo.create(tenantAId, {
      familyId,
      userId,
      tokenHash: sha256('seed-secret'),
      expiresAt,
    });
    const now = new Date();
    const successor = (h: string) => ({ familyId, userId, tokenHash: sha256(h), expiresAt });
    const [r1, r2] = await Promise.all([
      repo.rotate(tenantAId, created.id, now, successor('s1')),
      repo.rotate(tenantAId, created.id, now, successor('s2')),
    ]);
    // Exactly one rotation consumes the token; the loser gets null (0 rows).
    const winners = [r1, r2].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it('concurrent refresh of the same token never mints two live sessions (E2E)', async () => {
    const session = await login(app, {
      tenantSlug: 'tenant-a',
      email: 'admin@a.co',
      password: 'admin-pass-a',
    });
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: session.refreshToken },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: session.refreshToken },
      }),
    ]);
    // At most one 200; the original token is consumed exactly once.
    const successes = [a, b].filter((r) => r.statusCode === 200);
    expect(successes.length).toBeLessThanOrEqual(1);
    // Reusing the original token again is always rejected (it is now consumed).
    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('a suspended tenant can no longer refresh (401)', async () => {
    // tenant-b is otherwise unused by later tests, so suspending it is isolated.
    const session = await login(app, {
      tenantSlug: 'tenant-b',
      email: 'admin@b.co',
      password: 'admin-pass-b',
    });
    await env.adminPool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantBId]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(res.statusCode).toBe(401);
  });
});
