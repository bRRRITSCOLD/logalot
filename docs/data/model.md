# Logalot — Data Model

**Status:** Accepted (Phase 3) · **Date:** 2026-06-26 · **Owner:** data architect

This is the canonical data model for Logalot. It builds on, and never contradicts, the
architecture (`docs/architecture/overview.md`, `nfr.md`) and the ADRs — especially
[ADR-0002](../adr/0002-multi-tenancy-isolation-model.md) (multi-tenancy),
[ADR-0003](../adr/0003-hot-log-store.md) (hot store),
[ADR-0005](../adr/0005-cold-tier-and-retention.md) (cold tier),
[ADR-0007](../adr/0007-authn-authz-model.md) (auth). Where they disagree, the ADRs win.

The schema is implemented as runnable, version-validated migrations under
[`/migrations`](../../migrations) (golang-migrate, applied + rolled back against Postgres 16).
The cold tier is specified in [`cold-tier.md`](./cold-tier.md); operations in
[`migration-plan.md`](./migration-plan.md).

---

## 1. Per-store responsibilities (polyglot persistence — justified)

Every store earns its place against the workload. We do **not** add a store we cannot justify.

| Store | Role | Why this store (and not another) |
|---|---|---|
| **PostgreSQL** | Control-plane system of record **and** the 30-day hot log store | One technology for control plane + hot logs = lowest ops burden, fully Docker-testable, RLS gives a real fail-closed tenant backstop. Partition-pruned tenant+time queries meet p95 < 2s (ADR-0003). |
| **Redis** | API-key validation cache (60s TTL), per-tenant rate limiting, live-tail pub/sub (`tail:{tenant_id}`) | Keeps the ingest hot path off Postgres (NFR-3); native pub/sub fits the unidirectional tail fan-out (ADR-0006). Not a system of record — purely ephemeral. |
| **RabbitMQ** | Durable ingest pipeline (`ingest → processor`), DLQ | Durable enqueue is the basis of "202-after-durable-enqueue" (ADR-0004). Carries the `{tenant_id, received_at, raw}` envelope, not state. |
| **floci S3 + Glue + Athena** | Cold tier: Parquet archive, tee'd from day 0, queried on demand | Cheap durable retention + pay-per-scan history; tenant isolation via S3 key prefix + Glue partition (ADR-0005). See [`cold-tier.md`](./cold-tier.md). |
| **MongoDB** | **Reserved / unused in v1 (YAGNI)** | Available in local compose but assigned no responsibility. Postgres JSONB already covers dashboards/saved-queries/labels with transactions + RLS, so a second document store would add ops cost for no gain. Documented candidate future use: only if dashboard/saved-query documents become large and schema-fluid enough that JSONB-in-Postgres is painful — not the case today. Do not force it in. |

**Aggregate → transactional-boundary rule (DDD).** Every aggregate root maps to exactly one
table whose writes are one transaction in **one** store. No aggregate spans two stores in a
single write. The processor's tee (hot Postgres + cold S3) is **not** a cross-store aggregate
write: the hot insert is the transactional write; the cold tee is a best-effort, retried
side-effect (NFR-2), and cold is reconstructable from the queue/DLQ.

---

## 2. Aggregate → table mapping

| Bounded context | Aggregate root | Table(s) | Tenant-owned? (RLS) | Migration |
|---|---|---|---|---|
| Identity & Access | **Tenant** | `tenants` | No — registry (see §4) | `000003` |
| Identity & Access | **User** | `users` + `memberships` (RBAC) | Yes | `000004` |
| Identity & Access | **ApiKey** | `api_keys` | Yes | `000005` |
| Identity & Access | **OAuthIdentity** | `oauth_identities` (links user ↔ Google) | Yes | `000017` |
| Identity & Access | **RetentionPolicy** | `retention_policies` (1:1 tenant) | Yes | `000006` |
| Workspace | **SavedQuery** | `saved_queries` | Yes | `000007` |
| Workspace | **Dashboard** | `dashboards` (panels inline JSONB) | Yes | `000008` |
| Alerting | **AlertRule** | `alert_rules` (state embedded) | Yes | `000009` |
| Log Storage & Retention | **LogEvent (hot)** | `log_events` (partitioned) | Yes | `000010` |
| Log Storage & Retention | **LogEvent (cold)** | S3 Parquet (Glue/Athena) | Yes (S3 prefix) | [`cold-tier.md`](./cold-tier.md) |

