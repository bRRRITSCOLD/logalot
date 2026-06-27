# ADR-0003: Hot log store selection

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** systems architect + data architect
- **Related:** spec §Open questions, overview.md §5.2/§6, ADR-0002, ADR-0005, NFR-1, NFR-3
- **This is the load-bearing data decision.**

## Context

The hot tier holds the **30-day searchable window**. It must serve full-text + structured (label/field)
+ time-range search at **p95 < 2s**, while absorbing writes from a pipeline fed by **≥50k events/s per
ingest node**. The platform targets a **credible single cluster, not hyperscale**, and explicitly values
**ops simplicity** and reusing infra already in the stack (Postgres is already required for the control
plane). Queries are **always** `tenant_id` + time-range scoped (ADR-0002), which is the dominant fact for
performance.

Candidate stores (from the spec): Postgres (partitioned + FTS), OpenSearch via floci, MongoDB, columnar
(ClickHouse). Two hard external facts constrain us:

- **floci's OpenSearch is control-plane CRUD/stubs only** — there is no real search data plane behind it.
  An OpenSearch-via-floci hot store is not testable locally and is therefore disqualified for the local-first,
  Docker-backed-integration-test workflow this project mandates. (A self-hosted OpenSearch container would
  be a *different* option — see alternatives.)
- The local infra list is `postgres, mongodb, redis, rabbitmq` (+ floci). Adding a new stateful component
  (ClickHouse, self-hosted OpenSearch) is a real cost we must justify against YAGNI.

## Decision

Use **PostgreSQL as the hot log store**, with a schema purpose-built for tenant-scoped, time-bounded log
search:

- **Partitioning:** declarative range partitioning by **time** (e.g. daily), with `tenant_id` as the
  leading column of the primary key and a sub-partition / list strategy available for bridge tenants
  (ADR-0002). 30-day retention = drop old time partitions (O(1), no `DELETE` churn).
- **Time filtering:** **BRIN** index on `ts` (logs are append-ordered, so the timestamp is highly
  correlated — BRIN is tiny and fast for range scans).
- **Full-text:** a generated `tsvector` column over the message, indexed with **GIN**.
- **Structured fields/labels:** `JSONB` column with a **GIN** index for label/field predicates.
- **Tenant isolation:** `tenant_id` in partition key + PK prefix; **RLS** fail-closed backstop (ADR-0002).
- **Pagination:** **keyset/cursor** on `(ts, id)`, not `OFFSET`.
- **Access behind a port:** all reads/writes go through the `LogStore` port. The Postgres adapter is one
  implementation; this keeps the heavier-store escape hatch a localized change.

Rationale: at this scale, **every** query prunes to a handful of time partitions for **one** tenant, so the
working set per query is small even though the cluster total is large. That is precisely the regime where
Postgres FTS + BRIN + GIN meets p95 < 2s — and it adds **zero new infrastructure** (Postgres is already
running for the control plane), maximizing ops simplicity and local testability.

## Status

Accepted, with an explicit, pre-agreed escalation path (below). MongoDB stays provisioned in compose as a
reserved option but is **not** the hot store.

## Consequences

### Positive
- **Zero new infra**; one database technology for control plane + hot logs → lowest ops burden, simplest
  local `docker compose up`, fully Docker-backed integration tests (satisfies the workflow mandate).
- Mature, well-understood tuning; transactional writes; RLS gives a real fail-closed tenant backstop that
  columnar stores do not offer natively.
- Partition-drop retention is cheap and predictable; tee-to-cold (ADR-0005) keeps hot data bounded.

### Negative / costs
- **GIN FTS write amplification** is the real risk: maintaining `tsvector` GIN indexes under sustained
  high-volume writes is the most likely bottleneck. Mitigations: batch inserts from the processor; tune
  `fastupdate`/`gin_pending_list_limit`; consider deferring/segregating the FTS index per partition;
  keep the hot window tight via aggressive tiering.
- Postgres is not a columnar engine; at the very top of the volume range a single busy tenant could push
  search p95 toward the budget. This is why the store sits behind a port.

### Trigger to revisit (documented escape hatch)
Introduce **ClickHouse** behind the existing `LogStore` port — for all tenants or just hot-volume bridge
tenants — when **any** of:
- sustained search p95 > 2s on a representative seeded 30-day single-tenant dataset, **or**
- processor write throughput saturates on GIN index maintenance below the 50k/s/node target, **or**
- hot storage footprint per tenant makes Postgres operationally painful (columnar compression would
  materially cut cost).

Because reads/writes already route through `LogStore`, this is an adapter swap + backfill, not a redesign.

## Alternatives considered

Criteria: **search perf @ volume**, **write throughput**, **ops simplicity / new infra**, **local
testability (Docker + floci)**, **tenant-isolation primitives**.

| Option | Search perf | Write throughput | Ops simplicity | Local testability | Isolation primitives | Verdict |
|---|---|---|---|---|---|---|
| **Postgres partitioned + FTS (chosen)** | Good (scoped) | Good (FTS risk) | High (no new infra) | High | RLS + partitions | **Chosen** |
| ClickHouse (columnar) | Excellent | Excellent | Low (new infra) | Medium | manual tenant col | Deferred (escape hatch) |
| MongoDB | Medium (weak text rank) | High | Medium (2nd store) | High | manual tenant col | Rejected |
| OpenSearch via floci | n/a (stub) | n/a | n/a | **None** (floci stub) | index-per-tenant | Rejected (not real on floci) |
| Self-hosted OpenSearch (container) | Excellent | High | Low (new infra + JVM) | Medium | index/alias per tenant | Rejected (ops cost) |

- **ClickHouse** is the technically best fit for high-volume log search and is the explicit escape hatch —
  but adding and operating a new stateful columnar store now violates YAGNI/KISS when partition-pruned
  Postgres meets the targets and reuses existing infra. We pre-commit the trigger rather than pre-pay the
  cost.
- **MongoDB** has good write throughput and is already in compose, but its text search ranking is weaker
  than Postgres FTS and it would mean operating a *second* query store alongside Postgres (control plane)
  for no isolation or perf win over the chosen option.
- **OpenSearch via floci** is disqualified: floci provides only OpenSearch control-plane stubs, so it
  cannot back a real search workload or the Docker-backed integration tests this project requires.
- **Self-hosted OpenSearch** would work technically but adds a JVM-heavy operational component and a third
  data system; the perf headroom over partition-pruned Postgres is not needed at single-cluster scale.
