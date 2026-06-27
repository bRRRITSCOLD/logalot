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
  seeds/dev_tenant.sql                              dev tenant + admin + API key + retention (manual)
```

---

## 2. Running migrations locally (golang-migrate via docker)

Postgres comes up with the rest of the stack (`docker compose up`: postgres, mongodb, redis,
rabbitmq, floci). Run migrations against it with the dockerized migrate CLI — no host install
needed:

```bash
# from repo root; DATABASE_URL points at the compose postgres
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/logalot?sslmode=disable'

# apply everything
docker run --rm --network host -v "$PWD/migrations:/m" \
  migrate/migrate -path=/m -database "$DATABASE_URL" up

# roll back one step / everything
docker run --rm --network host -v "$PWD/migrations:/m" \
  migrate/migrate -path=/m -database "$DATABASE_URL" down 1

# inspect current version
docker run --rm --network host -v "$PWD/migrations:/m" \
  migrate/migrate -path=/m -database "$DATABASE_URL" version
```

> If your compose maps Postgres on a non-default port or runs on a user-defined network, swap
> `--network host` for `--network <compose_net>` and use the service hostname
> (`postgres://postgres:postgres@postgres:5432/logalot`). Integration tests use the same
> migrations via testcontainers so the test schema is byte-identical to dev/prod.

**Application role (important for RLS).** Migrations run as the owner/superuser, but the services
must connect as a **non-superuser, non-`BYPASSRLS`** role — otherwise `FORCE ROW LEVEL SECURITY`
is bypassed and the tenant backstop is silently disabled. Provision e.g. `logalot_app` with
`SELECT/INSERT/UPDATE/DELETE` on the domain tables and `EXECUTE` on `app.*`, and point every
service's `DATABASE_URL` at it. The migrate/admin role stays separate.

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

After `up`, provision the slice's tenant by hand:

```bash
docker exec -i <postgres> psql "$DATABASE_URL" < migrations/seeds/dev_tenant.sql
```

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