**Cross-aggregate references use identity, not hard FKs.** `dashboards.layout` panels and
`alert_rules.saved_query_id` reference a `SavedQuery` by id only. Same-tenant integrity is
guaranteed by RLS (a foreign-tenant id is simply invisible) plus repository scoping — no
composite FK is needed across aggregate roots. Within an aggregate we *do* use FKs (e.g.
`memberships → users` on `(tenant_id, user_id)`) for referential integrity.

---

## 3. ER overview

```mermaid
erDiagram
    tenants ||--o{ users : "owns"
    tenants ||--o{ memberships : "scopes"
    tenants ||--o{ api_keys : "owns"
    tenants ||--o{ oauth_identities : "owns"
    tenants ||--|| retention_policies : "has"
    tenants ||--o{ saved_queries : "owns"
    tenants ||--o{ dashboards : "owns"
    tenants ||--o{ alert_rules : "owns"
    tenants ||--o{ log_events : "owns (logical; no FK)"

    users ||--o{ memberships : "granted role"
    users ||--o{ oauth_identities : "linked OIDC identity"
    saved_queries |o..o{ alert_rules : "referenced by id"
    saved_queries |o..o{ dashboards : "panel refs by id"

    tenants {
        uuid id PK
        text public_id UK "slug in API key"
        text name
        tenant_status status
    }
    users {
        uuid id PK
        uuid tenant_id FK
        text email "UK per tenant"
        text password_hash
        bool is_platform_operator "cross-tenant role"
    }
    memberships {
        uuid tenant_id PK,FK
        uuid user_id PK,FK
        membership_role role "tenant_admin|member"
    }
    api_keys {
        text id PK "key_id"
        uuid tenant_id FK
        bytea key_hash "sha256(secret)"
        text_arr scopes
        timestamptz revoked_at
    }
    oauth_identities {
        uuid id PK
        uuid tenant_id FK
        uuid user_id FK
        oauth_provider provider "google"
        text provider_sub "Google sub; UK(provider,sub) GLOBAL"
        text email "link-time snapshot, normalized"
        timestamptz last_login_at
    }
    retention_policies {
        uuid tenant_id PK,FK
        int hot_days "default 30"
        int cold_days "default 365"
    }
    saved_queries {
        uuid id PK
        uuid tenant_id FK
        text query_text "FTS"
        jsonb filters
        jsonb time_range
    }
    dashboards {
        uuid id PK
        uuid tenant_id FK
        jsonb layout "panels inline"
    }
    alert_rules {
        uuid id PK
        uuid tenant_id FK
        uuid saved_query_id "ref by id"
        alert_comparator comparator
        numeric threshold
        int window_seconds
        alert_state state "embedded"
    }
    log_events {
        uuid tenant_id PK "leading"
        timestamptz ts PK "partition key"
        uuid id PK
        log_level level
        text message
        jsonb labels
        tsvector search "generated"
    }
```

---

## 4. Multi-tenant enforcement at the data layer

This is the data-layer realization of the four-layer model in `overview.md §6` and ADR-0002.
At the **storage** layer the controls are: (a) `tenant_id` as the leading PK column / partition
prefix, (b) PostgreSQL Row-Level Security as a fail-closed backstop, (c) the mandatory
`tenant_id` predicate the repository always binds from `TenantContext`.

### 4.1 The tenant-context convention (the contract the backend relies on)

