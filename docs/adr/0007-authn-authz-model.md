# ADR-0007: Authentication and authorization model

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** systems architect
- **Related:** spec §Multi-tenancy/§Open questions, overview.md §6, ADR-0002, ADR-0004, NFR-5, NFR-6

## Context

Two distinct authentication surfaces with different needs:

1. **Ingest** — machine-to-machine, hot path (≥50k events/s/node), must be cheap to verify and safe to
   store. Credentials are long-lived and provisioned by tenant admins.
2. **UI** — interactive humans, need sessions, RBAC, and the ability to add SSO/OIDC later (the spec defers
   federation but requires the design to allow it). Every credential must resolve to exactly one tenant and
   feed the `TenantContext` that drives isolation (ADR-0002).

## Decision

### Ingest: opaque, hashed API keys
- Format `lgk_<tenantPublicId>_<keyId>_<secret>`. `tenantPublicId` (tenant slug) resolves the tenant so RLS
  can be armed before the scoped key lookup; `keyId` is the `api_keys.id` looked up under RLS; `secret` is
  high-entropy random. The `secret` (and full key) is shown to the admin **exactly once** at creation.
- Store only `{key_id, tenant_id, scopes, hash}` where `hash = SHA-256(secret)` (fast, suitable because the
  secret is high-entropy random — argon2/bcrypt are for low-entropy human passwords and are too slow for the
  hot path). Lookup by `key_id`; compare in **constant time**.
- **Hot-path caching:** validated keys are cached in Redis (`{key_id → tenant_id, scopes}`, TTL 60s) so
  ingest does not hit Postgres per request (NFR-3). Revocation deletes the key row and busts the cache key.
- Resolves to `TenantContext{tenant_id, principal=apiKey, scopes=[ingest:write]}`. The key's `tenant_id` is
  authoritative; the request body cannot assert a tenant (ADR-0002).

### UI: short-lived session JWT + refresh
- Local username/password (v1) → issue a **short-lived access JWT** (claims: `tenant_id`, `principal_id`,
  `role`, `scopes`, `exp`) + a refresh token. The `web` BFF holds the tokens; the browser uses an httpOnly
  cookie.
- Verification runs in **edge middleware** on `query-service` / `control-plane` before any handler, building
  `TenantContext` from the verified claims.

### RBAC
- Roles: **`tenant_admin`** (manage tenant: keys, users, retention, alert rules, dashboards),
  **`member`** (search, live tail, dashboards, alert authoring per tenant policy),
  **`platform_operator`** (platform-scope health/capacity/usage only — structurally barred from tenant log
  content).
- Authorization is checked at the edge (route guard by role/scope) and **re-asserted in the domain** for
  sensitive commands (e.g. key creation, retention change). Authorization never substitutes for tenant
  scoping — both apply.
- **Scopes (API keys).** `ingest:write` is write-only (POST /v1/ingest). The log-read surface
  (`query-service` /v1/search, /v1/tail, /v1/panel-data) requires the **`logs:read`** scope; as of #82
  `ingest:write` no longer satisfies the read gate (the back-compat grant from #76 has been retired).
  Read-only consumers are issued `logs:read`; keys that both ingest and read carry both scopes.

### Extensibility
- Identity lives in the **Identity & Access** bounded context behind `Principal` / `TenantContext`
  abstractions and an `Authenticator` port. Adding an OIDC/SAML adapter later is a new `Authenticator`
  implementation that produces the same `TenantContext`; **no downstream context changes**.

## Status

Accepted. v1 = local users + hashed API keys. SSO/OIDC deferred (spec) but the port is designed for it.

## Consequences

### Positive
- Cheap, safe ingest auth: SHA-256 of a high-entropy secret + Redis cache keeps the hot path fast and the
  store free of plaintext credentials (NFR-3, NFR-5).
- Single tenant-resolution path: both surfaces produce the same `TenantContext`, so the isolation model
  (ADR-0002) has one consistent input regardless of auth method.
- OIDC-ready without rework; RBAC + tenant scoping are independent, defense-in-depth controls.

### Negative / costs
- 60s key cache means revocation has up to 60s propagation lag; acceptable, and tunable (or bustable on
  revoke for immediacy).
- JWT revocation before `exp` requires a short TTL + refresh (chosen) or a denylist; we use short TTLs to
  avoid a denylist in v1.

### Trigger to revisit
- Add an **OIDC `Authenticator` adapter** when SSO is prioritized (out of current scope).
- Move to a **JWT denylist / session store** if immediate UI-session revocation becomes a requirement.
- Shorten or bust the **API-key cache TTL** if faster revocation is required.

## Alternatives considered

| Concern | Chosen | Alternative | Why chosen |
|---|---|---|---|
| Ingest key storage | SHA-256 of high-entropy secret | argon2/bcrypt | Hot path; secret is already high-entropy, so slow KDFs add cost without security gain |
| Ingest key verify cost | Redis cache (60s) + key_id lookup | Per-request DB lookup | Keeps ingest p95 < 50ms at 50k/s |
| UI session | Short-lived JWT + refresh | Server-side session store | Stateless verification at every service edge; store is the escape hatch if revocation tightens |
| Tenant in token | `tenant_id` claim/binding (authoritative) | tenant in request body | Body-asserted tenant is the classic cross-tenant leak; forbidden (ADR-0002) |
| Federation | `Authenticator` port now, OIDC later | Build OIDC now | YAGNI; spec defers federation but requires design to allow it |
