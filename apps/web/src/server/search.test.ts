import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_SEARCH_FILTERS, type SearchFilters } from '../features/log-search/search-query';
import { searchUpstream } from './search';

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_SEARCH_FILTERS, ...overrides };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const event = {
  tenant_id: 't-1',
  ts: '2026-06-27T10:00:00Z',
  service: 'api',
  level: 'info',
  message: 'hello',
  labels: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchUpstream — BFF fail-closed-on-no-session', () => {
  it('returns 401 WITHOUT calling query-service when there is no token', async () => {
    const fetchImpl = vi.fn();
    const out = await searchUpstream(undefined, EMPTY_SEARCH_FILTERS, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://qs.test',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('searchUpstream — request construction', () => {
  it('forwards the bearer token and maps filters to the search querystring', async () => {
    const fetchImpl = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () =>
      jsonResponse(200, { events: [event] }),
    );
    await searchUpstream(
      'tok-123',
      filters({ text: 'timeout', service: 'api', level: 'error', labels: ['env=prod'] }),
      'CUR==',
      { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'http://qs.test' },
    );
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const url = new URL(call[0]);
    expect(url.pathname).toBe('/v1/search');
    expect(url.searchParams.get('q')).toBe('timeout');
    expect(url.searchParams.get('service')).toBe('api');
    expect(url.searchParams.get('level')).toBe('error');
    expect(url.searchParams.getAll('label')).toEqual(['env=prod']);
    expect(url.searchParams.get('cursor')).toBe('CUR==');
    // an explicit bounded page size is always sent (never the server default)
    expect(url.searchParams.get('limit')).toBe('100');

    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });
});

describe('searchUpstream — responses', () => {
  it('returns the parsed events and nextCursor on success', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { events: [event], nextCursor: 'NEXT==' }),
    );
    const out = await searchUpstream('tok', EMPTY_SEARCH_FILTERS, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://qs.test',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.events).toHaveLength(1);
      expect(out.nextCursor).toBe('NEXT==');
    }
  });

  it('returns an empty page with no cursor (final page)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { events: [] }));
    const out = await searchUpstream('tok', EMPTY_SEARCH_FILTERS, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://qs.test',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.events).toEqual([]);
      expect(out.nextCursor).toBeUndefined();
    }
  });

  it('surfaces a 400 validation message from query-service to the caller', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: 'invalid_request', message: "'from' must be before 'to'" }),
    );
    const out = await searchUpstream('tok', EMPTY_SEARCH_FILTERS, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://qs.test',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.message).toContain("'from' must be before 'to'");
    }
  });

  it('maps an upstream 401 to a 401 outcome (token revoked / expired mid-session)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'unauthorized' }));
    const out = await searchUpstream('tok', EMPTY_SEARCH_FILTERS, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://qs.test',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it('maps a network failure to a generic unavailable outcome (502)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const out = await searchUpstream('tok', EMPTY_SEARCH_FILTERS, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://qs.test',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(502);
      // never leak raw connection detail to the user
      expect(out.message).not.toContain('ECONNREFUSED');
    }
  });

  it('maps a 5xx to a generic unavailable outcome', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'internal' }));
    const out = await searchUpstream('tok', EMPTY_SEARCH_FILTERS, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://qs.test',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(500);
  });
});
