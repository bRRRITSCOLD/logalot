import type { TokenPair } from '@logalot/contracts';
import { describe, expect, it, vi } from 'vitest';
import { parseCookieHeader, resolveTailAuth, tailProxy } from './tail-proxy';

// Unsigned JWT-shaped token (the BFF decodes, never verifies — see session.ts).
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const baseClaims = {
  sub: '00000000-0000-0000-0000-000000000001',
  tenant_id: '00000000-0000-0000-0000-0000000000aa',
  role: 'tenant_admin' as const,
  iat: 1_000,
};
const liveToken = fakeJwt({ ...baseClaims, exp: 2_000_000_000 });
const expiredToken = fakeJwt({ ...baseClaims, exp: 1_000 });

function req(cookie?: string): Request {
  return new Request('https://app.example/api/tail', {
    headers: cookie ? { cookie } : {},
  });
}

const tokenPair: TokenPair = {
  accessToken: fakeJwt({ ...baseClaims, exp: 2_000_000_001 }),
  refreshToken: 'new-refresh',
  expiresIn: 900,
  tokenType: 'Bearer',
  role: 'tenant_admin',
  tenantId: baseClaims.tenant_id,
  userId: baseClaims.sub,
};

/** An upstream Response that streams one SSE frame, for pipe assertions. */
function upstreamSse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"hello":"world"}\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('parseCookieHeader', () => {
  it('parses a multi-cookie header into a map', () => {
    expect(parseCookieHeader('lg_at=abc; lg_rt=def; other=1')).toEqual({
      lg_at: 'abc',
      lg_rt: 'def',
      other: '1',
    });
  });
  it('returns empty for a null/blank header', () => {
    expect(parseCookieHeader(null)).toEqual({});
  });
});

describe('resolveTailAuth', () => {
  it('uses a live access cookie without refreshing', async () => {
    const refresh = vi.fn();
    const auth = await resolveTailAuth(req(`lg_at=${liveToken}`), { refresh });
    expect(auth.ok).toBe(true);
    expect(auth.token).toBe(liveToken);
    expect(auth.setCookies).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when the access token is expired and forwards rotated cookies', async () => {
    const refresh = vi.fn(async () => tokenPair);
    const auth = await resolveTailAuth(req(`lg_at=${expiredToken}; lg_rt=rt-1`), { refresh });
    expect(refresh).toHaveBeenCalledWith('rt-1');
    expect(auth.ok).toBe(true);
    expect(auth.token).toBe(tokenPair.accessToken);
    expect(auth.setCookies.some((c) => c.startsWith('lg_at='))).toBe(true);
    expect(auth.setCookies.some((c) => c.startsWith('lg_rt='))).toBe(true);
    expect(auth.setCookies.every((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);
  });

  it('refreshes when there is no access cookie but a refresh cookie exists', async () => {
    const refresh = vi.fn(async () => tokenPair);
    const auth = await resolveTailAuth(req('lg_rt=rt-1'), { refresh });
    expect(refresh).toHaveBeenCalledWith('rt-1');
    expect(auth.ok).toBe(true);
  });

  it('fails closed when there is no session at all', async () => {
    const refresh = vi.fn();
    const auth = await resolveTailAuth(req(), { refresh });
    expect(auth.ok).toBe(false);
    expect(auth.token).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('fails closed when the refresh is rejected (expired/revoked)', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('revoked');
    });
    const auth = await resolveTailAuth(req(`lg_at=${expiredToken}; lg_rt=rt-1`), { refresh });
    expect(auth.ok).toBe(false);
  });
});

describe('tailProxy', () => {
  it('injects the bearer token + SSE Accept and pipes the upstream stream back', async () => {
    const fetchImpl = vi.fn(async () => upstreamSse());
    const res = await tailProxy(req(`lg_at=${liveToken}`), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://query:8081',
      refresh: vi.fn(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    // Upstream was called with the server-injected auth — the browser never sees it.
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://query:8081/v1/tail');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${liveToken}`);
    expect(headers.accept).toBe('text/event-stream');

    // The body is piped through unchanged.
    const text = await res.text();
    expect(text).toContain('data: {"hello":"world"}');
  });

  it('does NOT forward client filter params upstream (filtering is client-side)', async () => {
    const fetchImpl = vi.fn(async () => upstreamSse());
    await tailProxy(req(`lg_at=${liveToken}`), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'http://query:8081',
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).not.toContain('?');
  });

  it('fails closed with 401 and never calls upstream when unauthenticated', async () => {
    const fetchImpl = vi.fn();
    const res = await tailProxy(req(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      refresh: vi.fn(),
    });
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('forwards rotated session cookies after a refresh on the streaming response', async () => {
    const fetchImpl = vi.fn(async () => upstreamSse());
    const res = await tailProxy(req(`lg_at=${expiredToken}; lg_rt=rt-1`), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      refresh: vi.fn(async () => tokenPair),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('lg_at=');
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await tailProxy(req(`lg_at=${liveToken}`), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
  });

  it('maps an upstream 401 to a 401 (token raced/revoked)', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const res = await tailProxy(req(`lg_at=${liveToken}`), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(401);
  });
});
