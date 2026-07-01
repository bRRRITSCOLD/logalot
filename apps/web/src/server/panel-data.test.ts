import { afterEach, describe, expect, it, vi } from 'vitest';
import { panelDataUpstream } from './panel-data';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const samplePayload = {
  totalCount: 2,
  buckets: [{ bucketStart: '2026-06-27T10:00:00Z', count: 2 }],
  recentLogs: [
    {
      tenant_id: 't-1',
      ts: '2026-06-27T10:00:00Z',
      service: 'api',
      level: 'info',
      message: 'hello',
      labels: {},
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('panelDataUpstream — BFF fail-closed-on-no-session', () => {
  it('returns 401 WITHOUT calling query-service when there is no token', async () => {
    const fetchImpl = vi.fn();
    const out = await panelDataUpstream(
      undefined,
      { savedQueryId: 'sq-1' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'http://qs.test',
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('panelDataUpstream — request construction', () => {
  it('forwards the bearer token and maps params to the panel-data querystring', async () => {
    const fetchImpl = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () =>
      jsonResponse(200, samplePayload),
    );
    await panelDataUpstream(
      'tok-123',
      { savedQueryId: 'sq-1', from: '2026-06-27T10:00', to: '2026-06-27T11:00', buckets: 10 },
      { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'http://qs.test' },
    );
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const url = new URL(call[0]);
    expect(url.pathname).toBe('/v1/panel-data');
    expect(url.searchParams.get('savedQueryId')).toBe('sq-1');
    expect(url.searchParams.get('buckets')).toBe('10');
    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });
});

describe('panelDataUpstream — responses', () => {
  it('returns the parsed panel data on success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, samplePayload));
    const out = await panelDataUpstream(
      'tok',
      { savedQueryId: 'sq-1' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'http://qs.test',
      },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.totalCount).toBe(2);
      expect(out.data.buckets).toHaveLength(1);
      expect(out.data.recentLogs).toHaveLength(1);
    }
  });

  it('surfaces a 400 validation message from query-service to the caller', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: 'invalid_request', message: "invalid 'buckets' (want 1..100)" }),
    );
    const out = await panelDataUpstream(
      'tok',
      { savedQueryId: 'sq-1' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'http://qs.test',
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.message).toContain("invalid 'buckets'");
    }
  });

  it('maps an upstream 401 to a 401 outcome (token revoked / expired mid-session)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'unauthorized' }));
    const out = await panelDataUpstream(
      'tok',
      { savedQueryId: 'sq-1' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'http://qs.test',
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it('maps a 404 (missing OR cross-tenant saved query) to a plain panel error, never a crash', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'not_found' }));
    const out = await panelDataUpstream(
      'tok',
      { savedQueryId: 'sq-other-tenant' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'http://qs.test',
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(404);
      expect(out.message).toBe('panel query not found');
    }
  });

  it('maps a network failure to a generic unavailable outcome (502)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const out = await panelDataUpstream(
      'tok',
      { savedQueryId: 'sq-1' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'http://qs.test',
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(502);
      // never leak raw connection detail to the user
      expect(out.message).not.toContain('ECONNREFUSED');
    }
  });

  it('maps a 5xx to a generic unavailable outcome', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'internal' }));
    const out = await panelDataUpstream(
      'tok',
      { savedQueryId: 'sq-1' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'http://qs.test',
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(500);
  });

  it('falls back to a generic message on response-shape drift', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { unexpected: true }));
    const out = await panelDataUpstream(
      'tok',
      { savedQueryId: 'sq-1' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'http://qs.test',
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(502);
  });
});