There is **one** convention, and every service adapter implements it:

```sql
-- Once per request, inside the transaction, BEFORE any tenant-scoped statement:
SET LOCAL app.tenant_id = '<tenant uuid from TenantContext>';
```

- The GUC name is **`app.tenant_id`** (matches ADR-0002 §3 and `overview.md §6`). This is the
  authoritative convention; the staff-/backend-engineer code to this exact name.
- Every RLS policy reads it through one helper (DRY):
  `app.current_tenant_id()` = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
  The two-arg `current_setting(..., true)` returns `NULL` (not an error) when the GUC is unset.
- **Fail-closed:** when unset/blank, `app.current_tenant_id()` is `NULL`, so the policy
  predicate `tenant_id = NULL` is `NULL`→FALSE and the query/insert sees **zero rows**. Verified:
  a `SELECT` on `api_keys` with no context returns 0 rows; an `INSERT` with a foreign
  `tenant_id` is rejected with *"new row violates row-level security policy"*.
- Use `SET LOCAL` (transaction-scoped), not `SET`, so a pooled connection never leaks one
  request's tenant context into the next. On a transaction-less connection, `set_config('app.tenant_id', $1, false)` at the start of the unit of work is the equivalent.

### 4.2 RLS policy approach

Every tenant-owned table has the identical, auditable policy shape:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;          -- owner is NOT exempt
CREATE POLICY <t>_tenant_isolation ON <t>
  USING      (tenant_id = app.current_tenant_id())   -- read/update/delete visibility
  WITH CHECK (tenant_id = app.current_tenant_id());  -- insert/update cannot set a foreign tenant
