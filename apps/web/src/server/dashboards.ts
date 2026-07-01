import {
  type CreateDashboardRequest,
  createDashboardRequestSchema,
  type DashboardResponse,
  dashboardResponseSchema,
  type SavedQueryResponse,
  savedQueryResponseSchema,
  type UpdateDashboardRequest,
  updateDashboardRequestSchema,
  uuidSchema,
} from '@logalot/contracts';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';
import { z } from 'zod';
import { ControlPlaneError, cpAuthedFetch, cpAuthedSend } from './control-plane';
import { ACCESS_COOKIE } from './session';

// ── BFF → control-plane: dashboards CRUD + saved-queries list ────────────────
//
// The dashboards analogue of the admin BFF (admin.ts): the browser never holds a
// token, so this server-side code reads the httpOnly access cookie, FAILS CLOSED
// when there is no session, and proxies to the control-plane with the session JWT
// as a Bearer (cpAuthedFetch / cpAuthedSend). Tenancy is ALWAYS server-derived from
// the forwarded token — no client-supplied tenant id anywhere in these calls.
//
// The control-plane is the sole RBAC authority and re-checks every operation (see
// `dashboard:create|list|read|update|delete` gates in routes.ts); this module does
// not mirror those permission checks — it simply relays and maps whatever the
// control-plane decides to a clean outcome.

// ── Outcome contract (mirrors admin.ts AdminOutcome) ─────────────────────────

export type DashboardErrorKind = 'unauthorized' | 'forbidden' | 'invalid' | 'unavailable';

export interface DashboardError {
  kind: DashboardErrorKind;
  /** A user-safe message; never carries raw upstream/connection/stack detail. */
  message: string;
}

export type DashboardOutcome<T> = { ok: true; data: T } | { ok: false; error: DashboardError };

/**
 * Map an upstream failure to a user-safe outcome. A 401 means the session lapsed
 * (caller redirects to /login); a 403 is an RBAC denial; other 4xx describe the
 * caller's OWN request and are safe to surface; everything else collapses to a
 * generic message with detail kept in the server logs only. Mirrors mapAdminError.
 */
export function mapDashboardError(err: unknown): DashboardError {
  if (err instanceof ControlPlaneError) {
    if (err.status === 401) return { kind: 'unauthorized', message: 'Your session has ended.' };
    if (err.status === 403) {
      return { kind: 'forbidden', message: 'You do not have permission to do that.' };
    }
    if (err.status >= 400 && err.status < 500) {
      return { kind: 'invalid', message: err.message || 'That request was invalid.' };
    }
    console.warn(`dashboards upstream failed: ${err.status} ${err.code}`);
    return { kind: 'unavailable', message: 'Something went wrong. Please try again.' };
  }
  // ZodError (response-shape drift) or anything unexpected: never leak it.
  console.warn('dashboards upstream error:', err instanceof Error ? err.name : typeof err);
  return { kind: 'unavailable', message: 'Something went wrong. Please try again.' };
}

/**
 * Run an authenticated control-plane call, FAILING CLOSED (without touching the
 * network) when there is no token, and mapping any failure to a safe outcome.
 */
async function run<T>(
  token: string | undefined,
  call: (t: string) => Promise<T>,
): Promise<DashboardOutcome<T>> {
  if (!token) {
    return { ok: false, error: { kind: 'unauthorized', message: 'Your session has ended.' } };
  }
  try {
    return { ok: true, data: await call(token) };
  } catch (err) {
    return { ok: false, error: mapDashboardError(err) };
  }
}

// Response envelopes (list endpoints wrap their array). Built from SHARED contracts.
const dashboardListSchema = z.object({ dashboards: z.array(dashboardResponseSchema) });
const savedQueryListSchema = z.object({ savedQueries: z.array(savedQueryResponseSchema) });
// 204 No Content (delete) — the proxy returns an empty body.
const noContentSchema = z.undefined();

// ── Upstream functions (pure given a token; unit-tested via stubbed fetch) ────

export function listDashboardsUpstream(
  token: string | undefined,
): Promise<DashboardOutcome<DashboardResponse[]>> {
  return run(token, async (t) => {
    const { dashboards } = await cpAuthedFetch(t, '/v1/dashboards', dashboardListSchema);
    return dashboards;
  });
}

