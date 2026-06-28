import { type LoginRequest, type TokenPair, tokenPairSchema } from '@logalot/contracts';
import type { ZodType } from 'zod';

// BFF -> control-plane HTTP client. This is the ONLY module that talks to the
// control-plane; it runs server-side only (the base URL and tokens never reach
// the browser). Responses are parsed with the SHARED zod contracts so a backend
// shape change surfaces here as a typed failure rather than silent drift.

const baseUrl = (): string =>
  process.env.CONTROL_PLANE_URL?.replace(/\/$/, '') ?? 'http://localhost:8082';

/** Carries the control-plane's machine `error` code + HTTP status to the caller. */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

async function cpFetch(path: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  } catch {
    // Network/connection failure — control-plane unreachable.
    throw new ControlPlaneError(503, 'upstream_unreachable', 'control-plane is unreachable');
  }

  // Parse the body defensively. A healthy control-plane returns JSON, but a proxy
  // or gateway in front of it can return HTML on a 502/504, and some endpoints
  // return an empty 200. Reading/parsing must NOT throw a raw SyntaxError past
  // this boundary — every failure leaves here as a typed ControlPlaneError so
  // callers (and the login UI) only ever see our error contract.
  const raw = await res.text().catch(() => '');
  let body: Record<string, unknown> | undefined;
  if (raw) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Non-JSON body. Surface upstream's status when it already failed (e.g. a
      // proxy 502 HTML page); a 2xx with a non-JSON body is itself a 502-worthy
      // contract violation. Either way: a typed error, never a SyntaxError.
      throw new ControlPlaneError(
        res.ok ? 502 : res.status,
        'invalid_response',
        'control-plane returned a non-JSON response',
      );
    }
  }

  if (!res.ok) {
    throw new ControlPlaneError(
      res.status,
      typeof body?.error === 'string' ? body.error : 'error',
      typeof body?.message === 'string' ? body.message : res.statusText,
    );
  }
  return body;
}

export function cpLogin(body: LoginRequest): Promise<TokenPair> {
  return cpFetch('/v1/auth/login', { method: 'POST', body: JSON.stringify(body) }).then((b) =>
    tokenPairSchema.parse(b),
  );
}

export function cpRefresh(refreshToken: string): Promise<TokenPair> {
  return cpFetch('/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  }).then((b) => tokenPairSchema.parse(b));
}

export async function cpLogout(refreshToken: string): Promise<void> {
  await cpFetch('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
}

/**
 * Authenticated proxy for the rest of the control-plane API (tenants, users,
 * api-keys, alert-rules, …). Feature routes (#21-#23) call this from their
 * server-side loaders with the session's access token; a 401 means the caller
 * should refresh or redirect to login. Tenancy is enforced by the access token
 * itself — never pass a tenant id in the path/body.
 *
 * The response is validated against the supplied SHARED zod contract before it is
 * returned, so a backend shape change surfaces here as a typed `ZodError` rather
 * than flowing untyped into a page. Pass the contract schema for the endpoint
 * (e.g. `alertRuleListSchema`) — never a hand-rolled local shape.
 */
export async function cpAuthedFetch<T>(
  accessToken: string,
  path: string,
  schema: ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const body = await cpFetch(path, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
  });
  return schema.parse(body);
}

/** Mutating HTTP methods the admin BFF proxies (writes). */
export type MutationMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Authenticated WRITE proxy for the control-plane (create/update/revoke/delete).
 * The mutation analogue of `cpAuthedFetch`, mirroring it exactly: it attaches the
 * session's access token as a Bearer (tenancy is enforced by the token — NEVER
 * pass a tenant id in the path/body), serializes the JSON request body, and
 * zod-parses the response against the SHARED contract so a backend shape change
 * surfaces as a typed failure rather than untyped data flowing into a page.
 *
 * A non-2xx upstream becomes a typed `ControlPlaneError` (carrying status + code)
 * so callers can route 401 → re-auth and surface 403 (RBAC denial) cleanly. A 204
 * (revoke/delete) yields an empty body — pass `z.void()`/`z.undefined()` (or an
 * `.optional()` schema) for those endpoints.
 */
export async function cpAuthedSend<T>(
  accessToken: string,
  method: MutationMethod,
  path: string,
  schema: ZodType<T>,
  body?: unknown,
): Promise<T> {
  const responseBody = await cpFetch(path, {
    method,
    headers: { authorization: `Bearer ${accessToken}` },
    // GET/HEAD aside, only attach a body when one is provided (DELETE usually has none).
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return schema.parse(responseBody);
}
