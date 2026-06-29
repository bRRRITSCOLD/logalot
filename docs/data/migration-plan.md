# Logalot — Migration & Schema Lifecycle Plan

**Status:** Accepted (Phase 3) · **Date:** 2026-06-26 · **Owner:** data architect

Covers how schema migrations run, how the hot-store partition lifecycle is operated, and the dev
seed for the vertical slice. Schema details are in [`model.md`](./model.md); migrations live in
[`/migrations`](../../migrations).

---

## 1. Migration tooling & layout

- **Tool:** [`golang-migrate`](https://github.com/golang-migrate/migrate) — plain numbered
  `NNNNNN_description.up.sql` / `.down.sql` pairs. No ORM-generated migrations; SQL is reviewed.
- **Ordering:** zero-padded sequence `000001 … 000010`. Each migration is independently
  reversible; the full up→down→up cycle is validated (see §4).
- **`seeds/` is not a migration.** golang-migrate ignores subdirectories, so
  `migrations/seeds/dev_tenant.sql` is never auto-applied — it is dev-only and run by hand.

```
migrations/
  000001_extensions_and_app_schema.{up,down}.sql   pgcrypto, schema app, app.current_tenant_id(), set_updated_at()
  000002_enums.{up,down}.sql                        log_level, membership_role, tenant_status, alert_*
  000003_tenants.{up,down}.sql                      Tenant (registry, no RLS)
  000004_users_memberships.{up,down}.sql            User + Membership (RLS)
  000005_api_keys.{up,down}.sql                     ApiKey (RLS)
  000006_retention_policies.{up,down}.sql           RetentionPolicy (RLS)
  000007_saved_queries.{up,down}.sql                SavedQuery (RLS)
  000008_dashboards.{up,down}.sql                   Dashboard (RLS)
  000009_alert_rules.{up,down}.sql                  AlertRule (RLS)
  000010_log_events.{up,down}.sql                   Hot store: partitioned parent + RLS + default
                                                    partition + lifecycle functions + bootstrap window
  000011_logalot_app_role.{up,down}.sql             NOSUPERUSER, non-BYPASSRLS app login + grants
  …                                                 000012–000016: refresh_tokens, alert-evaluator,
                                                    alert_rules query-source, evaluator grant,
                                                    retention-worker (see /migrations)
  000017_oauth_identities.{up,down}.sql             OAuthIdentity (RLS) + per-tenant
                                                    UNIQUE(tenant_id,provider,sub) — multi-tenant
                                                    membership; tenant-scoped lookups, no bypass (§6)
  seeds/dev_tenant.sql                              dev tenant + admin + API key + retention (manual)
```

---

## 2. Running migrations locally (golang-migrate via docker)

Postgres comes up with the rest of the stack (`docker compose up`: postgres, mongodb, redis,
rabbitmq, floci). The Makefile wires the dockerized migrate CLI into the workflow — no host
install needed. The runner joins the compose `logalot` network and reaches Postgres by service
hostname, building `DATABASE_URL` from the same `.env` Postgres creds compose uses:

```bash
make up              # bring the stack up (creates .env from .env.example first run)
make migrate-up      # apply all pending migrations (000001..000011)
make migrate-version # print the current version (=> 11 after a clean up)
make migrate-down    # roll back exactly ONE migration (run again to step further)
make seed            # load the dev tenant + API key (idempotent; §5)

make migrate-create name=add_widgets   # scaffold a new NNNNNN_*.{up,down}.sql pair
```

Under the hood each target is:

```bash
docker run --rm --network logalot -v "$PWD/migrations:/m" \
  migrate/migrate -path=/m \
  -database "postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB?sslmode=disable" <cmd>
```

> Integration tests use the same migrations via testcontainers so the test schema is
> byte-identical to dev/prod.

### Two roles, two connection strings (important for RLS)

Migrations run as the **admin/migrate** role (`POSTGRES_USER`), which OWNS the schema and runs
all DDL. Services must **never** use it. They connect as **`logalot_app`** — a
**`NOSUPERUSER`, non-`BYPASSRLS`** role — otherwise `FORCE ROW LEVEL SECURITY` is bypassed and
the tenant backstop is silently disabled (model.md §4.2).

`logalot_app` is provisioned by **migration `000011_logalot_app_role`** (repeatable, applied with
the rest of `make migrate-up` — no separate bootstrap script to remember). It is created
`NOSUPERUSER NOBYPASSRLS`, owns nothing, and is granted `SELECT/INSERT/UPDATE/DELETE` on the
domain tables in `public` plus `EXECUTE` on `app.*`. Default privileges extend those grants to
future tables/functions created by the migrate role, so new migrations don't have to re-grant.

| Role | Used by | `.env` var | Attributes |
|---|---|---|---|
| `logalot` (admin) | `make migrate-*`, `make seed` | `DATABASE_URL` | owner, runs DDL |
| `logalot_app` | every service (ingest/processor/query/control-plane) | `LOGALOT_APP_DATABASE_URL` | `NOSUPERUSER`, `NOBYPASSRLS`, DML + EXECUTE only |

Dev creds for `logalot_app` are baked into `000011` (`logalot_app` / `logalot_app`, LOCAL DEV
ONLY). Rotate for any non-local environment with `ALTER ROLE logalot_app PASSWORD '…';`.

---

## 3. Partition lifecycle (hot store)

`log_events` is daily-RANGE-partitioned. Two scheduled jobs keep it healthy (functions defined in
`000010`, validated against Postgres 16):

| Job | Function | Cadence | Purpose |
|---|---|---|---|
| **Create ahead** | `SELECT app.ensure_log_events_partitions(7);` | daily | Guarantees today..+7 partitions exist so ingest never lands in the default partition. Idempotent. |
| **Drop at retention** | `SELECT app.drop_log_events_partitions_older_than(30);` | daily | Drops daily partitions older than the global hot horizon (30d) in O(1). Never touches the default partition. |

- **How to schedule:** simplest is `pg_cron` inside Postgres; otherwise a tiny cron container or
  the `processor`'s maintenance goroutine calling these functions (the architecture already shows
  `processor -.-> drop 30d partitions`). Both are fine — pick one and document the owner.
