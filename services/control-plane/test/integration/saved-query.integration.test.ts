import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armedQuery, type ItEnv, seedPlatformOperator, setupEnv, teardownEnv } from './helpers';

// Docker-backed proof of saved-query CRUD + tenant isolation (issue #18).
// Runs the REAL Fastify app over a REAL Postgres as the NOSUPERUSER logalot_app
// role, so RLS genuinely bites.
//
// Acceptance criteria proven here:
//   AC1 Saved-query CRUD works, tenant-scoped under RLS.
//   AC2 Tenant A cannot see tenant B's saved queries (RLS).
//   AC4 Cross-tenant leakage: a saved query from tenant B is invisible to tenant A.
//
// Run with: pnpm -C services/control-plane test:integration

const OPS_TENANT_ID = '00000000-0000-0000-0000-0000000000f3';

async function login(
  app: FastifyInstance,
  payload: { tenantSlug: string; email: string; password: string },
): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload });
  if (res.statusCode !== 200) throw new Error(`login failed (${res.statusCode}): ${res.body}`);
  return res.json().accessToken;
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('saved-query CRUD + isolation (integration)', () => {
  let env: ItEnv;
  let app: FastifyInstance;
  let adminAToken: string;
  let adminBToken: string;
  let memberToken: string;
  let tenantAId: string;
  let tenantBId: string;

  const sqPayload = {
    name: 'billing errors',
    description: 'error logs from the billing service',
    queryText: 'error billing',
    filters: { level: 'error', service: 'billing' },
    timeRange: { relative: '24h' },
  };

  beforeAll(async () => {
    env = await setupEnv();
    app = env.app;

    await seedPlatformOperator(env, {
      tenantId: OPS_TENANT_ID,
      slug: 'ops3',
      email: 'ops3@logalot.dev',
      password: 'ops-password-3',
    });
    const opsToken = await login(app, {
      tenantSlug: 'ops3',
      email: 'ops3@logalot.dev',
      password: 'ops-password-3',
    });

    const mkTenant = async (slug: string, name: string): Promise<string> => {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/tenants',
        headers: auth(opsToken),
        payload: { publicId: slug, name },
      });
      expect(r.statusCode).toBe(201);
      return r.json().id;
    };
    tenantAId = await mkTenant('sq-a', 'SQ Tenant A');
    tenantBId = await mkTenant('sq-b', 'SQ Tenant B');

    const provisionAdmin = async (id: string, email: string): Promise<void> => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${id}/admin`,
        headers: auth(opsToken),
        payload: { email, password: 'admin-pass-xyz' },
      });
      expect(r.statusCode).toBe(201);
    };
    await provisionAdmin(tenantAId, 'admin@sq-a.co');
    await provisionAdmin(tenantBId, 'admin@sq-b.co');

    adminAToken = await login(app, { tenantSlug: 'sq-a', email: 'admin@sq-a.co', password: 'admin-pass-xyz' });
    adminBToken = await login(app, { tenantSlug: 'sq-b', email: 'admin@sq-b.co', password: 'admin-pass-xyz' });

    const createMember = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: auth(adminAToken),
      payload: { email: 'member@sq-a.co', password: 'member-pass-xyz', role: 'member' },
    });
    expect(createMember.statusCode).toBe(201);
    memberToken = await login(app, { tenantSlug: 'sq-a', email: 'member@sq-a.co', password: 'member-pass-xyz' });
  }, 180_000);

  afterAll(async () => {
    if (env) await teardownEnv(env);
  });

  let sqId: string;

  it('tenant_admin creates a saved query; tenant_id stamped from context', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/saved-queries',
      headers: auth(adminAToken),
      payload: sqPayload,
    });
    expect(res.statusCode).toBe(201);
    const sq = res.json();
    sqId = sq.id;
    expect(sq.tenantId).toBe(tenantAId); // from JWT, never the body
    expect(sq.name).toBe(sqPayload.name);
    expect(sq.filters.level).toBe('error');
    expect(sq.timeRange.relative).toBe('24h');
  });

  it('a member can list/read saved queries but CANNOT create (RBAC)', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/saved-queries',
      headers: auth(memberToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().savedQueries).toHaveLength(1);

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/saved-queries',
      headers: auth(memberToken),
      payload: { ...sqPayload, name: 'member sq' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('DENIES cross-tenant access: admin B cannot see tenant A saved queries (RLS)', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/saved-queries',
      headers: auth(adminBToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().savedQueries).toHaveLength(0); // A's saved query invisible to B

    const get = await app.inject({
      method: 'GET',
      url: `/v1/saved-queries/${sqId}`,
      headers: auth(adminBToken),
    });
    expect(get.statusCode).toBe(404); // RLS miss == genuine miss
  });

  it('DENIES cross-tenant mutation: admin B cannot update or delete tenant A saved queries', async () => {
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/saved-queries/${sqId}`,
      headers: auth(adminBToken),
      payload: { name: 'hijacked' },
    });
    expect(upd.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/saved-queries/${sqId}`,
      headers: auth(adminBToken),
    });
    expect(del.statusCode).toBe(404);

    // Storage-layer proof: row visible under A's RLS context, invisible under B's.
    const asA = await armedQuery(
      env.appPool,
      tenantAId,
      'SELECT id FROM saved_queries WHERE id = $1',
      [sqId],
    );
    expect(asA).toHaveLength(1);
    const asB = await armedQuery(
      env.appPool,
      tenantBId,
      'SELECT id FROM saved_queries WHERE id = $1',
      [sqId],
    );
    expect(asB).toHaveLength(0);
  });

  it('tenant_admin updates and deletes its own saved query', async () => {
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/saved-queries/${sqId}`,
      headers: auth(adminAToken),
      payload: { name: 'renamed billing errors', filters: { level: 'warn' } },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().name).toBe('renamed billing errors');
    expect(upd.json().filters.level).toBe('warn');

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/saved-queries/${sqId}`,
      headers: auth(adminAToken),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/saved-queries/${sqId}`,
      headers: auth(adminAToken),
    });
    expect(get.statusCode).toBe(404);
  });

  it('rejects duplicate name (409)', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/v1/saved-queries',
      headers: auth(adminAToken),
      payload: sqPayload,
    });
    expect(a.statusCode).toBe(201);

    const b = await app.inject({
      method: 'POST',
      url: '/v1/saved-queries',
      headers: auth(adminAToken),
      payload: sqPayload,
    });
    expect(b.statusCode).toBe(409);
  });
});
