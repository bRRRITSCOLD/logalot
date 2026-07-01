import {
  type AlertRuleResponse,
  type ApiKeyCreatedResponse,
  type ApiKeyResponse,
  alertRuleResponseSchema,
  apiKeyCreatedResponseSchema,
  apiKeyResponseSchema,
  type CreateAlertRuleRequest,
  type CreateApiKeyRequest,
  type CreateInviteRequest,
  type CreateUserRequest,
  can,
  createAlertRuleRequestSchema,
  createApiKeyRequestSchema,
  createInviteRequestSchema,
  createUserRequestSchema,
  type InviteCreatedResponse,
  type InviteResponse,
  inviteCreatedResponseSchema,
  inviteListSchema,
  type RetentionResponse,
  type Role,
  retentionResponseSchema,
  type TenantResponse,
  tenantResponseSchema,
  type UpdateAlertRuleRequest,
  type UpdateUserRequest,
  type UpsertRetentionRequest,
  type UserResponse,
  updateAlertRuleRequestSchema,
  updateUserRequestSchema,
  upsertRetentionRequestSchema,
  userResponseSchema,
  uuidSchema,
} from '@logalot/contracts';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';
import { z } from 'zod';
import { ControlPlaneError, cpAuthedFetch, cpAuthedSend } from './control-plane';
import { ACCESS_COOKIE, decodeAccessClaims } from './session';

// ── BFF → control-plane: alert + tenant/key/user/retention admin ─────────────
//
// The admin/alerting analogue of the search BFF (search.ts): the browser never
// holds a token, so this server-side code reads the httpOnly access cookie, FAILS
// CLOSED when there is no session, and proxies to the control-plane with the
// session JWT as a Bearer (cpAuthedFetch / cpAuthedSend). Tenancy is ALWAYS
// server-derived from the forwarded token — no client-supplied tenant id anywhere;
// the tenant path param for `/v1/tenants/:id` is read from the token's OWN claims.
//
// The control-plane is the sole RBAC authority and re-checks every operation; this
// module mirrors permission gates only to AVOID sending data a role can't see (so a
// member never receives users/keys) and to surface a 403 as a clean outcome. A
// forged client role still gets a server 403.

// ── Outcome contract (mirrors search.ts SearchOutcome) ───────────────────────

export type AdminErrorKind = 'unauthorized' | 'forbidden' | 'invalid' | 'unavailable';

export interface AdminError {
  kind: AdminErrorKind;
  /** A user-safe message; never carries raw upstream/connection/stack detail. */
  message: string;
}

export type AdminOutcome<T> = { ok: true; data: T } | { ok: false; error: AdminError };

/**
 * Map an upstream failure to a user-safe outcome. A 401 means the session lapsed
 * (caller redirects to /login); a 403 is an RBAC denial; other 4xx describe the
 * caller's OWN request and are safe to surface; everything else collapses to a
 * generic message with detail kept in the server logs only.
 */
export function mapAdminError(err: unknown): AdminError {
  if (err instanceof ControlPlaneError) {
    if (err.status === 401) return { kind: 'unauthorized', message: 'Your session has ended.' };
    if (err.status === 403) {
      return { kind: 'forbidden', message: 'You do not have permission to do that.' };
    }
    if (err.status >= 400 && err.status < 500) {
      // Validation / conflict (e.g. "email already exists", bad threshold). The
      // control-plane authors these messages for API clients — safe to display.
      return { kind: 'invalid', message: err.message || 'That request was invalid.' };
    }
    console.warn(`admin upstream failed: ${err.status} ${err.code}`);
    return { kind: 'unavailable', message: 'Something went wrong. Please try again.' };
  }
  // ZodError (response-shape drift) or anything unexpected: never leak it.
  console.warn('admin upstream error:', err instanceof Error ? err.name : typeof err);
  return { kind: 'unavailable', message: 'Something went wrong. Please try again.' };
}

/**
 * Run an authenticated control-plane call, FAILING CLOSED (without touching the
 * network) when there is no token, and mapping any failure to a safe outcome.
 */
async function run<T>(
  token: string | undefined,
  call: (t: string) => Promise<T>,
): Promise<AdminOutcome<T>> {
  if (!token) {
    return { ok: false, error: { kind: 'unauthorized', message: 'Your session has ended.' } };
  }
  try {
    return { ok: true, data: await call(token) };
  } catch (err) {
    return { ok: false, error: mapAdminError(err) };
  }
}

