import {
  createAlertRuleRequestSchema,
  createApiKeyRequestSchema,
  createDashboardRequestSchema,
  createInviteRequestSchema,
  createSavedQueryRequestSchema,
  createTenantRequestSchema,
  createUserRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  oidcAuthorizeRequestSchema,
  oidcCallbackRequestSchema,
  refreshRequestSchema,
  updateAlertRuleRequestSchema,
  updateDashboardRequestSchema,
  updateSavedQueryRequestSchema,
  updateTenantRequestSchema,
  updateUserRequestSchema,
  upsertRetentionRequestSchema,
  uuidSchema,
} from '@logalot/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OidcAuthenticator } from '../../app/oidc-authenticator';
import type { TokenService } from '../../app/ports';
import type { Services } from '../../container';
import { parseInviteToken } from '../../domain/invite';
import { piiHash } from '../../domain/pii-log';
import { sha256 } from '../../domain/secret-hash';
import { makeAuthenticate, requireTenantContext } from './auth-plugin';
import { makeRequireOperation } from './rbac-guard';
import { parse } from './validation';

// Path-param schemas are a transport concern (not shared DTOs), so they live here.
// `:id` is a UUID for tenants/users, but an opaque key id for api-keys. Use the
// shared permissive `uuidSchema` (8-4-4-4-12 hex) — NOT Zod's `z.string().uuid()`,
// which enforces an RFC-4122 version nibble and so rejects the structured/all-zero
// ids the dev seeds and Postgres' `uuid` type accept (see contracts/ids.ts).
const uuidParamSchema = z.object({ id: uuidSchema });
const apiKeyIdParamSchema = z.object({ id: z.string().min(1) });

// Bootstrap-admin provisioning body. Not part of @logalot/contracts' strict
// createTenant (which is tenant-only); this is a dedicated operator provisioning
// endpoint, so its schema is local.
const provisionAdminSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(8).max(200),
    displayName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface RouteDeps {
  services: Services;
  tokenService: TokenService;
  oidcAuthenticator: OidcAuthenticator;
  // Readiness probe: resolves true when the datastore is reachable.
  ping: () => Promise<boolean>;
  // Per-IP rate-limit ceiling for OIDC routes (authorize + callback).
  // Passed through from BuildServerOptions; defaults applied there.
  oidcRateLimitMax?: number;
  oidcRateLimitWindowMs?: number;
}

