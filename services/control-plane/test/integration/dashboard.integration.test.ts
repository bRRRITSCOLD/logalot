import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armedQuery, type ItEnv, seedPlatformOperator, setupEnv, teardownEnv } from './helpers';

// Docker-backed proof of dashboard CRUD + tenant isolation (issue #18).
// Proves the panel inline ownership and cross-tenant invisibility.
//
// Run with: pnpm -C services/control-plane test:integration

const OPS_TENANT_ID = '00000000-0000-0000-0000-0000000000f4';

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

describe('dashboard CRUD + isolation (integration)', () => {
  let env: ItEnv;
  let app: FastifyInstance;
  let adminAToken: string;
  let adminBToken: string;
  let memberToken: string;
  let tenantAId: string;
  let tenantBId: string;

  const SAVED_QUERY_ID = '00000000-0000-0000-0000-000000000099';

  const dashPayload = {
    name: 'ops overview',
    description: 'main ops dashboard',
    layout: {
      panels: [
        {
          id: 'p1',
          type: 'timeseries',
          title: '5xx rate',
          savedQueryId: SAVED_QUERY_ID,
          viz: { unit: 'req/s' },
          grid: { x: 0, y: 0, w: 6, h: 4 },
        },
        {
          id: 'p2',
          type: 'stat',
          title: 'error count',
          savedQueryId: SAVED_QUERY_ID,
          viz: {},
          grid: { x: 6, y: 0, w: 3, h: 2 },
        },
      ],
    },
  };

  beforeAll(async () => {
    env = await setupEnv();
    app = env.app;

    await seedPlatformOperator(env, {
      tenantId: OPS_TENANT_ID,
      slug: 'ops4',
      email: 'ops4@logalot.dev',
      password: 'ops-password-4',
    });
    const opsToken = await login(app, {
      tenantSlug: 'ops4',
      email: 'ops4@logalot.dev',
      password: 'ops-password-4',
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
    tenantAId = await mkTenant('dash-a', 'Dash Tenant A');
    tenantBId = await mkTenant('dash-b', 'Dash Tenant B');

    const provisionAdmin = async (id: string, email: string): Promise<void> => {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${id}/admin`,
        headers: auth(opsToken),
        payload: { email, password: 'admin-pass-xyz' },
      });
      expect(r.statusCode).toBe(201);
    };
    await provisionAdmin(tenantAId, 'admin@dash-a.co');
    await provisionAdmin(tenantBId, 'admin@dash-b.co');

    adminAToken = await login(app, { tenantSlug: 'dash-a', email: 'admin@dash-a.co', password: 'admin-pass-xyz' });
    adminBToken = await login(app, { tenantSlug: 'dash-b', email: 'admin@dash-b.co', password: 'admin-pass-xyz' });

    const createMember = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: auth(adminAToken),
      payload: { email: 'member@dash-a.co', password: 'member-pass-xyz', role: 'member' },
    });
    expect(createMember.statusCode).toBe(201);
    memberToken = await login(app, { tenantSlug: 'dash-a', email: 'member@dash-a.co', password: 'member-pass-xyz' });
  }, 180_000);

  afterAll(async () => {
    if (env) await teardownEnv(env);
  });

  let dashId: string;

  it('tenant_admin creates a dashboard; tenant_id stamped from context; panels inline', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboards',
      headers: auth(adminAToken),
      payload: dashPayload,
    });
    expect(res.statusCode).toBe(201);
    const dash = res.json();
    dashId = dash.id;
    expect(dash.tenantId).toBe(tenantAId); // from JWT, never the body
    expect(dash.layout.panels).toHaveLength(2);
    expect(dash.layout.panels[0].type).toBe('timeseries');
    expect(dash.layout.panels[0].savedQueryId).toBe(SAVED_QUERY_ID);
  });

  it('a member can list/read dashboards but CANNOT create (RBAC)', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/dashboards',
      headers: auth(memberToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().dashboards).toHaveLength(1);

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/dashboards',
      headers: auth(memberToken),
      payload: { ...dashPayload, name: 'member dash' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('DENIES cross-tenant access: admin B cannot see tenant A dashboards (RLS)', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/dashboards',
      headers: auth(adminBToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().dashboards).toHaveLength(0); // A's dashboard invisible to B

    const get = await app.inject({
      method: 'GET',
      url: `/v1/dashboards/${dashId}`,
      headers: auth(adminBToken),
    });
    expect(get.statusCode).toBe(404); // RLS miss == genuine miss
  });

  it('DENIES cross-tenant mutation: admin B cannot update or delete tenant A dashboards', async () => {
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboards/${dashId}`,
      headers: auth(adminBToken),
      payload: { name: 'hijacked' },
    });
    expect(upd.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/dashboards/${dashId}`,
      headers: auth(adminBToken),
    });
    expect(del.statusCode).toBe(404);

    // Storage-layer proof: row visible under A's RLS context, invisible under B's.
    const asA = await armedQuery(
      env.appPool,
      tenantAId,
      'SELECT id FROM dashboards WHERE id = $1',
      [dashId],
    );
    expect(asA).toHaveLength(1);
    const asB = await armedQuery(
      env.appPool,
      tenantBId,
      'SELECT id FROM dashboards WHERE id = $1',
      [dashId],
    );
    expect(asB).toHaveLength(0);
  });

  it('tenant_admin updates panels and renames the dashboard', async () => {
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboards/${dashId}`,
      headers: auth(adminAToken),
      payload: {
        name: 'renamed ops',
        layout: { panels: [dashPayload.layout.panels[0]] }, // drop panel 2
      },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().name).toBe('renamed ops');
    expect(upd.json().layout.panels).toHaveLength(1);
  });

  it('tenant_admin deletes the dashboard', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/dashboards/${dashId}`,
      headers: auth(adminAToken),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/dashboards/${dashId}`,
      headers: auth(adminAToken),
    });
    expect(get.statusCode).toBe(404);
  });

  it('rejects duplicate dashboard name (409)', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/v1/dashboards',
      headers: auth(adminAToken),
      payload: dashPayload,
    });
    expect(a.statusCode).toBe(201);

    const b = await app.inject({
      method: 'POST',
      url: '/v1/dashboards',
      headers: auth(adminAToken),
      payload: dashPayload,
    });
    expect(b.statusCode).toBe(409);
  });
});