// Response envelopes (list endpoints wrap their array). Built from SHARED contracts.
const alertRuleListSchema = z.object({ alertRules: z.array(alertRuleResponseSchema) });
const apiKeyListSchema = z.object({ apiKeys: z.array(apiKeyResponseSchema) });
const userListSchema = z.object({ users: z.array(userResponseSchema) });
// invites use the shared inviteListSchema ({ invites: [...] }) directly.
// 204 No Content (revoke/delete) — the proxy returns an empty body.
const noContentSchema = z.undefined();

// ── Upstream functions (pure given a token; unit-tested via stubbed fetch) ────

export function listAlertRulesUpstream(
  token: string | undefined,
): Promise<AdminOutcome<AlertRuleResponse[]>> {
  return run(token, async (t) => {
    const { alertRules } = await cpAuthedFetch(t, '/v1/alert-rules', alertRuleListSchema);
    return alertRules;
  });
}

export function createAlertRuleUpstream(
  token: string | undefined,
  body: CreateAlertRuleRequest,
): Promise<AdminOutcome<AlertRuleResponse>> {
  return run(token, (t) =>
    cpAuthedSend(t, 'POST', '/v1/alert-rules', alertRuleResponseSchema, body),
  );
}

export function updateAlertRuleUpstream(
  token: string | undefined,
  id: string,
  body: UpdateAlertRuleRequest,
): Promise<AdminOutcome<AlertRuleResponse>> {
  return run(token, (t) =>
    cpAuthedSend(t, 'PATCH', `/v1/alert-rules/${id}`, alertRuleResponseSchema, body),
  );
}

export function deleteAlertRuleUpstream(
  token: string | undefined,
  id: string,
): Promise<AdminOutcome<void>> {
  return run(token, async (t) => {
    await cpAuthedSend(t, 'DELETE', `/v1/alert-rules/${id}`, noContentSchema);
  });
}

export function listApiKeysUpstream(
  token: string | undefined,
): Promise<AdminOutcome<ApiKeyResponse[]>> {
  return run(token, async (t) => {
    const { apiKeys } = await cpAuthedFetch(t, '/v1/api-keys', apiKeyListSchema);
    return apiKeys;
  });
}

export function createApiKeyUpstream(
  token: string | undefined,
  body: CreateApiKeyRequest,
): Promise<AdminOutcome<ApiKeyCreatedResponse>> {
  // The response carries the one-time `plaintext` secret. It is returned to the
  // server fn and the modal, shown once, and NEVER persisted or logged here.
  return run(token, (t) =>
    cpAuthedSend(t, 'POST', '/v1/api-keys', apiKeyCreatedResponseSchema, body),
  );
}

export function revokeApiKeyUpstream(
  token: string | undefined,
  id: string,
): Promise<AdminOutcome<void>> {
  return run(token, async (t) => {
    await cpAuthedSend(t, 'DELETE', `/v1/api-keys/${id}`, noContentSchema);
  });
}

// Tenancy for /v1/invites is carried by the Bearer token ONLY — no tenant id
// is ever sent in the path or body (mirrors the api-key/user relays above and
// the PR #139 convention: provider/admin paths + tenant-in-token).

export function listInvitesUpstream(
  token: string | undefined,
): Promise<AdminOutcome<InviteResponse[]>> {
  return run(token, async (t) => {
    const { invites } = await cpAuthedFetch(t, '/v1/invites', inviteListSchema);
    return invites;
  });
}

export function createInviteUpstream(
  token: string | undefined,
  body: CreateInviteRequest,
): Promise<AdminOutcome<InviteCreatedResponse>> {
  // The response carries the one-time `inviteUrl` (embeds the plaintext token).
  // It is returned to the server fn / UI for a single display and NEVER logged
  // here (R-INV-12).
  return run(token, (t) =>
    cpAuthedSend(t, 'POST', '/v1/invites', inviteCreatedResponseSchema, body),
  );
}

export function revokeInviteUpstream(
  token: string | undefined,
  id: string,
): Promise<AdminOutcome<void>> {
  return run(token, async (t) => {
    await cpAuthedSend(t, 'POST', `/v1/invites/${id}/revoke`, noContentSchema);
  });
}

export function listUsersUpstream(
  token: string | undefined,
): Promise<AdminOutcome<UserResponse[]>> {
  return run(token, async (t) => {
    const { users } = await cpAuthedFetch(t, '/v1/users', userListSchema);
    return users;
  });
}

