import {
  createAlertRuleRequestSchema,
  createApiKeyRequestSchema,
  createTenantRequestSchema,
  createUserRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  updateAlertRuleRequestSchema,
  updateTenantRequestSchema,
  updateUserRequestSchema,
} from '@logalot/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TokenService } from '../../app/ports';
import type { Services } from '../../container';
import { makeAuthenticate, requireTenantContext } from './auth-plugin';
import { makeRequireOperation } from './rbac-guard';
import { parse } from './validation';

// Path-param schemas are a transport concern (not shared DTOs), so they live here.
// `:id` is a UUID for tenants/users, but an opaque key id for api-keys.
const uuidParamSchema = z.object({ id: z.string().uuid() });
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

// Retention is not (yet) in @logalot/contracts; bounds mirror migration 000006.
const upsertRetentionSchema = z
  .object({
    hotDays: z.number().int().min(1).max(90),
    coldDays: z.number().int().min(1).max(36500),
  })
  .strict()
  .refine((v) => v.coldDays >= v.hotDays, { message: 'coldDays must be >= hotDays' });

export interface RouteDeps {
  services: Services;
  tokenService: TokenService;
  // Readiness probe: resolves true when the datastore is reachable.
  ping: () => Promise<boolean>;
}

// registerRoutes wires every endpoint. Validation uses the SHARED zod contracts
// (@logalot/contracts) — the same schemas the frontend uses, so request shapes can
// never drift. Protected routes carry two preHandlers: authenticate (verify JWT →
// TenantContext) then requireOperation (edge RBAC). The application services
// re-assert RBAC and arm RLS independently underneath (defense in depth).
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { services, tokenService, ping } = deps;
  const authenticate = makeAuthenticate(tokenService);

  // ── Health / readiness (public) ──────────────────────────────────────────
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ready = await ping().catch(() => false);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });

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
      const body = parse(upsertRetentionSchema, req.body);
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
}
