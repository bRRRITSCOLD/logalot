# Logalot — Non-Functional Requirements

**Status:** Accepted (Phase 2) · **Date:** 2026-06-26 · **Owner:** systems architect

Targets are drawn from the spec and tuned for a **credible single-cluster self-hosted
deployment, not hyperscale**. Each NFR states a concrete target, how the architecture meets it,
and (where relevant) the fitness function / test that guards it continuously.

## Capacity model (sizing baseline)

Assumptions used throughout this document, stated so they can be challenged:

- Mean event size ≈ 1 KB (JSON line + labels/fields). p99 ≈ 4 KB.
- Ingest target: **≥ 50k events/s per ingest node**, horizontally scalable by adding nodes.
- 50k events/s × 1 KB ≈ **50 MB/s per node** of raw intake.
- Per-tenant queries are **always** time-range + `tenant_id` scoped (no platform-wide scans).
- Hot window = 30 days, but hot store holds **searchable** data; the durable archive is the cold
  tier, written from day 0 (tee). Hot partitions are dropped at the per-tenant retention edge.

---

## NFR-1 Scalability

| # | Requirement | Target |
|---|---|---|
| 1.1 | Sustained ingest | ≥ 50k events/s per node, horizontally scalable |
| 1.2 | Tenants per cluster | hundreds of small/medium tenants on shared (pooled) infra |
| 1.3 | Hot search volume | tens of GB–low TB per active tenant over 30d, p95 < 2s |

**How the architecture meets it.**
- Ingest is **stateless** (Go+Gin) and scales horizontally behind a load balancer; durability is
  delegated to RabbitMQ, so adding ingest nodes adds throughput linearly (ADR-0004).
- The pipeline is **decoupled** (queue between intake and persistence), so ingest spikes are
  absorbed as queue depth rather than dropped or back-pressured to the client immediately
  (backpressure becomes 429 only when the queue/rate-limit thresholds are crossed).
- Processors scale horizontally by adding consumers to the RabbitMQ work queue (competing
  consumers, manual ack, prefetch tuned).
- Hot store is **partitioned by `tenant_id` + time** so each tenant's data and each time window
  are physically separate; queries prune to a handful of partitions regardless of total cluster
  size (ADR-0003). This keeps per-tenant query cost independent of other tenants' volume.
- **Scale trigger (documented escape hatch):** if a single tenant's hot volume or aggregate FTS
  write amplification makes Postgres the bottleneck (sustained search p95 > 2s or processor write
  saturation on GIN maintenance), introduce ClickHouse behind the existing `LogStore` port for
  that tier — the hexagonal boundary makes this a localized change (ADR-0003 §Consequences).

**Fitness function:** load test asserting 50k events/s/node sustained for 10 min with queue depth
returning to baseline; search p95 over a seeded 30d/active-tenant dataset < 2s.

---

## NFR-2 Availability

| # | Requirement | Target |
|---|---|---|
| 2.1 | Ingest durability | No acknowledged event lost; `202` only after durable enqueue |
| 2.2 | Pipeline resilience | Transient failures retried; poison messages → DLQ, not blocking |
| 2.3 | Graceful degradation | Cold-tier or live-tail outage must not stop ingest or hot search |

**How the architecture meets it.**
- `ingest-service` returns `202` **only after** RabbitMQ confirms a persistent publish; an event
  is never acknowledged to the client while only in memory (ADR-0004).
- Processor uses **manual ack + bounded retries + DLQ**; a malformed or repeatedly failing message
  is parked in the DLQ for inspection instead of head-of-line blocking the queue.
- **Failure isolation:** the cold-tier tee (Firehose) and live-tail publish (Redis) are best-effort
  side-effects of processing; their failure is logged/metered and retried but does **not** fail the
  hot-store write or the message ack. Hot search and ingest remain available if floci/Redis are down.