```

- **`FORCE ROW LEVEL SECURITY`** is deliberate: a table's owner normally bypasses RLS. Forcing
  it means the policy holds even if the app connects as the owner. **Operational requirement:**
  the application database role **must not** be a superuser and **must not** have `BYPASSRLS`
  (superusers/BYPASSRLS bypass even FORCE). Validated with a `NOSUPERUSER` role.
- `WITH CHECK` closes the write side: a tenant cannot insert/update a row stamped with another
  tenant's id, so the body-asserted-tenant attack is dead at the storage layer too.

### 4.3 Partition-key strategy and the RLS × partitioning interaction

- `log_events` is **RANGE-partitioned by `ts`** (daily), with `tenant_id` as the **leading
  column of the primary key** `(tenant_id, ts, id)` — the tenant prefix from ADR-0003.
- **RLS works on partitioned tables.** The policy is defined on the **parent** `log_events`.
  When you query the parent, PostgreSQL applies the parent's policy and it cascades to every
  partition scan — confirmed: an insert under tenant A's context is invisible under tenant B's
  context, and partition pruning still narrows a `tenant_id`+time query to a single daily
  partition (`EXPLAIN` shows one `log_events_YYYYMMDD`, not the default).
- **Access contract:** all reads/writes go through the **parent** table `log_events`, never a
  partition directly. (RLS policies are not inherited to a child for *direct* access; routing
  through the parent is what the `LogStore` adapter does, so parent policies fully govern.)

### 4.4 How a tenant-scoped query is *guaranteed* (three independent failures required to leak)

1. The repository binds `WHERE tenant_id = $ctx` from `TenantContext` (application layer).
2. `SET LOCAL app.tenant_id` arms RLS; even a forgotten predicate returns only that tenant's
   rows (storage layer).
3. The credential resolved to exactly one `tenant_id` at the edge (auth layer, ADR-0007).

A cross-tenant leak requires all three to fail at once. Fitness tests (NFR-6) assert each
independently, including the "context unset ⇒ zero rows" backstop.

### 4.5 The two registry/scheduler exceptions (documented on purpose)

- **`tenants` has no RLS.** It is the tenant *registry*, not a tenant-owned table. Provisioning
  a new tenant happens before any tenant context exists, so RLS would be a chicken-and-egg
  problem. Access is governed by control-plane role checks: `platform_operator` manages
  lifecycle; a tenant reads only its own row via `id = app.current_tenant_id()` enforced in the
  repository.
- **The ingest key lookup is tenant-scoped, not unscoped.** Auth is a chicken-and-egg too (the
  key *is* what establishes the tenant). Resolution: the presented key
  `lgk_<publicId>_<keyId>_<secret>` carries the tenant slug; ingest resolves
  `tenants.public_id → id`, runs `SET LOCAL app.tenant_id`, *then* does the scoped
  `SELECT … WHERE id = <keyId>` and constant-time compares `key_hash`. So even auth runs inside
  RLS.
- **The alert-evaluator scheduler** needs to find *due rules across all tenants*, which FORCE
  RLS would hide. It uses a dedicated role with `BYPASSRLS` **only** to read rule scheduling
  metadata `(tenant_id, rule_id, last_evaluated_at)` — never log content. It then re-enters each
  rule's tenant context (`SET LOCAL app.tenant_id`) before running the query against
  `log_events`, so log reads remain RLS-governed. This is consistent with `platform_operator`
  being barred from tenant log content (NFR-5.4).

### 4.6 OIDC identity resolution — the by-sub lookup under RLS (the third chicken-and-egg)

Google OAuth subsequent-login has the **same** "the credential establishes the
tenant" problem as the api-key lookup (§4.5), but worse: an api key embeds the
tenant slug, so ingest can resolve `tenants.public_id → id`, arm RLS, then do the
scoped lookup. A Google `id_token` carries **only** `sub` (+ `email`) — **no
tenant hint**. And per the threat model (§0, R3), `sub` is *authoritative for
identity*: subsequent login must resolve `sub → tenant` and then cross-check that
tenant against the `state` slug, so we cannot simply trust `state` to arm RLS for
the lookup.

Under `FORCE ROW LEVEL SECURITY`, a `SELECT … WHERE provider_sub = $1` with no
`app.tenant_id` set returns **zero rows** (fail-closed) — indistinguishable from
"not linked yet". So the by-sub lookup needs a controlled, minimal RLS bypass.

**Two access paths for `oauth_identities` (both must hold under FORCE RLS):**

| Path | Tenant known? | Mechanism |
|---|---|---|
| **First link** | Yes — from verified `state` slug | `SET LOCAL app.tenant_id`, match `users(tenant_id, email)`, **INSERT under RLS**. The global `UNIQUE(provider, provider_sub)` index still enforces across *invisible* tenants (RLS filters reads, not unique enforcement), so a sub already linked anywhere → unique violation → 401/409. |
| **Subsequent login** | No — `sub` is authoritative | Call **`app.resolve_oauth_identity_by_sub(provider, sub)`** to get `(tenant_id, user_id)`; then `SET LOCAL app.tenant_id = <resolved>`, cross-check vs `state` (mismatch → 401), `UPDATE last_login_at` **under RLS**. |

**Recommended mechanism for the by-sub lookup — `SECURITY DEFINER` resolver
function (chosen).** `000017` ships
`app.resolve_oauth_identity_by_sub(p_provider oauth_provider, p_provider_sub text)
RETURNS TABLE(tenant_id uuid, user_id uuid)`, `STABLE`, `SECURITY DEFINER`, with
`SET search_path = pg_catalog, public, app` (the 000016 hardening shape). It runs
as its owner (the migrate/admin role, a superuser in this deployment), which
bypasses FORCE RLS, and returns **only** the `(tenant_id, user_id)` tuple for an
**exact** `(provider, sub)` match — never a scan, never another column, never
another table; the global unique index guarantees ≤ 1 row. `EXECUTE` is **revoked
from `PUBLIC`** (a SECURITY DEFINER function is public-executable by default) and
granted to **`logalot_app` only**.

This keeps the control-plane on its **single `logalot_app` pool** (it calls the
resolver to learn the authoritative tenant, then re-enters that tenant's context
for everything else), exactly mirroring how the api-key authenticator resolves
slug→tenant *before* arming RLS (`pkg/auth/authenticator.go`,
`resolveKey → SET LOCAL → scoped SELECT`).

**Why a function and not a BYPASSRLS role.** The cross-tenant *scanners*
(alert-evaluator, retention-worker, §4.5) use a dedicated `BYPASSRLS` role because
they need to read *many* tenants' rows from a *separate* worker process. The OIDC
lookup is a *single-tuple point lookup* inside the control-plane process, which
otherwise runs all its writes under RLS — giving that process a second BYPASSRLS
connection would be a standing footgun (one mis-routed query disables the tenant
backstop for control-plane). A `SECURITY DEFINER` function gated to one signature
is the tighter grant. **Documented fallback** (if the migrate/admin role is ever
de-superuser'd without `BYPASSRLS`, which is what makes the bypass work): switch to
a dedicated `BYPASSRLS` role granted `SELECT` on `oauth_identities` only, consumed
by control-plane via a separate small pool for this one lookup.

> **Lead-engineer action:** the control-plane OIDC authenticator must (a) call
> `app.resolve_oauth_identity_by_sub` *before* arming RLS on the subsequent-login
> path, (b) treat a unique-violation on first-link INSERT as "already linked
> elsewhere" (401/409, not a 500), and (c) normalize `id_token.email`
> identically to user provisioning before the first-link `users` match (see §6).

---

## 5. Hot log store — `log_events` in detail (ADR-0003)

Full DDL: [`/migrations/000010_log_events.up.sql`](../../migrations/000010_log_events.up.sql).

### 5.1 Column set

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `uuid` NOT NULL | Leading PK column / tenant prefix; RLS key. No FK to `tenants` (hot-path write cost; tenant validity guaranteed by auth before enqueue). |
| `ts` | `timestamptz` NOT NULL | Event time; the **partition key**. BRIN-indexed. |
| `id` | `uuid` NOT NULL `gen_random_uuid()` | Tie-breaker; second half of the keyset cursor. |
| `service` | `text` NOT NULL | Emitting service; btree-indexed with ts; folded into the FTS vector. |
| `level` | `log_level` enum NOT NULL | `trace<debug<info<warn<error<fatal`; enum order supports `level >= 'warn'`. |
| `message` | `text` NOT NULL | Primary FTS source. |
| `labels` | `jsonb` NOT NULL `{}` | Structured fields/labels; GIN(`jsonb_path_ops`) for `@>` containment. |
| `trace_id`, `span_id` | `text` NULL | Trace correlation; present now so tracing is not precluded (spec). |
| `raw` | `jsonb` NOT NULL `{}` | Original normalized envelope for fidelity/replay. |
| `search` | `tsvector` **GENERATED STORED** | `to_tsvector('english', message || ' ' || service)`; the 2-arg `to_tsvector(regconfig,text)` is IMMUTABLE, so it is valid in a stored generated column (verified). |

Primary key `(tenant_id, ts, id)`: tenant prefix + the partition key (`ts` must be in the PK of
a partitioned table) + uniqueness/cursor tiebreak.

### 5.2 Partitioning scheme & pruning

- **Daily RANGE partitions** on `ts`, named `log_events_YYYYMMDD`, `FOR VALUES FROM (day) TO (day+1)`.
- A **DEFAULT partition** `log_events_default` catches out-of-range rows. In steady state it
  stays empty because partitions are created ahead of time (the ensure job). Caveat noted in the
  migration: a non-empty default blocks attaching an overlapping new partition — the ahead-of-time
  job is what keeps it empty.
- Every tenant query is `tenant_id` + time-range scoped, so the planner **prunes** to the few
  daily partitions the range touches (confirmed by `EXPLAIN`: one partition for a 1-hour range).
  This is what makes p95 < 2s achievable on Postgres regardless of total cluster volume (NFR-1/3).

### 5.3 Indexes (all created on the parent ⇒ auto-applied to every partition)

| Index | Type | Serves |
|---|---|---|
| `(tenant_id, ts, id)` PK | btree | Keyset pagination `ORDER BY ts DESC, id DESC` via backward scan; uniqueness. |
| `idx_log_events_ts_brin` | **BRIN**(`ts`) `pages_per_range=32` | Cheap time-range scan within a partition (ts is append-correlated). |
| `idx_log_events_search` | **GIN**(`search`) | Full-text `@@ websearch_to_tsquery(...)` (verified). |
| `idx_log_events_labels` | **GIN**(`labels jsonb_path_ops`) | Structured label/field `@>` filters (verified). |
| `idx_log_events_svc_ts` | btree(`tenant_id, service, ts DESC`) | Per-service, time-ordered. |
| `idx_log_events_lvl_ts` | btree(`tenant_id, level, ts DESC`) | Per-level (e.g. errors), time-ordered. |

GIN FTS write amplification is the known risk (ADR-0003): mitigate with batched inserts from the
processor, `fastupdate`/`gin_pending_list_limit` tuning, and the tight 30-day hot window. The
escape hatch (ClickHouse behind the `LogStore` port) is pre-committed, not pre-paid.

### 5.4 Keyset pagination (not OFFSET)

```sql
SELECT … FROM log_events
WHERE tenant_id = app.current_tenant_id()
  AND ts >= $from AND ts < $to
  AND (ts, id) < ($cursor_ts, $cursor_id)   -- omit on first page
