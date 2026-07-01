import { uuidSchema } from '@logalot/contracts';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';
import { z } from 'zod';
import {
  buildPanelDataParams,
  type PanelDataOutcome,
  type PanelDataParamsInput,
  type PanelDataResult,
  panelDataResponseSchema,
} from '../features/dashboards/panel-data';
import { ACCESS_COOKIE } from './session';

// ── BFF → query-service panel-data relay ─────────────────────────────────────
//
// The dashboards-panel analogue of the historical-search relay (search.ts): a
// same-origin RPC — the browser never holds a token, so this server-side code
// reads the httpOnly access cookie, FAILS CLOSED to /login when there is no
// session, and proxies to query-service `GET /v1/panel-data` with
// `Authorization: Bearer <token>` — tenancy is entirely server-derived from the
// forwarded JWT (no client-supplied tenant id anywhere). A `savedQueryId`
// belonging to another tenant is invisible to query-service (RLS) and comes back
// as a 404, which this module surfaces as a plain panel error — never a crash.
//
// `panelDataUpstream` is the pure, dependency-injected core (mirrors
// `searchUpstream`): it builds the querystring via the shared
// `buildPanelDataParams`, parses the response with the shared contract, and maps
// every failure to a typed outcome — so the auth/transport behavior is
// unit-tested without the Start runtime.

function queryServiceUrl(): string {
  return process.env.QUERY_SERVICE_URL?.replace(/\/$/, '') ?? 'http://localhost:8081';
}

/** Internal outcome carrying the HTTP status so the server fn can route 401→login. */
type UpstreamOutcome =
  | { ok: true; data: PanelDataResult }
  | { ok: false; status: number; message: string };

export interface PanelDataUpstreamDeps {
  /** fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** query-service base URL override (defaults to env / localhost:8081). */
  baseUrl?: string;
}

/**
 * Load one panel's data from query-service. Fails CLOSED with a 401 outcome
 * (and never touches the network) when there is no token. A 400 surfaces
 * query-service's own validation message (it describes the caller's own
 * params — safe to show); a 404 means the saved query is missing OR belongs to
 * another tenant (RLS-invisible) — surfaced as a plain "not found" message,
 * never a crash; every other failure collapses to a generic message so no raw
 * upstream/connection detail reaches the browser.
 */
export async function panelDataUpstream(
  token: string | undefined,
  params: PanelDataParamsInput,
  deps: PanelDataUpstreamDeps = {},
): Promise<UpstreamOutcome> {
  if (!token) return { ok: false, status: 401, message: 'Your session has ended.' };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? queryServiceUrl();
  const qs = buildPanelDataParams(params);

  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/panel-data?${qs.toString()}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, status: 502, message: 'Panel data is temporarily unavailable.' };
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
        message: 'Panel data is temporarily unavailable.',
      };
    }
  }

  if (!res.ok) {
    // A 400 is a validation failure of the panel's own params — surface its message.
    if (res.status === 400) {
      const message =
        typeof body?.message === 'string' && body.message.trim() !== ''
          ? body.message
          : 'This panel query is invalid.';
      return { ok: false, status: 400, message };
    }
    if (res.status === 401) {
      return { ok: false, status: 401, message: 'Your session has ended.' };
    }
    // Missing OR cross-tenant (RLS-invisible) saved query — same user-facing message.
    if (res.status === 404) {
      return { ok: false, status: 404, message: 'panel query not found' };
    }
    // 5xx / unexpected: log specifics server-side, show a generic message.
    console.warn(`panel-data upstream failed: ${res.status}`);
    return { ok: false, status: res.status, message: 'Panel data is temporarily unavailable.' };
  }

  try {
    const data = panelDataResponseSchema.parse(body);
    return { ok: true, data };
  } catch {
    // Response shape drift — fail as a generic server fault, never untyped data.
    return { ok: false, status: 502, message: 'Panel data is temporarily unavailable.' };
  }
}

// ── Server function: the client-callable panel-data RPC ──────────────────────

/** Input validated at the BFF boundary (the tenant is NEVER part of it). */
const panelDataInputSchema = z.object({
  savedQueryId: uuidSchema,
  from: z.string().optional(),
  to: z.string().optional(),
  buckets: z.number().int().positive().optional(),
});

/**
 * Load one panel's data for the authed tenant. Reads the httpOnly access token
 * server-side and REDIRECTS to /login when the session is gone (fail closed,
 * consistent with the `_authed` guard and the search relay). Returns a
 * `PanelDataOutcome`-shaped result the panel renders directly — the parsed
 * payload or a user-safe error message.
 */
export const loadPanelDataFn = createServerFn({ method: 'GET' })
  .validator(panelDataInputSchema)
  .handler(async ({ data }): Promise<PanelDataOutcome> => {
    const token = getCookie(ACCESS_COOKIE);
    if (!token) throw redirect({ to: '/login' });

    const out = await panelDataUpstream(token, data);
    if (out.ok) return { ok: true, data: out.data };
    // A session that lapsed mid-request → bounce to login (fail closed).
    if (out.status === 401) throw redirect({ to: '/login' });
    return { ok: false, message: out.message };
  });
