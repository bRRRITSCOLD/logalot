import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ControlPlaneError, cpAuthedFetch, cpLogin, cpLogout, cpRefresh } from './control-plane';

const tokenPair = {
  accessToken: 'a.b.c',
  refreshToken: 'refresh-xyz',
  expiresIn: 900,
  tokenType: 'Bearer',
  role: 'member',
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  userId: '00000000-0000-0000-0000-000000000001',
};

const login = {
  tenantSlug: 'acme',
  email: 'user@acme.test',
  password: 'hunter2hunter2',
};

function mockFetch(status: number, body: unknown) {
  return vi.fn(
    (..._args: Parameters<typeof fetch>): Promise<Response> =>
      Promise.resolve(
        new Response(body === undefined ? '' : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  );
}

beforeEach(() => {
  process.env.CONTROL_PLANE_URL = 'http://cp.test:8082';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cpLogin', () => {
  it('POSTs to /v1/auth/login and parses the token pair via the shared contract', async () => {
    const fetchMock = mockFetch(200, tokenPair);
    vi.stubGlobal('fetch', fetchMock);

    const result = await cpLogin(login);

    expect(result).toEqual(tokenPair);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://cp.test:8082/v1/auth/login');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(login);
  });

  it('maps a non-2xx response to a ControlPlaneError carrying status + code', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(401, { error: 'unauthorized', message: 'invalid credentials' }),
    );

    await expect(cpLogin(login)).rejects.toMatchObject({
      name: 'ControlPlaneError',
      status: 401,
      code: 'unauthorized',
    });
  });

  it('maps a network failure to a 503 upstream_unreachable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(cpLogin(login)).rejects.toMatchObject({
      status: 503,
      code: 'upstream_unreachable',
    });
  });
});

describe('cpRefresh', () => {
  it('POSTs the refresh token to /v1/auth/refresh and parses a fresh token pair', async () => {
    const fetchMock = mockFetch(200, tokenPair);
    vi.stubGlobal('fetch', fetchMock);

    const result = await cpRefresh('refresh-xyz');

    expect(result).toEqual(tokenPair);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://cp.test:8082/v1/auth/refresh');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ refreshToken: 'refresh-xyz' });
  });

  it('maps a revoked/expired refresh (401) to a ControlPlaneError', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { error: 'unauthorized', message: 'expired' }));
    await expect(cpRefresh('stale')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });
});

describe('cpLogout', () => {
  it('POSTs the refresh token to /v1/auth/logout and tolerates an empty 200 body', async () => {
    const fetchMock = mockFetch(200, undefined); // empty body
    vi.stubGlobal('fetch', fetchMock);

    await expect(cpLogout('refresh-xyz')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://cp.test:8082/v1/auth/logout');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ refreshToken: 'refresh-xyz' });
  });
});

describe('cpFetch body parsing (defensive)', () => {
  // Build a Response with an arbitrary content-type + raw (non-JSON) text body.
  function rawResponse(status: number, text: string, contentType = 'text/html') {
    return vi.fn(
      (): Promise<Response> =>
        Promise.resolve(new Response(text, { status, headers: { 'content-type': contentType } })),
    );
  }

  it('throws a typed 502 invalid_response (not a SyntaxError) on a non-JSON 2xx body', async () => {
    vi.stubGlobal('fetch', rawResponse(200, '<html>not json</html>'));
    await expect(cpRefresh('x')).rejects.toMatchObject({
      name: 'ControlPlaneError',
      status: 502,
      code: 'invalid_response',
    });
  });

  it('surfaces the upstream status on a non-JSON error body (proxy 504 HTML)', async () => {
    vi.stubGlobal('fetch', rawResponse(504, '<html>gateway timeout</html>'));
    await expect(cpRefresh('x')).rejects.toMatchObject({
      name: 'ControlPlaneError',
      status: 504,
      code: 'invalid_response',
    });
  });

  it('tolerates an empty 200 body (returns undefined, no throw)', async () => {
    const schema = z.object({ ok: z.boolean() }).optional();
    vi.stubGlobal('fetch', mockFetch(200, undefined));
    await expect(cpAuthedFetch('t', '/v1/ping', schema)).resolves.toBeUndefined();
  });
});

describe('cpAuthedFetch', () => {
  const usersSchema = z.object({ users: z.array(z.unknown()) });

  it('attaches the bearer token and zod-validates the body against the contract', async () => {
    const fetchMock = mockFetch(200, { users: [] });
    vi.stubGlobal('fetch', fetchMock);

    const out = await cpAuthedFetch('access-token-123', '/v1/users', usersSchema);

    expect(out).toEqual({ users: [] });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer access-token-123');
  });

  it('rejects with a ZodError when the upstream shape violates the contract', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { wrong: true }));
    await expect(cpAuthedFetch('t', '/v1/users', usersSchema)).rejects.toBeInstanceOf(z.ZodError);
  });

  it('propagates a ControlPlaneError on 403 (forbidden) before validating', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'forbidden', message: 'forbidden' }));
    await expect(cpAuthedFetch('t', '/v1/tenants', z.unknown())).rejects.toBeInstanceOf(
      ControlPlaneError,
    );
  });
});
