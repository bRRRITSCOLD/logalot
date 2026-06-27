# Logalot — Delivery Progress Ledger

Multi-tenant logging platform. Durable resume map for autonomous overnight build.

**Branch:** `feat/logging-platform` · **Repo:** bRRRITSCOLD/logalot (public) · **Started:** 2026-06-26

## Goal (from docs/prompts/1.md)
Multi-tenant logging platform: high-volume ingest, live tail, full-text + structured search, dashboards, alerting. 30-day hot tier + cold tier. Multi-tenancy isolation (data + auth) first-class.

- Local infra via docker-compose: mongodb, postgres, redis, rabbitmq.
- AWS-local: **floci** (NOT localstack). Model AWS-local around floci; track gaps as issues.
- Figma design system + app screens (figma companion authed: Blaine, pro).
- Stack: backend Go+Gin / Node+Fastify / Rust+Axum (ports-and-adapters); frontend TanStack Start + Router + Tailwind/cva + TanStack Form + nuqs + zod@^4.
- Discipline: TDD, DDD, pragmatic SOLID, DRY/KISS/YAGNI. Small revertible PRs, Conventional Commits, squash-merge.

## Tonight's realistic target
- [x] Architecture + ADRs decided (docs/architecture/, docs/adr/0001-0007)
- [ ] Data model + multi-tenant boundaries designed
- [ ] Issues decomposed / sequenced / tracked (GitHub)
- [ ] Docker infra scaffolded
- [ ] Design system + tokens in Figma
- [ ] First vertical slice built+reviewed+merged: ingest → store → live tail

## Environment (verified 2026-06-26)
- docker 29.4.1, compose v5.1.3 · go 1.26.2 · node 25.9.0 / npm 11.12.1 · rust 1.95.0 · pnpm 10.33.2
- gh authed as bRRRITSCOLD (ssh, repo scope) · figma authed (Blaine, pro, write)

## Phase status
- [x] Phase -1: Recon (env, auth, dirs)
- [ ] Phase 0: Frame (spec) — IN PROGRESS
- [ ] Phase 1: Plan & track (issues + roadmap)
- [x] Phase 2: Architecture (C4, ADRs, NFRs)
- [ ] Phase 3: Data (stores, schema, retention, MT boundaries)
- [ ] Phase 4: Build loop (per-issue dispatch → review → merge)
- [ ] Phase 5: Finish (cleanup, handoff)

## Decisions log

### Architecture (Phase 2 — 2026-06-26)
Full detail in `docs/architecture/overview.md`, `docs/architecture/nfr.md`, `docs/adr/`.

- **ADR-0001 Service decomposition** — context-aligned services: `ingest-service` (Go+Gin),
  `processor` (Go worker), `query-service` (Go/Fastify, search+SSE tail), `control-plane`
  (Node+Fastify: tenants/users/keys/RBAC/dashboards/alert-rules/retention), `alert-evaluator`
  (worker), `web` (TanStack Start). Storage&Retention is a shared kernel. Hexagonal throughout.
- **ADR-0002 Multi-tenancy** — **pooled + hard multi-layer enforcement + bridge escape hatch**.
  `TenantContext` mandatory on every port method; tenant from credential, never body. Four
  fail-closed layers: auth → app ports → hot store (partition key + Postgres RLS) → cold store
  (S3 prefix) + tail channel naming.
- **ADR-0003 Hot store (the big one)** — **PostgreSQL**, partitioned by time + `tenant_id` PK
  prefix, BRIN on ts, GIN on tsvector (FTS) + JSONB (structured), RLS backstop, keyset pagination.
  Zero new infra; partition-pruned tenant+time queries meet p95<2s. **Escape hatch: ClickHouse**
  behind the `LogStore` port if search p95>2s / GIN write saturation / footprint pain.
  OpenSearch-via-floci rejected (floci OpenSearch is control-plane stubs only).
- **ADR-0004 Ingest + queue** — **Go+Gin → RabbitMQ** (durable queue, publisher confirms,
  202-after-durable-enqueue, DLX/DLQ, per-tenant Redis rate limit). Kafka is the hard-reason-only
  escape hatch.
- **ADR-0005 Cold tier + retention** — **tee from day 0**: processor → Firehose → S3 **Parquet**,
  keyed `tenant_id=<id>/dt=.../`, Glue-partitioned, Athena query with bound tenant predicate.
  Retention = drop hot time-partitions at 30d; per-tenant cold retention via prefix delete.
  Fallback: direct-write Parquet if Firehose flaky.
- **ADR-0006 Live tail** — **Redis pub/sub (`tail:{tenant_id}`) + SSE**. Slow-consumer drop+gap.
  WebSocket/Redis-Streams are escape hatches.
- **ADR-0007 Authn/authz** — ingest = opaque **hashed API keys** (`lgk_<tenant>_<secret>`,
  SHA-256, Redis-cached 60s); UI = **short-lived JWT + refresh**; RBAC (tenant_admin/member/
  platform_operator); `Authenticator` port leaves room for OIDC later.

### floci gaps to track as GitHub issues
- floci **OpenSearch** = control-plane CRUD/stubs only (no search data plane). No dependency
  (drove ADR-0003 to Postgres). [informational]
- floci **Kinesis Data Streams** unverified — **not used** (broker=RabbitMQ, cold=Firehose).
- floci **Glacier / S3 lifecycle-to-archive** unverified — cold tier stays S3 standard; archive
  tiering deferred behind a trigger. Do NOT substitute localstack.
- floci **Firehose→Parquet + Glue** fidelity unverified — fallback is processor direct-write
  Parquet behind `ColdArchive` port.
- floci **Athena** query-shape coverage unverified — validate cold query templates early; cold
  search feature-flagged until verified.

## Open / blocked
- Validate floci Athena/Firehose/Glue fidelity against our actual cold query templates before
  relying on cold search (tracked above; cold search feature-flagged until then).

## Morning status
- (pending)
