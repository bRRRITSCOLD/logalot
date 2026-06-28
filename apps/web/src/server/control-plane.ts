import { type LoginRequest, type TokenPair, tokenPairSchema } from '@logalot/contracts';

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
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
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
 */
export async function cpAuthedFetch<T = unknown>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return cpFetch(path, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
  }) as Promise<T>;
}