- **Bootstrap:** `000010` calls `ensure_log_events_partitions(7)` at migrate time, so a fresh DB
  is immediately ingest-ready for the slice without waiting for the scheduler.
- **Default-partition caveat:** keep the create-ahead job running; a non-empty default partition
  blocks attaching an overlapping new partition. In steady state the default stays empty.
- **Per-tenant shorter hot retention** (a tenant with `hot_days < 30`) is handled by an optional
  tenant-scoped `DELETE … WHERE tenant_id = $ctx AND ts < cutoff` off the hot path — the shared
  time-only partition drop cannot express it. True per-tenant retention is the cold-tier prefix
  delete (see [`cold-tier.md`](./cold-tier.md)).

---

## 4. Validation status

The full sequence was applied and rolled back against `postgres:16-alpine`:

- `up` 000001→000010 + `seeds/dev_tenant.sql`: clean.
- RLS fail-closed: `SELECT` with no `app.tenant_id` ⇒ 0 rows; foreign-tenant `INSERT` ⇒ rejected
  by `WITH CHECK`.
- Cross-tenant isolation on `api_keys` and `log_events`: 0 rows for a different tenant.
- `log_events`: generated `tsvector` populated; FTS `@@ websearch_to_tsquery` and JSONB `@>`
  return the row; `EXPLAIN` prunes to a single daily partition for a `tenant_id`+1h query.
- Partition lifecycle: bootstrap created 8 partitions; `ensure` is idempotent; retention dropped a
  40-day-old partition and **kept** the default.
- `down` 000010→000001: clean; `app` schema and all tables removed.

---

## 5. Seed strategy (dev tenant + API key for the vertical slice)

After `up`, provision the slice's tenant:

```bash
make seed   # = docker exec -i logalot-postgres psql "$DATABASE_URL" -f - < migrations/seeds/dev_tenant.sql
```

`make seed` runs against the running compose Postgres as the admin role. Every insert is
`ON CONFLICT DO NOTHING`, so re-running is safe; the API-key plaintext is printed once in the
seed file header (by design — it is never stored).

It creates (DEV ONLY):

