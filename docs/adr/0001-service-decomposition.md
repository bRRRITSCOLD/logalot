# ADR-0001: Service decomposition and bounded contexts

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** systems architect
- **Related:** overview.md §2/§4, ADR-0002, ADR-0004, NFR-1

## Context

Logalot must serve four workloads with very different characteristics on a single cluster:
high-throughput stateless ingest (≥50k events/s/node), CPU-bound async processing, an interactive
read/stream path, and CRUD-heavy administration. We need enough service boundaries to scale and
deploy these independently and to keep tenant isolation tractable — but not so many that we pay a
distributed-systems tax on a single-cluster, non-hyperscale platform. DDD strategic design (bounded
contexts) should drive the seams; KISS/YAGNI should cap the count.

## Decision

Adopt the bounded contexts in overview.md §2 and map them to **six deployable units**:

1. **`ingest-service`** (Go+Gin) — Ingestion context. Stateless, throughput-critical. Auth, validate,
   rate-limit, publish to RabbitMQ. (ADR-0004)
2. **`processor`** (Go worker) — Log Processing context. Consume, normalize, persist to hot store, tee
   to cold, fan out to tail bus, enforce retention partition drop.
3. **`query-service`** (Go, or Node+Fastify) — Log Query context. Full-text + structured + time-range
   search; SSE live tail. (ADR-0006)
4. **`control-plane`** (Node+Fastify) — Identity & Access + Workspace contexts. Tenants, users, API
   keys, RBAC, sessions, dashboards, saved queries, alert-rule CRUD, retention policies. Postgres.
5. **`alert-evaluator`** (Go or Node worker) — Alerting context (evaluation half). Runs saved queries
   on schedule, dispatches via floci SNS/SQS.
6. **`web`** (TanStack Start) — frontend + BFF holding the user session.

Boundaries follow context ownership, not layers. The **Log Storage & Retention** context is a shared
kernel (schema + partitioning) co-owned by `processor` (writer) and `query-service` (reader); it is a
library/contract, not a service. Each service is internally ports-and-adapters: a domain core
depending on ports (`LogStore`, `Broker`, `TailBus`, `ColdArchive`, `KeyStore`, `TenantContext`) with
transport/infra adapters at the edge.

## Status

Accepted. Alerting evaluation and Workspace are in scope but out of the first vertical slice; the slice
ships `ingest-service`, `processor`, `query-service` (tail only), minimal `control-plane` (keys/tenants),
and `web` (live-tail explorer).

## Consequences

### Positive
- Throughput-critical ingest/processing scale and deploy independently of the read path and admin CRUD.
- The shared-kernel storage contract keeps writer and reader in lock-step on the partitioning scheme,
  which is the foundation of tenant isolation (ADR-0002) and search performance (ADR-0003).
- Polyglot-by-fit: Go where throughput/concurrency matters, Node+Fastify where velocity and shared zod
  schemas with the frontend matter — without forcing one runtime everywhere.

### Negative / costs
- Six units + shared kernel is more moving parts than a modular monolith. Mitigated by keeping cross-
  service contracts explicit (RabbitMQ envelope, internal HTTP with tenant scope) and few.
- Polyglot means two toolchains (Go, Node) to maintain.

### Trigger to revisit
- If operational overhead of six units outweighs the isolation/scaling benefit at current scale, collapse
  `query-service`+`control-plane` into one Node service (they share the read/CRUD class). Revisit if team
  size or deploy frequency makes the split a net drag.

## Alternatives considered

| Option | Independent scaling of ingest | Tenant-isolation clarity | Ops simplicity | Verdict |
|---|---|---|---|---|
| **Context-aligned services (chosen)** | High | High | Medium | **Chosen** |
| Modular monolith (one deployable) | Low (can't scale ingest alone) | Medium | High | Rejected — ingest at 50k/s needs to scale separately from CRUD |
| Fine-grained microservices (per context, ~8+) | High | High | Low | Rejected — YAGNI; distributed tax unjustified at single-cluster scale |

- **Modular monolith:** simplest to operate, but the hot ingest path and the long-lived SSE read path
  have incompatible scaling and runtime profiles; coupling them wastes capacity and risks one workload
  starving another.
- **Fine-grained microservices:** over-decomposes (separate dashboard service, separate key service,
  etc.) for a platform that targets a single cluster — pure ceremony.
