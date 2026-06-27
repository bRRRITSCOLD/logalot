import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armedQuery, type ItEnv, seedPlatformOperator, setupEnv, teardownEnv } from './helpers';

// Docker-backed proof of alert-rule CRUD + tenant isolation (issue #16). Runs the
// REAL Fastify app over a REAL Postgres as the NOSUPERUSER logalot_app role, so RLS
// genuinely bites. Mirrors the control-plane integration suite's bootstrap.
//
// Run with: pnpm -C services/control-plane test:integration  (requires Docker).

const OPS_TENANT_ID = '00000000-0000-0000-0000-0000000000f2';

async function login(
  app: FastifyInstance,
  payload: { tenantSlug: string; email: string; password: string },
): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload });
  if (res.statusCode !== 200) {
    throw new Error(`login failed (${res.statusCode}): ${res.body}`);
  }
  return res.json().accessToken;
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('alert-rule CRUD + isolation (integration)', () => {
  let env: ItEnv;
  let app: FastifyInstance;
  let adminAToken: string;
  let adminBToken: string;
  let memberToken: string;
  let tenantAId: string;
  let tenantBId: string;

  const rulePayload = {
    name: 'too many errors',
    threshold: 5,
    windowSeconds: 300,
    severity: 'critical',
    query: { level: 'error', service: 'billing' },
    notifyChannels: [{ type: 'webhook', url: 'https://hooks.example/x' }],
  };

  beforeAll(async () => {
    env = await setupEnv();
    app = env.app;

    await seedPlatformOperator(env, {
      tenantId: OPS_TENANT_ID,
      slug: 'ops2',
      email: 'ops2@logalot.dev',
      password: 'ops-password-2',
    });
    const opsToken = await login(app, {
      tenantSlug: 'ops2',
      email: 'ops2@logalot.dev',
      password: 'ops-password-2',
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
    tenantAId = await mkTenant('alert-a', 'Alert A');
    tenantBId = await mkTenant('alert-b', 'Alert B');

    const provisionAdmin = async (id: string, email: string): Promise<void> => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${id}/admin`,
        headers: auth(opsToken),
        payload: { email, password: 'admin-pass-xyz' },
      });
      expect(r.statusCode).toBe(201);
    };
    await provisionAdmin(tenantAId, 'admin@alert-a.co');
    await provisionAdmin(tenantBId, 'admin@alert-b.co');

    adminAToken = await login(app, {
      tenantSlug: 'alert-a',
      email: 'admin@alert-a.co',
      password: 'admin-pass-xyz',
    });
    adminBToken = await login(app, {
      tenantSlug: 'alert-b',
      email: 'admin@alert-b.co',
      password: 'admin-pass-xyz',
    });

    const createMember = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: auth(adminAToken),
      payload: { email: 'member@alert-a.co', password: 'member-pass-xyz', role: 'member' },
    });
    expect(createMember.statusCode).toBe(201);
    memberToken = await login(app, {
      tenantSlug: 'alert-a',
      email: 'member@alert-a.co',
      password: 'member-pass-xyz',
    });
  }, 180_000);

  afterAll(async () => {
    if (env) await teardownEnv(env);
  });

  let ruleId: string;

  it('tenant_admin creates a rule; tenant_id is stamped from context, state starts ok', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/alert-rules',
      headers: auth(adminAToken),
      payload: rulePayload,
    });
    expect(res.statusCode).toBe(201);
    const rule = res.json();
    ruleId = rule.id;
    expect(rule.tenantId).toBe(tenantAId); // from the JWT, never the body
    expect(rule.state).toBe('ok'); // evaluator-owned; never firing on create
    expect(rule.comparator).toBe('gt'); // default applied
    expect(rule.notifyChannels[0]).toMatchObject({ type: 'webhook' });
  });

  it('a member can list/read rules but CANNOT create (RBAC)', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/alert-rules',
      headers: auth(memberToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().alertRules).toHaveLength(1);

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/alert-rules',
      headers: auth(memberToken),
      payload: { ...rulePayload, name: 'member rule' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('DENIES cross-tenant access: admin B cannot see or read tenant A rules (RLS)', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/alert-rules',
      headers: auth(adminBToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().alertRules).toHaveLength(0); // A's rule invisible to B

    const get = await app.inject({
      method: 'GET',
      url: `/v1/alert-rules/${ruleId}`,
      headers: auth(adminBToken),
    });
    expect(get.statusCode).toBe(404); // RLS miss == genuine miss
  });

  it('DENIES cross-tenant mutation: admin B cannot update or delete tenant A rules', async () => {
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/alert-rules/${ruleId}`,
      headers: auth(adminBToken),
      payload: { enabled: false },
    });
    expect(upd.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/alert-rules/${ruleId}`,
      headers: auth(adminBToken),
    });
    expect(del.statusCode).toBe(404);

    // Storage-layer proof: the row is visible under A's RLS context and invisible
    // under B's — independent of the HTTP layer.
    const asA = await armedQuery(
      env.appPool,
      tenantAId,
      'SELECT id FROM alert_rules WHERE id = $1',
      [ruleId],
    );
    expect(asA).toHaveLength(1);
    const asB = await armedQuery(
      env.appPool,
      tenantBId,
      'SELECT id FROM alert_rules WHERE id = $1',
      [ruleId],
    );
    expect(asB).toHaveLength(0);
  });

  it('tenant_admin updates and deletes its own rule', async () => {
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/alert-rules/${ruleId}`,
      headers: auth(adminAToken),
      payload: { enabled: false, threshold: 10 },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().enabled).toBe(false);
    expect(upd.json().threshold).toBe(10);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/alert-rules/${ruleId}`,
      headers: auth(adminAToken),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/alert-rules/${ruleId}`,
      headers: auth(adminAToken),
    });
    expect(get.statusCode).toBe(404);
  });
});
