import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ControlPlaneError } from './control-plane';
import {
  createDashboardUpstream,
  deleteDashboardUpstream,
  getDashboardUpstream,
  listDashboardsUpstream,
  listSavedQueriesUpstream,
  mapDashboardError,
  updateDashboardUpstream,
} from './dashboards';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const UID = '00000000-0000-0000-0000-000000000001';

function jsonResponse(status: number, body: unknown): Response {
  // A 204 must not carry a body (Response throws if given one), so pass null.
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch stub that routes by URL pathname; an unexpected path throws (proving it wasn't called). */
function routedFetch(routes: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const r = routes[path];
    if (!r) throw new Error(`unexpected upstream path: ${path}`);
    void init;
    return jsonResponse(r.status, r.body);
  });
}

const dashboard = {
  id: UID,
  tenantId: TENANT,
  name: 'Errors overview',
  description: null,
  layout: { panels: [] },
  createdBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const savedQuery = {
  id: UID,
  tenantId: TENANT,
  name: '5xx last 24h',
  description: null,
  queryText: 'status:5xx',
  filters: {},
  timeRange: { relative: '24h' },
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

describe('mapDashboardError', () => {
  it('maps 401 to a recoverable unauthorized outcome', () => {
    expect(mapDashboardError(new ControlPlaneError(401, 'unauthorized', 'x')).kind).toBe(
      'unauthorized',
    );
  });
  it('maps 403 to a forbidden outcome (RBAC denial) without leaking detail', () => {
    const e = mapDashboardError(new ControlPlaneError(403, 'forbidden', 'nope'));
    expect(e.kind).toBe('forbidden');
    expect(e.message).not.toContain('nope');
  });
  it('surfaces a 4xx validation/conflict message (describes the caller request)', () => {
    const e = mapDashboardError(new ControlPlaneError(422, 'invalid', 'name is required'));
    expect(e.kind).toBe('invalid');
    expect(e.message).toBe('name is required');
  });
  it('collapses a 5xx to a generic unavailable message', () => {
    const e = mapDashboardError(new ControlPlaneError(500, 'internal', 'stack trace detail'));
    expect(e.kind).toBe('unavailable');
    expect(e.message).not.toContain('stack');
  });
  it('collapses a non-control-plane error (e.g. ZodError) to unavailable', () => {
    expect(mapDashboardError(new z.ZodError([])).kind).toBe('unavailable');
  });
});

describe('upstream BFF — fail closed on no session', () => {
  it('listDashboardsUpstream returns unauthorized WITHOUT touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await listDashboardsUpstream(undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getDashboardUpstream returns unauthorized WITHOUT touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await getDashboardUpstream(undefined, UID);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('createDashboardUpstream (a mutation) fails closed WITHOUT touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await createDashboardUpstream(undefined, { name: 'x', layout: { panels: [] } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updateDashboardUpstream fails closed WITHOUT touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await updateDashboardUpstream(undefined, UID, { name: 'y' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deleteDashboardUpstream fails closed WITHOUT touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await deleteDashboardUpstream(undefined, UID);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listSavedQueriesUpstream returns unauthorized WITHOUT touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await listSavedQueriesUpstream(undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('upstream BFF — request + response', () => {
  it('listDashboardsUpstream unwraps the {dashboards} envelope via the shared contract', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ '/v1/dashboards': { status: 200, body: { dashboards: [dashboard] } } }),
    );
    const out = await listDashboardsUpstream('tok');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data[0]?.name).toBe('Errors overview');
  });

  it('getDashboardUpstream GETs /v1/dashboards/:id with the Bearer', async () => {
    const fetchMock = routedFetch({ [`/v1/dashboards/${UID}`]: { status: 200, body: dashboard } });
    vi.stubGlobal('fetch', fetchMock);
    const out = await getDashboardUpstream('tok', UID);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.id).toBe(UID);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/v1/dashboards/${UID}`);
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: 'Bearer tok',
    });
  });

  it('createDashboardUpstream POSTs /v1/dashboards and returns the created dashboard', async () => {
    const fetchMock = routedFetch({ '/v1/dashboards': { status: 201, body: dashboard } });
    vi.stubGlobal('fetch', fetchMock);
    const out = await createDashboardUpstream('tok', {
      name: 'Errors overview',
      layout: { panels: [] },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.name).toBe('Errors overview');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain(TENANT);
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: 'Bearer tok',
    });
  });

  it('updateDashboardUpstream PATCHes /v1/dashboards/:id', async () => {
    const updated = { ...dashboard, name: 'Renamed' };
    const fetchMock = routedFetch({
      [`/v1/dashboards/${UID}`]: { status: 200, body: updated },
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await updateDashboardUpstream('tok', UID, { name: 'Renamed' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.name).toBe('Renamed');
  });

  it('deleteDashboardUpstream DELETEs /v1/dashboards/:id', async () => {
    const fetchMock = routedFetch({ [`/v1/dashboards/${UID}`]: { status: 204 } });
    vi.stubGlobal('fetch', fetchMock);
    const out = await deleteDashboardUpstream('tok', UID);
    expect(out.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/v1/dashboards/${UID}`);
  });

  it('listSavedQueriesUpstream hits GET /v1/saved-queries and unwraps {savedQueries}', async () => {
    const fetchMock = routedFetch({
      '/v1/saved-queries': { status: 200, body: { savedQueries: [savedQuery] } },
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await listSavedQueriesUpstream('tok');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data[0]?.name).toBe('5xx last 24h');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/v1/saved-queries');
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: 'Bearer tok',
    });
  });

  it('listDashboardsUpstream surfaces a 401 as unauthorized and a 403 as forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/v1/dashboards': { status: 401, body: { error: 'unauthorized', message: 'expired' } },
      }),
    );
    const out401 = await listDashboardsUpstream('tok');
    expect(out401.ok).toBe(false);
    if (!out401.ok) expect(out401.error.kind).toBe('unauthorized');

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/v1/dashboards': { status: 403, body: { error: 'forbidden', message: 'nope' } },
      }),
    );
    const out403 = await listDashboardsUpstream('tok');
    expect(out403.ok).toBe(false);
    if (!out403.ok) expect(out403.error.kind).toBe('forbidden');
  });

  it('createDashboardUpstream surfaces a 4xx as an invalid outcome (safe caller-facing message)', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/v1/dashboards': {
          status: 422,
          body: { error: 'invalid', message: 'name is required' },
        },
      }),
    );
    const out = await createDashboardUpstream('tok', { name: 'x', layout: { panels: [] } });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.kind).toBe('invalid');
      expect(out.error.message).toBe('name is required');
    }
  });

  it('deleteDashboardUpstream surfaces a 5xx as unavailable without leaking upstream detail', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        [`/v1/dashboards/${UID}`]: {
          status: 500,
          body: { error: 'internal', message: 'db connection reset by peer at 10.0.0.5' },
        },
      }),
    );
    const out = await deleteDashboardUpstream('tok', UID);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.kind).toBe('unavailable');
      expect(out.error.message).not.toContain('10.0.0.5');
    }
  });

  it('a response-shape drift (ZodError) maps to unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ '/v1/dashboards': { status: 200, body: { dashboards: [{ oops: true }] } } }),
    );
    const out = await listDashboardsUpstream('tok');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unavailable');
  });
});
