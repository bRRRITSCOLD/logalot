# control-plane

Node + Fastify control-plane for Logalot's **Identity & Access** bounded context
(issue #11, ADR-0001/0002/0007). It owns tenants, users + memberships, API keys,
retention policy, RBAC, and short-lived JWT sessions with rotating refresh tokens.

## Architecture (hexagonal / ports-and-adapters)

```
src/
  domain/      pure core — entities, roles, RBAC matrix, api-key + refresh-token
               format/hash, errors. No I/O, no transport.
  app/         use-case services (auth, tenants, users, api-keys, retention) that
               depend only on ports.ts interfaces; RBAC re-asserted here.
  adapters/
    http/      Fastify (driving): routes, JWT auth preHandler, RBAC guard,
               zod validation via @logalot/contracts, error handler.
    postgres/  pg (driven): repositories + the tenant-scoped tx helper that arms
               RLS (`SELECT set_config('app.tenant_id', $1, true)`).
    crypto/    bcrypt (passwords), jose (access JWT), CSPRNG generators, clock.
  config/      zod-validated env.
  container.ts composition root (the only place ports meet adapters).
  index.ts     lifecycle: listen + graceful shutdown.
```

## Multi-tenant isolation (load-bearing)

- The service connects as the **NOSUPERUSER `logalot_app`** role
  (`LOGALOT_APP_DATABASE_URL`) so `FORCE ROW LEVEL SECURITY` governs every query.
- Every tenant-owned statement runs inside `withTenantTx`, which issues
  `SET LOCAL app.tenant_id` (via `set_config(..., true)`) — the same convention as
  the Go kernel (model.md §4.1). RLS is a fail-closed backstop under the RBAC +
  repository scoping.
- Tenancy always comes from the verified credential (JWT / login slug), **never**
  the request body (ADR-0002).

## Endpoints

| Method | Path | Role |
|---|---|---|
| POST | `/v1/auth/login` | public (tenant slug + email + password) |
| POST | `/v1/auth/refresh` | public (rotating refresh token) |
| POST | `/v1/auth/logout` | public (revokes the token family) |
| POST/GET/GET/PATCH/DELETE | `/v1/tenants[...]` | platform_operator |
| POST | `/v1/tenants/:id/admin` | platform_operator (bootstrap first admin) |
| POST/GET/GET/PATCH/DELETE | `/v1/users[...]` | tenant_admin |
| POST/GET/DELETE | `/v1/api-keys[...]` | tenant_admin |
| GET | `/v1/retention` | member+ |
| PUT | `/v1/retention` | tenant_admin |
| GET | `/healthz`, `/readyz` | public |

## API-key compatibility

Keys are minted as `lgk_<tenantSlug>_<keyId>_<secret>` and stored as
`sha256(secret)` (32-byte bytea) — byte-identical to the Go ingest `Authenticator`
(`pkg/auth`) and migration `000005`, so a key issued here authenticates on ingest.

## Tests

- `pnpm test` — fast, Docker-free unit tests (RBAC matrix, key mint/hash, JWT,
  password hashing, auth/refresh rotation, zod validation).
- `pnpm test:integration` — Docker-backed (testcontainers Postgres): applies all
  migrations, connects as `logalot_app`, and proves cross-tenant denial, API-key
  hash compatibility, RBAC denials, and login→JWT→refresh-rotation end to end.