// registerRoutes wires every endpoint. Validation uses the SHARED zod contracts
// (@logalot/contracts) — the same schemas the frontend uses, so request shapes can
// never drift. Protected routes carry two preHandlers: authenticate (verify JWT →
// TenantContext) then requireOperation (edge RBAC). The application services
// re-assert RBAC and arm RLS independently underneath (defense in depth).
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { services, tokenService, oidcAuthenticator, ping } = deps;
  const authenticate = makeAuthenticate(tokenService);

  // Per-IP rate-limit config applied to both OIDC routes (authorize + callback).
  // Falls back to the conservative defaults documented in env.ts.
  // The ceiling is intentionally low: each callback triggers an outbound Google
  // token exchange, so abusive burst traffic must be shed before it leaves our
  // network (R11, R12).
  const oidcRateLimit = {
    max: deps.oidcRateLimitMax ?? 20,
    timeWindow: deps.oidcRateLimitWindowMs ?? 60_000,
  };

  // ── Health / readiness (public) ──────────────────────────────────────────
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ready = await ping().catch(() => false);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });

  // ── OIDC / OAuth (public) ────────────────────────────────────────────────
  // POST /v1/auth/oidc/google/authorize — initiate the Google OIDC flow.
  // Returns a redirectUrl the client must navigate the browser to.
  // Body: { tenantSlug, returnTo? } (oidcAuthorizeRequestSchema).
  //
  // Rate-limited per-IP: beginAuthorize stores a state record in Redis, which
  // is cheap, but protects the state-store from flood.
  app.post(
    '/v1/auth/oidc/google/authorize',
    { config: { rateLimit: oidcRateLimit } },
    async (req, reply) => {
      const body = parse(oidcAuthorizeRequestSchema, req.body);
      req.log.info({ tenantSlug: body.tenantSlug }, 'oidc authorize initiated');
      const result = await oidcAuthenticator.beginAuthorize({
        tenantSlug: body.tenantSlug,
        returnTo: body.returnTo,
      });
      return reply.code(200).send(result);
    },
  );

  // POST /v1/auth/oidc/google/callback — consume IdP callback, complete the
  // OIDC flow, and return a session.
  // Body: { code, state } (oidcCallbackRequestSchema).
  // The `tenantSlug` is included in the body (not the path) because the BFF
  // relays it from the original authorize request; the route is registered as
  // a public endpoint (no preHandler auth).
  //
  // Rate-limited per-IP (tightest ceiling in the API): each call triggers an
  // outbound Google token-exchange + JWKS verification.  The OidcAuthenticator
  // already guards: bad/expired/replayed state → 401 BEFORE any Google call
  // (R11).  Rate-limiting adds the outer defence so a burst of calls with
  // valid-looking state tokens is shed at the HTTP layer.
  //
  // Logging invariant: raw `code`, `id_token`, and `client_secret` MUST NOT
  // appear in logs.  `sub` and `email` are logged only as piiHash() digests.
  app.post(
    '/v1/auth/oidc/google/callback',
    { config: { rateLimit: oidcRateLimit } },
    async (req, reply) => {
      const body = parse(oidcCallbackRequestSchema, req.body);
      // Log the request BEFORE the outbound Google call, with no secret fields.
      // body.code, body.state, and body.inviteToken are NOT logged; stateHash
      // lets us correlate without exposing the anti-CSRF token. inviteToken is
      // NEVER logged — not even a piiHash of it (ADR-0012, R-INV-12).
      req.log.info({ stateHash: piiHash(body.state) }, 'oidc callback received');
      // Hash the invite token's SECRET component at the route layer — the app
      // core never sees the plaintext (ADR-0012). The wire token is
      // `lginv_<tenantPublicId>_<secret>` (domain/invite.ts); only the secret
      // is what invites.token_hash stores (hashInviteSecret in InviteService),
      // so we must parse the token and hash JUST the secret, not the whole
      // string, or every accept would 401 (mismatched hash). hashInviteSecret
      // is byte-identical to sha256() (both raw 32-byte SHA-256 digests) —
      // reused via secret-hash.ts's sha256, matching the bytea token_hash
      // column (migration 000018, R-INV-9). A malformed token fails parsing
      // and falls through to the uniform no-provisioned-account 401 (R-INV-6).
      let inviteTokenHash: Buffer | undefined;
      if (body.inviteToken) {
        try {
          inviteTokenHash = sha256(parseInviteToken(body.inviteToken).secret);
        } catch {
          inviteTokenHash = undefined;
        }
      }
      const result = await oidcAuthenticator.handleCallback({
        code: body.code,
        state: body.state,
        inviteTokenHash,
      });
      // Log success with hashed sub — no PII in structured logs.
      req.log.info(
        { subHash: piiHash(result.tokens.userId), tenantId: result.tokens.tenantId },
        'oidc callback success',
      );
      // Return session tokens plus returnTo so the client can redirect.
      return reply.code(200).send({ ...result.tokens, returnTo: result.returnTo });
    },
  );

  // ── Auth (public) ────────────────────────────────────────────────────────
  app.post('/v1/auth/login', async (req, reply) => {
    const body = parse(loginRequestSchema, req.body);
    return reply.code(200).send(await services.auth.login(body));
  });

  app.post('/v1/auth/refresh', async (req, reply) => {
    const body = parse(refreshRequestSchema, req.body);
    return reply.code(200).send(await services.auth.refresh(body.refreshToken));
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const body = parse(logoutRequestSchema, req.body);
    await services.auth.logout(body.refreshToken);
    return reply.code(204).send();
  });

  // ── Tenants (platform_operator) ──────────────────────────────────────────
  app.post(
    '/v1/tenants',
    { preHandler: [authenticate, makeRequireOperation('tenant:create')] },
    async (req, reply) => {
      const body = parse(createTenantRequestSchema, req.body);
      const tenant = await services.tenants.create(requireTenantContext(req), body);
      return reply.code(201).send(tenant);
    },
  );

  app.get(
    '/v1/tenants',
    { preHandler: [authenticate, makeRequireOperation('tenant:list')] },
    async (req) => ({ tenants: await services.tenants.list(requireTenantContext(req)) }),
  );

  app.get(
    '/v1/tenants/:id',
    { preHandler: [authenticate, makeRequireOperation('tenant:read')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      return services.tenants.get(requireTenantContext(req), id);
    },
  );

  app.patch(
    '/v1/tenants/:id',
    { preHandler: [authenticate, makeRequireOperation('tenant:update')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      const body = parse(updateTenantRequestSchema, req.body);
      return services.tenants.update(requireTenantContext(req), id, body);
    },
  );

  app.delete(
    '/v1/tenants/:id',
    { preHandler: [authenticate, makeRequireOperation('tenant:delete')] },
    async (req, reply) => {
      const { id } = parse(uuidParamSchema, req.params);
      await services.tenants.remove(requireTenantContext(req), id);
      return reply.code(204).send();
    },
  );

  // Bootstrap a tenant's FIRST admin (platform_operator only).
  app.post(
    '/v1/tenants/:id/admin',
    { preHandler: [authenticate, makeRequireOperation('tenant:provision_admin')] },
    async (req, reply) => {
      const { id } = parse(uuidParamSchema, req.params);
      const body = parse(provisionAdminSchema, req.body);
      const user = await services.tenants.provisionAdmin(requireTenantContext(req), id, body);
      return reply.code(201).send(user);
    },
  );

  // ── Users + memberships (tenant_admin) ───────────────────────────────────
  app.post(
    '/v1/users',
    { preHandler: [authenticate, makeRequireOperation('user:create')] },
    async (req, reply) => {
      const body = parse(createUserRequestSchema, req.body);
      const user = await services.users.create(requireTenantContext(req), body);
      return reply.code(201).send(user);
    },
  );

  app.get(
    '/v1/users',
    { preHandler: [authenticate, makeRequireOperation('user:list')] },
    async (req) => ({ users: await services.users.list(requireTenantContext(req)) }),
  );

  app.get(
    '/v1/users/:id',
    { preHandler: [authenticate, makeRequireOperation('user:read')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      return services.users.get(requireTenantContext(req), id);
    },
  );

  app.patch(
    '/v1/users/:id',
    { preHandler: [authenticate, makeRequireOperation('user:update')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      const body = parse(updateUserRequestSchema, req.body);
      return services.users.update(requireTenantContext(req), id, body);
    },
  );

  app.delete(
    '/v1/users/:id',
    { preHandler: [authenticate, makeRequireOperation('user:delete')] },
    async (req, reply) => {
      const { id } = parse(uuidParamSchema, req.params);
      await services.users.remove(requireTenantContext(req), id);
      return reply.code(204).send();
    },
  );

  // ── API keys (tenant_admin) ──────────────────────────────────────────────
  app.post(
    '/v1/api-keys',
    { preHandler: [authenticate, makeRequireOperation('apikey:create')] },
    async (req, reply) => {
      const body = parse(createApiKeyRequestSchema, req.body);
      const issued = await services.apiKeys.issue(requireTenantContext(req), {
        name: body.name,
        scopes: body.scopes,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      // The plaintext is returned EXACTLY ONCE here and never persisted.
      return reply.code(201).send({ ...issued.record, plaintext: issued.plaintext });
    },
  );

  app.get(
    '/v1/api-keys',
    { preHandler: [authenticate, makeRequireOperation('apikey:list')] },
    async (req) => ({ apiKeys: await services.apiKeys.list(requireTenantContext(req)) }),
  );

  app.delete(
    '/v1/api-keys/:id',
    { preHandler: [authenticate, makeRequireOperation('apikey:revoke')] },
    async (req, reply) => {
      const { id } = parse(apiKeyIdParamSchema, req.params);
      await services.apiKeys.revoke(requireTenantContext(req), id);
      return reply.code(204).send();
    },
  );

  // ── Retention policy (read: member; write: tenant_admin) ──────────────────
  app.get(
    '/v1/retention',
    { preHandler: [authenticate, makeRequireOperation('retention:read')] },
    async (req) => services.retention.get(requireTenantContext(req)),
  );

  app.put(
    '/v1/retention',
    { preHandler: [authenticate, makeRequireOperation('retention:update')] },
    async (req) => {
      const body = parse(upsertRetentionRequestSchema, req.body);
      return services.retention.upsert(requireTenantContext(req), body);
    },
  );

  // ── Alert rules (read/list: member; write: tenant_admin) ──────────────────
  // CRUD only. Evaluation (state transitions + notification dispatch) is the
  // alert-evaluator worker's job (ADR-0001); this never sets state.
  app.post(
    '/v1/alert-rules',
    { preHandler: [authenticate, makeRequireOperation('alert:create')] },
    async (req, reply) => {
      const body = parse(createAlertRuleRequestSchema, req.body);
      const rule = await services.alerts.create(requireTenantContext(req), {
        name: body.name,
        savedQueryId: body.savedQueryId ?? null,
        query: body.query,
        comparator: body.comparator,
        threshold: body.threshold,
        windowSeconds: body.windowSeconds,
        severity: body.severity,
        enabled: body.enabled,
        notifyChannels: body.notifyChannels,
      });
      return reply.code(201).send(rule);
    },
  );

  app.get(
    '/v1/alert-rules',
    { preHandler: [authenticate, makeRequireOperation('alert:list')] },
    async (req) => ({ alertRules: await services.alerts.list(requireTenantContext(req)) }),
  );

  app.get(
    '/v1/alert-rules/:id',
    { preHandler: [authenticate, makeRequireOperation('alert:read')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      return services.alerts.get(requireTenantContext(req), id);
    },
  );

  app.patch(
    '/v1/alert-rules/:id',
    { preHandler: [authenticate, makeRequireOperation('alert:update')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      const body = parse(updateAlertRuleRequestSchema, req.body);
      return services.alerts.update(requireTenantContext(req), id, body);
    },
  );

  app.delete(
    '/v1/alert-rules/:id',
    { preHandler: [authenticate, makeRequireOperation('alert:delete')] },
    async (req, reply) => {
      const { id } = parse(uuidParamSchema, req.params);
      await services.alerts.remove(requireTenantContext(req), id);
      return reply.code(204).send();
    },
  );

  // ── Saved queries (read/list: member; write: tenant_admin) ───────────────────
  app.post(
    '/v1/saved-queries',
    { preHandler: [authenticate, makeRequireOperation('savedquery:create')] },
    async (req, reply) => {
      const body = parse(createSavedQueryRequestSchema, req.body);
      const sq = await services.savedQueries.create(requireTenantContext(req), {
        name: body.name,
        description: body.description ?? null,
        queryText: body.queryText,
        filters: body.filters,
        timeRange: body.timeRange as Record<string, unknown>,
      });
      return reply.code(201).send(sq);
    },
  );

  app.get(
    '/v1/saved-queries',
    { preHandler: [authenticate, makeRequireOperation('savedquery:list')] },
    async (req) => ({ savedQueries: await services.savedQueries.list(requireTenantContext(req)) }),
  );

  app.get(
    '/v1/saved-queries/:id',
    { preHandler: [authenticate, makeRequireOperation('savedquery:read')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      return services.savedQueries.get(requireTenantContext(req), id);
    },
  );

  app.patch(
    '/v1/saved-queries/:id',
    { preHandler: [authenticate, makeRequireOperation('savedquery:update')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      const body = parse(updateSavedQueryRequestSchema, req.body);
      return services.savedQueries.update(requireTenantContext(req), id, {
        name: body.name,
        description: body.description,
        queryText: body.queryText,
        filters: body.filters,
        timeRange: body.timeRange as Record<string, unknown> | undefined,
      });
    },
  );

  app.delete(
    '/v1/saved-queries/:id',
    { preHandler: [authenticate, makeRequireOperation('savedquery:delete')] },
    async (req, reply) => {
      const { id } = parse(uuidParamSchema, req.params);
      await services.savedQueries.remove(requireTenantContext(req), id);
      return reply.code(204).send();
    },
  );

  // ── Dashboards (read/list: member; write: tenant_admin) ─────────────────────
  app.post(
    '/v1/dashboards',
    { preHandler: [authenticate, makeRequireOperation('dashboard:create')] },
    async (req, reply) => {
      const body = parse(createDashboardRequestSchema, req.body);
      const dash = await services.dashboards.create(requireTenantContext(req), {
        name: body.name,
        description: body.description ?? null,
        layout: body.layout,
      });
      return reply.code(201).send(dash);
    },
  );

  app.get(
    '/v1/dashboards',
    { preHandler: [authenticate, makeRequireOperation('dashboard:list')] },
    async (req) => ({ dashboards: await services.dashboards.list(requireTenantContext(req)) }),
  );

  app.get(
    '/v1/dashboards/:id',
    { preHandler: [authenticate, makeRequireOperation('dashboard:read')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      return services.dashboards.get(requireTenantContext(req), id);
    },
  );

  app.patch(
    '/v1/dashboards/:id',
    { preHandler: [authenticate, makeRequireOperation('dashboard:update')] },
    async (req) => {
      const { id } = parse(uuidParamSchema, req.params);
      const body = parse(updateDashboardRequestSchema, req.body);
      return services.dashboards.update(requireTenantContext(req), id, {
        name: body.name,
        description: body.description,
        layout: body.layout,
      });
    },
  );

  app.delete(
    '/v1/dashboards/:id',
    { preHandler: [authenticate, makeRequireOperation('dashboard:delete')] },
    async (req, reply) => {
      const { id } = parse(uuidParamSchema, req.params);
      await services.dashboards.remove(requireTenantContext(req), id);
      return reply.code(204).send();
    },
  );

  // ── Invites (tenant_admin; create is rate-limited to shed email-sender abuse) ──
  // POST /v1/invites — issue a new invite; returns 201 with { ...invite, inviteUrl }.
  // The inviteUrl embeds the one-time plaintext token and is shown exactly once;
  // it is never stored or logged after this response is sent (ADR-0012, R-INV-9).
  // Rate-limited per-IP at the same ceiling as the OIDC routes (R-INV-10): each
  // create triggers best-effort outbound email which must be shed at the HTTP layer.
  app.post(
    '/v1/invites',
    {
      preHandler: [authenticate, makeRequireOperation('invite:create')],
      config: { rateLimit: oidcRateLimit },
    },
    async (req, reply) => {
      const body = parse(createInviteRequestSchema, req.body);
      const { invite, inviteUrl } = await services.invites.create(requireTenantContext(req), {
        email: body.email,
        role: body.role,
      });
      // Log invite creation without the URL/token — actor + invite id is enough
      // for the audit trail. inviteUrl must never appear in structured logs (R-INV-12).
      req.log.info({ inviteId: invite.id }, 'invite created');
      return reply.code(201).send({ ...invite, inviteUrl });
    },
  );

  // GET /v1/invites — list all invites for the caller's tenant (no tokens/hashes).
  app.get(
    '/v1/invites',
    { preHandler: [authenticate, makeRequireOperation('invite:list')] },
    async (req) => ({ invites: await services.invites.list(requireTenantContext(req)) }),
  );

  // POST /v1/invites/:id/revoke — flip an outstanding invite to 'revoked'; 204 on
  // success, 404 when the invite is absent or already consumed/revoked (RLS hides
  // cross-tenant ids transparently — the caller sees 404, not 403, for cross-tenant
  // ids, matching the behavior of every other scoped resource, R-INV-15).
  app.post(
    '/v1/invites/:id/revoke',
    { preHandler: [authenticate, makeRequireOperation('invite:revoke')] },
    async (req, reply) => {
      const { id } = parse(uuidParamSchema, req.params);
      await services.invites.revoke(requireTenantContext(req), id);
      return reply.code(204).send();
    },
  );
}