export function getDashboardUpstream(
  token: string | undefined,
  id: string,
): Promise<DashboardOutcome<DashboardResponse>> {
  return run(token, (t) => cpAuthedFetch(t, `/v1/dashboards/${id}`, dashboardResponseSchema));
}

export function createDashboardUpstream(
  token: string | undefined,
  body: CreateDashboardRequest,
): Promise<DashboardOutcome<DashboardResponse>> {
  return run(token, (t) =>
    cpAuthedSend(t, 'POST', '/v1/dashboards', dashboardResponseSchema, body),
  );
}

export function updateDashboardUpstream(
  token: string | undefined,
  id: string,
  body: UpdateDashboardRequest,
): Promise<DashboardOutcome<DashboardResponse>> {
  return run(token, (t) =>
    cpAuthedSend(t, 'PATCH', `/v1/dashboards/${id}`, dashboardResponseSchema, body),
  );
}

export function deleteDashboardUpstream(
  token: string | undefined,
  id: string,
): Promise<DashboardOutcome<void>> {
  return run(token, async (t) => {
    await cpAuthedSend(t, 'DELETE', `/v1/dashboards/${id}`, noContentSchema);
  });
}

// Tenancy for /v1/saved-queries is carried by the Bearer token ONLY — no tenant
// id is ever sent in the path or body (mirrors the dashboards relay above).

export function listSavedQueriesUpstream(
  token: string | undefined,
): Promise<DashboardOutcome<SavedQueryResponse[]>> {
  return run(token, async (t) => {
    const { savedQueries } = await cpAuthedFetch(t, '/v1/saved-queries', savedQueryListSchema);
    return savedQueries;
  });
}

// ── Server functions (client-callable RPC; the thin createServerFn wrappers) ──
//
// Each reads the httpOnly token, REDIRECTS to /login when the session is gone or an
// upstream 401 lands (fail closed, consistent with the _authed guard), and returns
// a DashboardOutcome the UI renders directly.

/** Redirect to /login on a lapsed session; otherwise pass the outcome through. */
function ensureSession<T>(out: DashboardOutcome<T>): DashboardOutcome<T> {
  if (!out.ok && out.error.kind === 'unauthorized') throw redirect({ to: '/login' });
  return out;
}

const idInput = z.object({ id: uuidSchema });

// `strict: { output: false }` opts these five fns out of TanStack Start's
// compile-time "is the return value serializable" check. It is a type-level-only
// escape hatch (no runtime behavior change): `layout.panels[].viz` and
// `savedQuery.timeRange` are intentionally-loose `Record<string, unknown>` shapes
// (dashboard.ts / savedQuery.ts) and `unknown` can never structurally satisfy the
// serializer's mapped-type check, even though the actual values (plain JSON from
// the control-plane) serialize just fine over the wire.

export const loadDashboardsFn = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(
  async (): Promise<DashboardOutcome<DashboardResponse[]>> =>
    ensureSession(await listDashboardsUpstream(getCookie(ACCESS_COOKIE))),
);

export const loadDashboardFn = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(idInput)
  .handler(
    async ({ data }): Promise<DashboardOutcome<DashboardResponse>> =>
      ensureSession(await getDashboardUpstream(getCookie(ACCESS_COOKIE), data.id)),
  );

export const createDashboardFn = createServerFn({ method: 'POST', strict: { output: false } })
  .validator(createDashboardRequestSchema)
  .handler(
    async ({ data }): Promise<DashboardOutcome<DashboardResponse>> =>
      ensureSession(await createDashboardUpstream(getCookie(ACCESS_COOKIE), data)),
  );

export const updateDashboardFn = createServerFn({ method: 'POST', strict: { output: false } })
  .validator(z.object({ id: uuidSchema, patch: updateDashboardRequestSchema }))
  .handler(
    async ({ data }): Promise<DashboardOutcome<DashboardResponse>> =>
      ensureSession(await updateDashboardUpstream(getCookie(ACCESS_COOKIE), data.id, data.patch)),
  );

export const deleteDashboardFn = createServerFn({ method: 'POST' })
  .validator(idInput)
  .handler(
    async ({ data }): Promise<DashboardOutcome<void>> =>
      ensureSession(await deleteDashboardUpstream(getCookie(ACCESS_COOKIE), data.id)),
  );

export const loadSavedQueriesFn = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(
  async (): Promise<DashboardOutcome<SavedQueryResponse[]>> =>
    ensureSession(await listSavedQueriesUpstream(getCookie(ACCESS_COOKIE))),
);