- Single-cluster scope means we target component-level resilience (retries, DLQ, statelessness),
  **not** multi-region failover (explicitly out of scope per spec). RTO/RPO are framed around
  RabbitMQ durability + Postgres backups, not cross-region replication.

**Fitness function:** chaos integration test — kill a processor mid-batch and assert no acked-but-
unpersisted loss; stop floci and assert ingest + hot search still succeed.

---

## NFR-3 Latency

| # | Requirement | Target |
|---|---|---|
| 3.1 | Search (hot window) | p95 < 2s |
| 3.2 | Live tail end-to-end | < 2s from ingest to browser |
| 3.3 | Ingest accept | p95 < 50ms to `202` (enqueue only) |
| 3.4 | Alert evaluation | < 30s |

**How the architecture meets it.**
- **Search (3.1):** partition pruning on `tenant_id`+time, BRIN index on `ts` (cheap, correlated),
  GIN on `tsvector` for full-text and on JSONB for structured fields. Pagination via keyset
  (cursor) not OFFSET. Hot queries never cross into cold unless the time range demands it
  (ADR-0003).
- **Live tail (3.2):** processor publishes to Redis pub/sub immediately after the hot write;
  `query-service` streams via SSE. The path ingest→queue→process→publish→SSE is sub-second under
  normal load; the 2s budget absorbs queue dwell + fan-out (ADR-0006).
- **Ingest accept (3.3):** the hot path does auth (Redis-cached key lookup, constant-time compare),
  validate, publish — no synchronous DB write of the log itself. Key validation is cached in Redis
  (60s TTL) to keep the per-request cost off Postgres.
- **Alert eval (3.4):** evaluator runs each rule's saved query on a schedule ≤ 30s; queries are the
  same partition-pruned hot queries, so each evaluation is sub-second, leaving headroom.

**Fitness function:** end-to-end test posting an event and asserting it appears in an open SSE tail
within 2s; search latency assertion as in NFR-1.

---

## NFR-4 Cost

| # | Requirement | Target |
|---|---|---|
| 4.1 | Avoid SaaS pricing | Self-hostable on commodity infra; no per-GB SaaS fees |
| 4.2 | Cheap long-term retention | Cold tier on object storage, columnar Parquet, query-on-demand |
| 4.3 | Operational simplicity | Reuse infra already in the stack before adding new components |

**How the architecture meets it.**
- Hot tier reuses **Postgres** (already required for the control plane) instead of standing up and
  operating a separate search cluster — lower ops cost and one fewer system to run (ADR-0003).
- Cold tier is **S3 + Parquet + Athena**: storage is cheap and pay-per-scan query means we pay for
  cold search only when someone runs it. Parquet columnar layout + partition pruning by
  `tenant_id`/date minimizes bytes scanned (ADR-0005).
- Tee-to-cold from day 0 means the expensive hot store holds only the 30-day window; everything
  older lives cheaply in S3. Hot partition drop at retention edge reclaims space automatically.
- **YAGNI on infra:** RabbitMQ (already chosen) is the broker; Redis (already present) is the tail
  bus and cache. No Kafka/Kinesis introduced (ADR-0004, ADR-0006).

---

## NFR-5 Security

| # | Requirement | Target |
|---|---|---|
| 5.1 | Ingest auth | Opaque, hashed API keys; never stored in plaintext |
| 5.2 | UI auth | Short-lived session JWT + refresh; RBAC |
| 5.3 | No credential leakage | Keys shown once at creation; logged/compared safely |
| 5.4 | Authorization | Role-gated actions (tenant_admin / member / platform_operator) |
| 5.5 | Extensibility | Auth designed to add SSO/OIDC later without rework |

**How the architecture meets it (ADR-0007).**
- API keys are random high-entropy secrets formatted `lgk_<tenantPublicId>_<secret>`; only a SHA-256
  hash + a `key_id` are stored. Lookup is by `key_id`; the secret is compared in constant time. The
  plaintext is returned exactly once at creation.