export function createUserUpstream(
  token: string | undefined,
  body: CreateUserRequest,
): Promise<AdminOutcome<UserResponse>> {
  return run(token, (t) => cpAuthedSend(t, 'POST', '/v1/users', userResponseSchema, body));
}

export function updateUserUpstream(
  token: string | undefined,
  id: string,
  body: UpdateUserRequest,
): Promise<AdminOutcome<UserResponse>> {
  return run(token, (t) => cpAuthedSend(t, 'PATCH', `/v1/users/${id}`, userResponseSchema, body));
}

export function deleteUserUpstream(
  token: string | undefined,
  id: string,
): Promise<AdminOutcome<void>> {
  return run(token, async (t) => {
    await cpAuthedSend(t, 'DELETE', `/v1/users/${id}`, noContentSchema);
  });
}

export function getTenantUpstream(
  token: string | undefined,
  tenantId: string,
): Promise<AdminOutcome<TenantResponse>> {
  return run(token, (t) => cpAuthedFetch(t, `/v1/tenants/${tenantId}`, tenantResponseSchema));
}

/**
 * Read the tenant's retention policy. A 404 means "not configured yet" — a normal,
 * non-error state a tenant_admin can resolve by setting one, so it maps to a
 * successful outcome carrying `null` rather than an error.
 */
export function getRetentionUpstream(
  token: string | undefined,
): Promise<AdminOutcome<RetentionResponse | null>> {
  return run(token, async (t) => {
    try {
      return await cpAuthedFetch(t, '/v1/retention', retentionResponseSchema);
    } catch (err) {
      if (err instanceof ControlPlaneError && err.status === 404) return null;
      throw err;
    }
  });
}

export function updateRetentionUpstream(
  token: string | undefined,
  body: UpsertRetentionRequest,
): Promise<AdminOutcome<RetentionResponse>> {
  return run(token, (t) => cpAuthedSend(t, 'PUT', '/v1/retention', retentionResponseSchema, body));
}

// ── Composite admin-page load (role-gated server-side) ───────────────────────

export interface AdminData {
  /** Authoritative role decoded from the token's claims (NOT client-supplied). */
  role: Role;
  tenant: AdminOutcome<TenantResponse>;
  retention: AdminOutcome<RetentionResponse | null>;
  /** null ⇒ the role may not list users, so they were NEVER fetched (server-gated). */
  users: AdminOutcome<UserResponse[]> | null;
  /** null ⇒ the role may not list api keys, so they were NEVER fetched (server-gated). */
  apiKeys: AdminOutcome<ApiKeyResponse[]> | null;
  /** null ⇒ the role may not list invites, so they were NEVER fetched (server-gated). */
  invites: AdminOutcome<InviteResponse[]> | null;
}

/**
 * Load everything the admin page needs in one server round-trip, skipping the
 * privileged fetches (users, api keys) for a role that can't read them. A member's
 * browser therefore never receives user/key data at all — the gate is server-side,
 * not a client-side hide. Returns `null` when there is no valid session so the
 * server fn can fail closed to /login.
 */
export async function loadAdminData(token: string | undefined): Promise<AdminData | null> {
  const claims = decodeAccessClaims(token);
  if (!token || !claims) return null;
  const role = claims.role;
  const tenantId = claims.tenant_id; // server-derived; never from client input

  // The `can(role, …)` checks below are NOT an authorization decision and do not
  // contradict the "no auth decision rests on the mirror" rule in contracts/rbac.ts:
  // the control-plane's 403 remains the SOLE authority (a wrong check or forged role
  // still gets denied upstream). They are used here purely as a request-avoidance /
  // data-minimization optimization — don't issue a fetch the server would 403, and
  // don't ship that data to a client that shouldn't see it. A future reader should
  // neither trust this as a security control nor "fix" it by removing it.
  const [tenant, retention, users, apiKeys, invites] = await Promise.all([
    getTenantUpstream(token, tenantId),
    getRetentionUpstream(token),
    can(role, 'user:list') ? listUsersUpstream(token) : Promise.resolve(null),
    can(role, 'apikey:list') ? listApiKeysUpstream(token) : Promise.resolve(null),
    can(role, 'invite:list') ? listInvitesUpstream(token) : Promise.resolve(null),
  ]);

  return { role, tenant, retention, users, apiKeys, invites };
}

// ── Server functions (client-callable RPC; the thin createServerFn wrappers) ──
//
// Each reads the httpOnly token, REDIRECTS to /login when the session is gone or an
// upstream 401 lands (fail closed, consistent with the _authed guard), and returns
// an AdminOutcome the UI renders directly.