ORDER BY ts DESC, id DESC
LIMIT $n;
```

Served by a backward scan of the PK index; cost is independent of page depth.

### 5.5 Retention via partition drop (30d)

- `app.drop_log_events_partitions_older_than(p_retention_days int DEFAULT 30)` drops daily
  partitions older than the cutoff in O(1) each — no `DELETE` churn. It matches only
  `log_events_YYYYMMDD` partitions and **never** the default (verified: dropping a 40-day-old
  partition removed exactly it; the default survived).
- **Pooled-store nuance:** partitions are time-only, so the shared drop happens at the **global
  hot horizon** (default 30d). A tenant whose `retention_policies.hot_days` is *shorter* has its
  excess pruned by an optional tenant-scoped `DELETE` (off the hot path) and otherwise relies on
  cold. True per-tenant retention (`cold_days`) is enforced cheaply by S3 prefix delete
  (see [`cold-tier.md`](./cold-tier.md)). This honesty is intentional — see ADR-0005.

### 5.6 Partition creation (ahead of time)

- `app.create_log_events_partition(p_day date)` — idempotent single-day create.
- `app.ensure_log_events_partitions(p_days_ahead int DEFAULT 7)` — ensures today..+N exist; runs
  on a schedule so ingest never falls into the default. The migration bootstraps today..+7 so the
  vertical slice works immediately after `migrate up`.

---

## 6. OAuth identity store — `oauth_identities` in detail (ADR-0007, Google OAuth)

Full DDL: [`/migrations/000017_oauth_identities.up.sql`](../../migrations/000017_oauth_identities.up.sql).
Links an **existing** logalot user to an external OIDC identity (Google in v1).
**Invite-only:** the table never creates a user — a row appears only when a verified
Google `id_token` (`email_verified=true`) matches an already-provisioned user
*inside the tenant carried in the OAuth `state`*. Tenant resolution and the by-sub
lookup are specified in §4.6; the global-uniqueness invariant is the load-bearing
decision below.

### 6.1 Column set

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK `gen_random_uuid()` | Surrogate key. |
| `tenant_id` | `uuid` NOT NULL → `tenants(id)` | RLS key; leading column of the per-tenant uniqueness and the composite user FK. |
| `user_id` | `uuid` NOT NULL | The linked logalot user. Same-tenant integrity enforced via the composite FK below (not a bare `users(id)` FK). |
| `provider` | `oauth_provider` enum NOT NULL DEFAULT `'google'` | House style (enums for closed, load-bearing sets, 000002). Only `'google'` ships; a new provider is one `ALTER TYPE … ADD VALUE`. |
| `provider_sub` | `text` NOT NULL | Google's stable subject (`sub`) — the **authoritative, immutable** identity key after first link. |
| `email` | `text` NOT NULL | **Link-time snapshot** of the matched, app-normalized email. Audit/consistency only — **not** a resolution key (identity is pinned to `sub`, threat model R13). |
| `last_login_at` | `timestamptz` NULL | Bumped on each successful OIDC login (subsequent-login path). |
| `created_at` / `updated_at` | `timestamptz` NOT NULL `now()` | `updated_at` maintained by `trg_oauth_identities_updated` (the shared `app.set_updated_at()` trigger, like `users`). |

### 6.2 Constraints & indexes

| Constraint / index | Purpose |
|---|---|
| `UNIQUE (provider, provider_sub)` — **GLOBAL** | One Google account ↔ exactly one logalot user, **ever**, across all tenants. RLS filters *reads* but **not** unique-index enforcement, so this rejects a duplicate `sub` even against an RLS-invisible tenant's row. Also the index that **backs the by-sub resolver** (point lookup, ≤ 1 row). |
| `UNIQUE (tenant_id, user_id, provider)` | One linked identity per user per provider (tenant-scoped ⇒ RLS-friendly). Expresses the PoC "one Google account per user" intent; relaxable. |
| `FOREIGN KEY (tenant_id, user_id) → users(tenant_id, id)` ON DELETE CASCADE | Same-tenant integrity: a link's tenant must equal the user's home tenant (mirrors `memberships`/`refresh_tokens`); deleting the user removes the link. |
| `tenant_id → tenants(id)` ON DELETE CASCADE | Inline registry FK (matches `refresh_tokens`). |
| *(no bare `(tenant_id)` index)* | `UNIQUE(tenant_id, user_id, provider)` is tenant-leading and serves tenant-scoped scans; a single-column index would only add write cost (same reasoning as `refresh_tokens`). |

RLS is the identical, audited shape (§4.2): `ENABLE` + `FORCE ROW LEVEL SECURITY`,
policy `USING / WITH CHECK (tenant_id = app.current_tenant_id())`. The by-sub
resolver (`app.resolve_oauth_identity_by_sub`, §4.6) is the **only** sanctioned way
to read a row without an armed tenant, and it returns just `(tenant_id, user_id)`.

### 6.3 Email normalization (threat model R14)

`oauth_identities.email` stores the **already-normalized** email (lowercase + trim +
NFC), the *same* normalization user provisioning applies — so the first-link match
`users(tenant_id, normalize(id_token.email))` is apples-to-apples. Normalization
is an **application-layer** responsibility applied identically at provisioning and
at OAuth match; it is **not** enforced in the DDL, consistent with `users.email`
(also plain `text`, normalized in the app). Do not unicode-fold beyond NFC (avoids
false homograph matches). This column is a snapshot, not a key, so it carries no
index and no unique constraint of its own.

### 6.4 The global-uniqueness limitation (PoC, locked)

`UNIQUE(provider, provider_sub)` is **global** by decision. Consequence: a person
who is a member of two tenants (same email → two `users` rows) can Google-login
**only** to the tenant they linked first; the second tenant remains password-only
for that Google account. **Documented future change** (not implemented): to support
multi-tenant membership via one Google account, relax to
`UNIQUE(tenant_id, provider, provider_sub)` and *always* scope resolution by
`state.tenant_id` — at which point the tenant is always known on subsequent login,
and the `SECURITY DEFINER` by-sub resolver (§4.6) can be **dropped** entirely. See
threat model §0 escalation.