- UI sessions use short-lived signed JWTs (tenant_id + role + scopes claims) with refresh; the BFF
  holds the token. Verification runs in edge middleware before any handler.
- RBAC: `tenant_admin` (manage keys/users/retention/alerts), `member` (search/tail/dashboards/alert
  authoring per policy), `platform_operator` (platform-scope health/usage only — never tenant log
  content). Authorization is checked at the edge and re-asserted in the domain for sensitive
  commands.
- Identity model is isolated in the **Identity & Access** context behind a `Principal`/`TenantContext`
  abstraction, so an OIDC adapter can be added later without touching downstream contexts.

---

## NFR-6 Multi-tenant isolation (first-class)

| # | Requirement | Target |
|---|---|---|
| 6.1 | Cross-tenant leakage | **Zero** — enforced at auth + query + storage (defense in depth) |
| 6.2 | Tenant context | Mandatory on every command/query; no global/un-scoped API |
| 6.3 | Storage scoping | `tenant_id` as partition/shard key + cold-tier S3 prefix |
| 6.4 | Backstop | Fail-closed if tenant context is missing |

**How the architecture meets it (ADR-0002, and overview.md §6).**
- Four independent enforcement layers: auth credential→single tenant; application ports require
  `TenantContext`; hot store partitions on `tenant_id` with **RLS fail-closed** backstop; cold store
  partitions on `tenant_id` S3 prefix. Live-tail channels are tenant-named.
- Tenant identity comes from the **authenticated credential**, never the request body.
- **Fitness functions (continuous):**
  - Integration test: ingest for tenant A; assert absent from B's search and B's tail.
  - Storage test: with `app.tenant_id` unset, assert hot queries return zero rows (RLS fail-closed).
  - Contract test: assert no `LogStore`/repository method exists without a `TenantContext` parameter
    (architectural lint).
  - Cold test: assert generated Athena SQL always contains the `tenant_id=<ctx>` partition predicate.

---

## NFR-7 Observability & operability (platform-operator outcomes)

| # | Requirement | Target |
|---|---|---|
| 7.1 | Ingest health | Per-node throughput, queue depth, DLQ size visible |
| 7.2 | Per-tenant usage | Events/s, hot bytes, query volume per tenant |
| 7.3 | One-command bring-up | `docker compose up` brings up all infra; integration tests pass |

**How the architecture meets it.**
- Each service exposes health + metrics endpoints; RabbitMQ management, queue depth, and DLQ size
  are first-class operator signals. Per-tenant counters are emitted with `tenant_id` as a label
  (cardinality bounded by tenant count, which is in the hundreds — acceptable).
- The platform-operator role sees aggregate/health data only and is structurally barred from tenant
  log content (NFR-5.4).

---

## floci gaps / tracked risks

These are tracked as GitHub issues; the architecture is designed to **not depend** on the unverified
capabilities.

| Risk | Status | Mitigation / decision |
|---|---|---|
| floci **OpenSearch** is control-plane CRUD/stubs only (no real search data plane) | Confirmed limitation | Hot store is self-hosted Postgres, not OpenSearch-via-floci (ADR-0003). No dependency. |
| floci **Kinesis Data Streams** support unverified | Tracked risk | Not used. Broker is RabbitMQ; cold buffering is Firehose (ADR-0004, ADR-0005). |
| floci **Glacier** / S3 lifecycle-to-archive support unverified | Tracked risk | Cold tier targets S3 standard only for now; tiering-to-archive is a future optimization. Default: keep cold in S3; **trigger to revisit** = cold storage cost becomes material. Do **not** silently substitute localstack. |
| floci **Firehose → Parquet conversion + Glue** fidelity unverified at volume | Tracked risk | Fallback: processor batches and writes Parquet to S3 directly (skip Firehose) behind the same `ColdArchive` port. Localized change (ADR-0005). |
| floci **Athena** SQL coverage for our query shapes unverified | Tracked risk | Validate the specific query templates in integration tests early; cold query feature-flagged until verified. |