/** Redirect to /login on a lapsed session; otherwise pass the outcome through. */
function ensureSession<T>(out: AdminOutcome<T>): AdminOutcome<T> {
  if (!out.ok && out.error.kind === 'unauthorized') throw redirect({ to: '/login' });
  return out;
}

const idInput = z.object({ id: uuidSchema });
const apiKeyIdInput = z.object({ id: z.string().min(1) });

export const loadAlertRulesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminOutcome<AlertRuleResponse[]>> =>
    ensureSession(await listAlertRulesUpstream(getCookie(ACCESS_COOKIE))),
);

export const createAlertRuleFn = createServerFn({ method: 'POST' })
  .validator(createAlertRuleRequestSchema)
  .handler(
    async ({ data }): Promise<AdminOutcome<AlertRuleResponse>> =>
      ensureSession(await createAlertRuleUpstream(getCookie(ACCESS_COOKIE), data)),
  );

export const updateAlertRuleFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: uuidSchema, patch: updateAlertRuleRequestSchema }))
  .handler(
    async ({ data }): Promise<AdminOutcome<AlertRuleResponse>> =>
      ensureSession(await updateAlertRuleUpstream(getCookie(ACCESS_COOKIE), data.id, data.patch)),
  );

export const deleteAlertRuleFn = createServerFn({ method: 'POST' })
  .validator(idInput)
  .handler(
    async ({ data }): Promise<AdminOutcome<void>> =>
      ensureSession(await deleteAlertRuleUpstream(getCookie(ACCESS_COOKIE), data.id)),
  );

export const loadAdminFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminData> => {
    const data = await loadAdminData(getCookie(ACCESS_COOKIE));
    if (!data) throw redirect({ to: '/login' });
    return data;
  },
);

export const createApiKeyFn = createServerFn({ method: 'POST' })
  .validator(createApiKeyRequestSchema)
  .handler(
    async ({ data }): Promise<AdminOutcome<ApiKeyCreatedResponse>> =>
      ensureSession(await createApiKeyUpstream(getCookie(ACCESS_COOKIE), data)),
  );

export const revokeApiKeyFn = createServerFn({ method: 'POST' })
  .validator(apiKeyIdInput)
  .handler(
    async ({ data }): Promise<AdminOutcome<void>> =>
      ensureSession(await revokeApiKeyUpstream(getCookie(ACCESS_COOKIE), data.id)),
  );

export const cpListInvites = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminOutcome<InviteResponse[]>> =>
    ensureSession(await listInvitesUpstream(getCookie(ACCESS_COOKIE))),
);

export const cpCreateInvite = createServerFn({ method: 'POST' })
  .validator(createInviteRequestSchema)
  .handler(
    async ({ data }): Promise<AdminOutcome<InviteCreatedResponse>> =>
      ensureSession(await createInviteUpstream(getCookie(ACCESS_COOKIE), data)),
  );

export const cpRevokeInvite = createServerFn({ method: 'POST' })
  .validator(idInput)
  .handler(
    async ({ data }): Promise<AdminOutcome<void>> =>
      ensureSession(await revokeInviteUpstream(getCookie(ACCESS_COOKIE), data.id)),
  );

export const createUserFn = createServerFn({ method: 'POST' })
  .validator(createUserRequestSchema)
  .handler(
    async ({ data }): Promise<AdminOutcome<UserResponse>> =>
      ensureSession(await createUserUpstream(getCookie(ACCESS_COOKIE), data)),
  );

export const updateUserFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: uuidSchema, patch: updateUserRequestSchema }))
  .handler(
    async ({ data }): Promise<AdminOutcome<UserResponse>> =>
      ensureSession(await updateUserUpstream(getCookie(ACCESS_COOKIE), data.id, data.patch)),
  );

export const deleteUserFn = createServerFn({ method: 'POST' })
  .validator(idInput)
  .handler(
    async ({ data }): Promise<AdminOutcome<void>> =>
      ensureSession(await deleteUserUpstream(getCookie(ACCESS_COOKIE), data.id)),
  );

export const updateRetentionFn = createServerFn({ method: 'POST' })
  .validator(upsertRetentionRequestSchema)
  .handler(
    async ({ data }): Promise<AdminOutcome<RetentionResponse>> =>
      ensureSession(await updateRetentionUpstream(getCookie(ACCESS_COOKIE), data)),
  );
