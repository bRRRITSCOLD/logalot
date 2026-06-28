import type { TokenPair } from '@logalot/contracts';
import { cpRefresh } from './control-plane';
import { ACCESS_COOKIE, decodeAccessClaims, isExpired, REFRESH_COOKIE } from './session';

// ── BFF live-tail SSE proxy ─────────────────────────────────────────────────
//
// The browser's EventSource cannot set an `Authorization` or custom `Accept`
// header, and we never want a token in client JS anyway. So the browser opens an
// EventSource against THIS same-origin route (`/api/tail`); the session cookies
// ride along automatically, and this handler:
//   1. reads the httpOnly access cookie (silently refreshing via the refresh cookie
//      if the access token is expired — same rotation as getSession), failing CLOSED
//      to 401 when there is no usable session;
//   2. opens an upstream SSE connection to query-service `GET /v1/tail` with
//      `Authorization: Bearer <token>` + `Accept: text/event-stream`;
//   3. pipes the upstream event stream straight back to the browser UNCHANGED,
//      preserving `data:` / `event: gap` / heartbeat framing.
//
// Tenancy is entirely server-derived: the tenant comes from the JWT the BFF
// forwards (query-service derives the Redis channel from it, ADR-0002/0006). There
// is no client-supplied tenant id anywhere in this path. The query-service base URL
// is read from env, server-only, and never bundled to the client.
//
// We deliberately do NOT forward filter query params upstream: the issue scopes
// service/level/label/text filtering to the client (so a filter change is instant
// and never reconnects the stream), and this keeps the proxy a dumb, auditable pipe.

const SET_COOKIE = 'set-cookie';

function queryServiceUrl(): string {
  return process.env.QUERY_SERVICE_URL?.replace(/\/$/, '') ?? 'http://localhost:8081';
}

/** Mirror of auth.ts cookie security: default ON, only plain-http local dev opts out. */
function cookieSecure(): boolean {
  const explicit = process.env.COOKIE_SECURE;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return process.env.NODE_ENV !== 'development';
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/** Build Set-Cookie header values for a rotated token pair (matches auth.ts options). */
function sessionSetCookies(pair: TokenPair): string[] {
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${
    cookieSecure() ? '; Secure' : ''
  }`;
  return [
    `${ACCESS_COOKIE}=${pair.accessToken}; ${flags}`,
    `${REFRESH_COOKIE}=${pair.refreshToken}; ${flags}`,
  ];
}

/** Parse a Cookie request header into a name→value map. */
export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export interface TailAuth {
  ok: boolean;
  token?: string;
  /** Set-Cookie values to forward when the session was rotated by a refresh. */
  setCookies: string[];
}

export interface ResolveDeps {
  /** Refresh implementation (injectable for tests); defaults to the control-plane client. */
  refresh?: (refreshToken: string) => Promise<TokenPair>;
  /** Clock override for deterministic expiry tests. */
  nowMs?: number;
}

/**
 * Resolve a usable access token from the request cookies, refreshing if the access
 * token is missing/expired. Fails CLOSED ({ ok:false }) when there is no session:
 * no access AND no refresh cookie, or a rejected refresh. The decode-only check
 * mirrors session.ts; cryptographic verification stays at query-service on the
 * proxied call (it holds the secret; the BFF does not).
 */
export async function resolveTailAuth(request: Request, deps: ResolveDeps = {}): Promise<TailAuth> {
  const refresh = deps.refresh ?? cpRefresh;
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const access = cookies[ACCESS_COOKIE];
  const claims = decodeAccessClaims(access);

  if (access && claims && !isExpired(claims, deps.nowMs)) {
    return { ok: true, token: access, setCookies: [] };
  }

  const refreshToken = cookies[REFRESH_COOKIE];
  if (!refreshToken) return { ok: false, setCookies: [] };

  try {
    const pair = await refresh(refreshToken);
    return { ok: true, token: pair.accessToken, setCookies: sessionSetCookies(pair) };
  } catch {
    return { ok: false, setCookies: [] };
  }
}

export interface TailProxyDeps extends ResolveDeps {
  /** fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** query-service base URL override (defaults to env / localhost:8081). */
  baseUrl?: string;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The `/api/tail` GET handler body. Returns a streaming `text/event-stream` Response
 * piping query-service's tail, a 401 when the session is absent/unrefreshable (fail
 * closed → the client redirects to /login), or a 502 when the upstream is
 * unreachable/erroring.
 */
export async function tailProxy(request: Request, deps: TailProxyDeps = {}): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? queryServiceUrl();

  const auth = await resolveTailAuth(request, deps);
  if (!auth.ok || !auth.token) {
    // Fail closed: no token reaches the browser, and the browser learns it must
    // re-authenticate. (The page is under the _authed guard; a 401 here means the
    // session lapsed mid-stream.)
    return jsonError(401, 'unauthorized');
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(`${base}/v1/tail`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${auth.token}`,
        accept: 'text/event-stream',
      },
      // Tie the upstream connection lifetime to the browser's: when the client
      // disconnects, this aborts and query-service tears down the Redis subscription.
      signal: request.signal,
    });
  } catch {
    return jsonError(502, 'tail_unavailable');
  }

  if (!upstream.ok || !upstream.body) {
    // Surface an upstream auth rejection as 401 (refresh raced / token revoked);
    // everything else is a bad-gateway from the BFF's perspective.
    return jsonError(upstream.status === 401 ? 401 : 502, 'tail_unavailable');
  }

  const headers = new Headers({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // don't let a proxy buffer live frames
  });
  // Forward rotated session cookies (if we refreshed) so the browser stays in sync.
  for (const cookie of auth.setCookies) headers.append(SET_COOKIE, cookie);

  return new Response(upstream.body, { status: 200, headers });
}
