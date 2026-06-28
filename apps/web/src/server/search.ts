import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';
import { z } from 'zod';
import type { TailLogEvent } from '../features/log-explorer/tail-event';
import {
  buildSearchParams,
  EMPTY_SEARCH_FILTERS,
  type SearchFilters,
  type SearchOutcome,
  searchResponseSchema,
} from '../features/log-search/search-query';
import { ACCESS_COOKIE } from './session';

// ── BFF → query-service historical search ───────────────────────────────────
//
// The REST sibling of the live-tail SSE proxy (tail-proxy.ts). A search is a
// same-origin RPC: the browser never holds a token, so this server-side code reads
// the httpOnly access cookie, FAILS CLOSED to /login when there is no session, and
// proxies to query-service `GET /v1/search` with `Authorization: Bearer <token>` —
// tenancy is entirely server-derived from the forwarded JWT (no client-supplied
// tenant id anywhere). The query-service base URL is read from env, server-only,
// and never bundled to the client.
//
// `searchUpstream` is the pure, dependency-injected core (mirrors tail-proxy's
// `tailProxy`): it builds the querystring via the shared `buildSearchParams`,
// parses the response with the shared contract, and maps every failure to a typed
// outcome — so the auth/transport behavior is unit-tested without the Start runtime.

function queryServiceUrl(): string {
  return process.env.QUERY_SERVICE_URL?.replace(/\/$/, '') ?? 'http://localhost:8081';
}

/** Internal outcome carrying the HTTP status so the server fn can route 401→login. */
type UpstreamOutcome =
  | { ok: true; events: TailLogEvent[]; nextCursor?: string }
  | { ok: false; status: number; message: string };

export interface SearchUpstreamDeps {
  /** fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** query-service base URL override (defaults to env / localhost:8081). */
  baseUrl?: string;
}

/**
 * Execute one page of a tenant search against query-service. Fails CLOSED with a
 * 401 outcome (and never touches the network) when there is no token. On a 400 it
 * surfaces query-service's validation message (it describes the caller's own
 * filters — safe to show); every other failure collapses to a generic message so
 * no raw upstream/connection detail reaches the browser.
 */
export async function searchUpstream(
  token: string | undefined,
  filters: SearchFilters,
  cursor: string | undefined,
  deps: SearchUpstreamDeps = {},
): Promise<UpstreamOutcome> {
  if (!token) return { ok: false, status: 401, message: 'Your session has ended.' };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? queryServiceUrl();
  const qs = buildSearchParams(filters, cursor);

  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/search?${qs.toString()}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, status: 502, message: 'Search is temporarily unavailable.' };
  }

  // Parse the body defensively: a proxy in front of query-service can return HTML
  // on a 5xx, and a 2xx must be JSON. Reading must never throw past this boundary.
  const raw = await res.text().catch(() => '');
  let body: Record<string, unknown> | undefined;
  if (raw !== '') {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        status: res.ok ? 502 : res.status,
        message: 'Search is temporarily unavailable.',
      };
    }
  }

  if (!res.ok) {
    // A 400 is a validation failure of the user's own filters — surface its message.
    if (res.status === 400) {
      const message =
        typeof body?.message === 'string' && body.message.trim() !== ''
          ? body.message
          : 'Your search filters are invalid. Please adjust them.';
      return { ok: false, status: 400, message };
    }
    if (res.status === 401) {
      return { ok: false, status: 401, message: 'Your session has ended.' };
    }
    // 5xx / unexpected: log specifics server-side, show a generic message.
    console.warn(`search upstream failed: ${res.status}`);
    return { ok: false, status: res.status, message: 'Search is temporarily unavailable.' };
  }

  try {
    const parsed = searchResponseSchema.parse(body);
    return { ok: true, events: parsed.events, nextCursor: parsed.nextCursor };
  } catch {
    // Response shape drift — fail as a generic server fault, never untyped data.
    return { ok: false, status: 502, message: 'Search is temporarily unavailable.' };
  }
}

// ── Server function: the client-callable search RPC ─────────────────────────

const levelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** Input validated at the BFF boundary (the tenant is NEVER part of it). */
const searchInputSchema = z.object({
  filters: z.object({
    text: z.string(),
    service: z.string(),
    level: z.union([levelSchema, z.literal('')]),
    labels: z.array(z.string()),
    from: z.string(),
    to: z.string(),
  }),
  cursor: z.string().optional(),
});

/**
 * Run a historical search for the authed tenant. Reads the httpOnly access token
 * server-side and REDIRECTS to /login when the session is gone (fail closed,
 * consistent with the `_authed` guard and the tail proxy). Returns a `SearchOutcome`
 * the surface renders directly — success rows or a user-safe error message.
 */
export const searchFn = createServerFn({ method: 'GET' })
  .validator(searchInputSchema)
  .handler(async ({ data }): Promise<SearchOutcome> => {
    const token = getCookie(ACCESS_COOKIE);
    if (!token) throw redirect({ to: '/login' });

    const out = await searchUpstream(token, data.filters, data.cursor);
    if (out.ok) return { ok: true, events: out.events, nextCursor: out.nextCursor };
    // A session that lapsed mid-search → bounce to login (fail closed).
    if (out.status === 401) throw redirect({ to: '/login' });
    return { ok: false, message: out.message };
  });

/** Default executor used by the surface; tests inject a mock instead. */
export function defaultSearchExecutor(
  filters: SearchFilters,
  cursor?: string,
): Promise<SearchOutcome> {
  return searchFn({ data: { filters, cursor } });
}

// Re-exported so a caller can build an "empty" search without reaching into the feature.
export { EMPTY_SEARCH_FILTERS };