| Object | Value |
|---|---|
| Tenant | `public_id=dev`, `id=00000000-0000-0000-0000-0000000000d1` |
| Admin user | `admin@dev.local` (password hash is a stub — re-hash via control-plane) + `tenant_admin` membership |
| API key (shown once) | `lgk_dev_devkey001_devsecret0123456789` → stored as `id='devkey001'`, `key_hash=sha256(secret)` |
| Retention policy | `hot_days=30`, `cold_days=365` |

Mechanics that matter:
- `tenants` is inserted first (no RLS). Then the seed runs `SET LOCAL app.tenant_id = '<dev id>'`
  so the RLS `WITH CHECK` accepts the tenant-owned inserts (users, membership, api_key, retention).
- The key secret is hashed in-DB via `digest(secret,'sha256')` (pgcrypto) — no plaintext, no
  precomputed hash to drift.
- This satisfies the slice acceptance path: ingest authenticates the dev key →
  `TenantContext{tenant_id=…d1}` → publish → processor inserts into `log_events` under
  `SET LOCAL app.tenant_id` → live tail on `tail:…d1`. Ingesting for `dev` can never appear under
  any other tenant (RLS + channel naming).

---

## 6. Migration `000017` — Google OAuth identity linking (`oauth_identities`)

Adds the OIDC account-link table (Identity & Access, ADR-0007). Schema detail and
the access-pattern reasoning live in [`model.md` §6 / §4.6](./model.md); this is the
operational summary.

**`up` ships:**

- `CREATE TYPE oauth_provider AS ENUM ('google')` — house enum style (000002).
- `CREATE TABLE oauth_identities` — RLS (`ENABLE` + `FORCE`) with the standard
  `tenant_id = app.current_tenant_id()` policy; **per-tenant**
  `UNIQUE(tenant_id, provider, provider_sub)` (multi-tenant membership — one Google
  account may link in several tenants); `UNIQUE(tenant_id, user_id, provider)`;
  composite FK `(tenant_id, user_id) → users(tenant_id, id)`; `updated_at` trigger.
- **No `SECURITY DEFINER` resolver and no `BYPASSRLS` role.** The tenant is always
  known from `state` before any oauth lookup, so every access path is a normal
  RLS-scoped query (`SET LOCAL app.tenant_id`, then a tenant-scoped SELECT/INSERT).
  The linked-tenant == state-tenant invariant (R3) holds structurally — a row is
  only found in the armed tenant (model.md §4.6).

**Grants.** Table DML for `logalot_app` is covered by the `ALTER DEFAULT
PRIVILEGES` from `000011` (this migration runs as the same migrate role), so no
re-grant — identical to `000012`+. No function grants (no function ships).

**Ordering / `down`.** `000016` is the prior head (retention-worker); this is
`000017`, no in-flight conflicts. `down` drops the table **before** the type (the
`provider` column references `oauth_provider`): table → type.

**Validation to run (mirrors §4 + the threat model's testable requirements):**

- `up` 000016→000017 clean; `down` 000017→000016 clean (full up/down/up cycle).
- RLS fail-closed: `SELECT * FROM oauth_identities` with no `app.tenant_id` ⇒ 0 rows;
  an INSERT stamped with a foreign `tenant_id` ⇒ rejected by `WITH CHECK`.
- Per-tenant uniqueness: the same `(provider, sub)` may be inserted under tenant A
  AND tenant B (multi-tenant membership), but a second insert of the same
  `(provider, sub)` **within** a tenant ⇒ unique violation.
- Tenant-scoped by-sub lookup: as `logalot_app` with tenant A armed,
  `SELECT … WHERE provider='google' AND provider_sub=$sub` returns A's row; with
  tenant B armed it returns B's row (or 0 if not linked in B) — no bypass, structural
  R3 cross-check.
- Same-tenant FK: linking `user_id` from tenant A while `tenant_id` = B ⇒ FK
  violation.

**Optional dev seed.** The dev seed (§5) may, after `SET LOCAL app.tenant_id =
'<dev id>'`, insert a dev `oauth_identities` row for the dev admin
(`provider='google'`, a placeholder `provider_sub`, normalized
`email='admin@dev.local'`) so the OAuth slice is demoable without a live Google
round-trip. Keep it `ON CONFLICT DO NOTHING`, DEV ONLY; a real link is written by
the control-plane callback.
