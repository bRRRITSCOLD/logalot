import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneError, cpAuthedFetch, cpLogin } from './control-plane';

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

describe('cpAuthedFetch', () => {
  it('attaches the bearer token and returns the parsed body', async () => {
    const fetchMock = mockFetch(200, { users: [] });
    vi.stubGlobal('fetch', fetchMock);

    const out = await cpAuthedFetch('access-token-123', '/v1/users');

    expect(out).toEqual({ users: [] });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer access-token-123');
  });

  it('propagates a ControlPlaneError on 403 (forbidden)', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'forbidden', message: 'forbidden' }));
    await expect(cpAuthedFetch('t', '/v1/tenants')).rejects.toBeInstanceOf(ControlPlaneError);
  });
});
