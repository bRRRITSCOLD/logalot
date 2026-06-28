import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createApiKeyUpstream,
  getRetentionUpstream,
  listAlertRulesUpstream,
  loadAdminData,
  mapAdminError,
  updateRetentionUpstream,
} from './admin';
import { ControlPlaneError } from './control-plane';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const UID = '00000000-0000-0000-0000-000000000001';

function jwt(role: 'tenant_admin' | 'member' | 'platform_operator', tenantId = TENANT): string {
  const payload = { sub: UID, tenant_id: tenantId, role, iat: 1000, exp: 9_999_999_999 };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `h.${b64}.s`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch stub that routes by URL pathname; an unexpected path throws (proving it wasn't called). */
function routedFetch(routes: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (input: string | URL): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const r = routes[path];
    if (!r) throw new Error(`unexpected upstream path: ${path}`);
    return jsonResponse(r.status, r.body);
  });
}

const tenant = {
  id: TENANT,
  publicId: 'acme',
  name: 'Acme',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const retention = {
  tenantId: TENANT,
  hotDays: 30,
  coldDays: 365,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const alertRule = {
  id: UID,
  tenantId: TENANT,
  name: 'high errors',
  savedQueryId: null,
  query: { text: 'boom' },
  comparator: 'gt',
  threshold: 5,
  windowSeconds: 300,
  severity: 'warning',
  enabled: true,
  notifyChannels: [],
  state: 'ok',
  lastEvaluatedAt: null,
  lastTriggeredAt: null,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  process.env.CONTROL_PLANE_URL = 'http://cp.test:8082';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mapAdminError', () => {
  it('maps 401 to a recoverable unauthorized outcome', () => {
    expect(mapAdminError(new ControlPlaneError(401, 'unauthorized', 'x')).kind).toBe(
      'unauthorized',
    );
  });
  it('maps 403 to a forbidden outcome (RBAC denial) without leaking detail', () => {
    const e = mapAdminError(new ControlPlaneError(403, 'forbidden', 'nope'));
    expect(e.kind).toBe('forbidden');
    expect(e.message).not.toContain('nope');
  });
  it('surfaces a 4xx validation/conflict message (describes the caller request)', () => {
    const e = mapAdminError(new ControlPlaneError(409, 'conflict', 'email already exists'));
    expect(e.kind).toBe('invalid');
    expect(e.message).toBe('email already exists');
  });
  it('collapses a 5xx to a generic unavailable message', () => {
    const e = mapAdminError(new ControlPlaneError(500, 'internal', 'stack trace detail'));
    expect(e.kind).toBe('unavailable');
    expect(e.message).not.toContain('stack');
  });
  it('collapses a non-control-plane error (e.g. ZodError) to unavailable', () => {
    expect(mapAdminError(new z.ZodError([])).kind).toBe('unavailable');
  });
});

describe('upstream BFF — fail closed on no session', () => {
  it('listAlertRulesUpstream returns unauthorized WITHOUT touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await listAlertRulesUpstream(undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('createApiKeyUpstream (a mutation) fails closed WITHOUT touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await createApiKeyUpstream(undefined, { name: 'k', scopes: ['ingest:write'] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('upstream BFF — request + response', () => {
  it('listAlertRulesUpstream unwraps the {alertRules} envelope via the shared contract', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ '/v1/alert-rules': { status: 200, body: { alertRules: [alertRule] } } }),
    );
    const out = await listAlertRulesUpstream(jwt('member'));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data[0]?.name).toBe('high errors');
  });

  it('createApiKeyUpstream returns the one-time plaintext secret', async () => {
    const created = {
      id: 'key1',
      tenantId: TENANT,
      name: 'prod',
      scopes: ['ingest:write'],
      createdBy: null,
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      plaintext: 'lgk_acme_key1_supersecret',
    };
    vi.stubGlobal('fetch', routedFetch({ '/v1/api-keys': { status: 201, body: created } }));
    const out = await createApiKeyUpstream(jwt('tenant_admin'), {
      name: 'prod',
      scopes: ['ingest:write'],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.plaintext).toBe('lgk_acme_key1_supersecret');
  });

  it('getRetentionUpstream maps a 404 (not configured) to a successful null outcome', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/v1/retention': {
          status: 404,
          body: { error: 'not_found', message: 'retention policy not found' },
        },
      }),
    );
    const out = await getRetentionUpstream(jwt('tenant_admin'));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data).toBeNull();
  });

  it('updateRetentionUpstream surfaces a 403 as a forbidden outcome', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/v1/retention': { status: 403, body: { error: 'forbidden', message: 'forbidden' } },
      }),
    );
    const out = await updateRetentionUpstream(jwt('member'), { hotDays: 10, coldDays: 20 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('forbidden');
  });
});

describe('loadAdminData — server-side role gating (tenant isolation / no data leak)', () => {
  it('returns null when there is no valid session (fail closed)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await loadAdminData(undefined)).toBeNull();
  });

  it('NEVER fetches users or api keys for a member (server-gated, not a client hide)', async () => {
    const fetchMock = routedFetch({
      [`/v1/tenants/${TENANT}`]: { status: 200, body: tenant },
      '/v1/retention': { status: 200, body: retention },
      // users / api-keys deliberately NOT routed: a request to them would throw.
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await loadAdminData(jwt('member'));
    expect(data).not.toBeNull();
    expect(data?.role).toBe('member');
    expect(data?.users).toBeNull();
    expect(data?.apiKeys).toBeNull();
    expect(data?.tenant.ok).toBe(true);
    // only the two permitted reads went to the network
    const paths = fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(paths).not.toContain('/v1/users');
    expect(paths).not.toContain('/v1/api-keys');
  });

  it('fetches users + api keys for a tenant_admin', async () => {
    const fetchMock = routedFetch({
      [`/v1/tenants/${TENANT}`]: { status: 200, body: tenant },
      '/v1/retention': { status: 200, body: retention },
      '/v1/users': { status: 200, body: { users: [] } },
      '/v1/api-keys': { status: 200, body: { apiKeys: [] } },
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await loadAdminData(jwt('tenant_admin'));
    expect(data?.users?.ok).toBe(true);
    expect(data?.apiKeys?.ok).toBe(true);
  });

  it("derives the tenant path from the token's OWN claims (no client-supplied tenant id)", async () => {
    const fetchMock = routedFetch({
      [`/v1/tenants/${TENANT}`]: { status: 200, body: tenant },
      '/v1/retention': { status: 200, body: retention },
      '/v1/users': { status: 200, body: { users: [] } },
      '/v1/api-keys': { status: 200, body: { apiKeys: [] } },
    });
    vi.stubGlobal('fetch', fetchMock);
    await loadAdminData(jwt('tenant_admin'));
    const tenantCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/tenants/'));
    expect(String(tenantCall?.[0])).toContain(`/v1/tenants/${TENANT}`);
  });
});
