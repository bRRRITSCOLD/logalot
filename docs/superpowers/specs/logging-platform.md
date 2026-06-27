# Spec — Logalot: Multi-Tenant Logging Platform

**Status:** Draft (Phase 0 — Frame) · **Date:** 2026-06-26 · **Owner:** autonomous delivery

## Problem statement
Engineering teams need a self-hostable observability logging platform — high-volume ingest, live tail, full-text + structured search, dashboards, and alerting — with strict multi-tenant isolation, without paying SaaS (Datadog/Splunk) prices. Tenancy isolation (data + auth) is a first-class architectural concern, not an afterthought.

## Target users / outcomes
- **Tenant admin** — provisions the tenant, manages API keys/users, sets retention & alert policies.
- **Engineer (tenant member)** — ships logs from services; searches, live-tails, builds dashboards, defines alerts.
- **Platform operator** — runs the platform; observes ingest health, capacity, per-tenant usage.

System outcomes (targets, tuned for a credible single-cluster deployment, not hyperscale):
- Ingest sustained ≥ 50k events/s per node; horizontally scalable.
- p95 search latency < 2s over the 30-day hot window.
- Live tail end-to-end latency < 2s from ingest to browser.
- Alert evaluation latency < 30s.
- **Zero cross-tenant data leakage** — enforced at storage + query + auth layers (defense in depth).

## In scope
1. **Ingest** — authenticated HTTP (and optionally bulk/NDJSON) ingest endpoint; per-tenant API keys; backpressure; validation; enqueue to broker.
2. **Pipeline** — durable queue (RabbitMQ) → processor → indexed store. Retry/DLQ.
3. **Storage & retention** — 30-day hot tier (searchable) + cold tier (cheap object storage via floci S3, queryable via Athena). Per-tenant retention policy.
4. **Search** — full-text + structured (label/field) + time-range filters; pagination.
5. **Live tail** — streaming (SSE/WebSocket) of matching logs in near-real-time, tenant-scoped.
6. **Dashboards** — saved queries + simple time-series/count visualizations per tenant.
7. **Alerting** — threshold/rate rules over log queries; notification dispatch (webhook/email-stub); alert state.
8. **Multi-tenancy** — tenant model, isolation strategy (data partitioning + row/index scoping), authn/authz (tenant-scoped API keys + user sessions + RBAC).
9. **Frontend** — responsive (desktop/tablet/mobile) TanStack Start app: log explorer (search + live tail), dashboards, alert management, tenant/key admin. Built from a Figma design system.
10. **Local infra** — docker-compose: mongodb, postgres, redis, rabbitmq, floci (AWS-local). Reproducible one-command local bring-up.

## Out of scope (YAGNI for now — track if needed)
- Distributed tracing, metrics/APM, synthetic monitoring.
- Billing/metering & payment.
- SSO/SAML/OIDC federation (start with local users + API keys; design auth to allow it later).
- Multi-region / cross-region replication.
- Mobile native apps (responsive web only).
- ML/anomaly detection, log-based semantic/vector search (design schema to not preclude it).

## Multi-tenancy decisions to make (architecture phase)
- Isolation model: pooled (shared store + tenant_id scoping) vs siloed (per-tenant store/index) vs bridge. Likely **pooled with hard query-layer enforcement + per-tenant cold-tier prefixes**, justified by cost/ops at this scale; revisit per-tenant siloing for large tenants.
- Tenant context propagation: from auth → every query/command (no implicit global queries).
- Storage enforcement: tenant_id as mandatory partition/shard key + cold-tier S3 key prefix per tenant.

## Tech direction (defaults; architect confirms with ADRs)
- **Backend:** ports-and-adapters. Ingest service throughput-critical → **Go + Gin**. Other services (query/api, alerting, control-plane) Go or Node+Fastify per fit.
- **Stores:** postgres (control plane: tenants, users, api keys, alert rules, dashboards, saved queries), the hot search/log store (architect+data to choose — candidates: postgres FTS/partitioned, OpenSearch via floci, or a columnar store), redis (cache, live-tail fan-out, rate limiting), rabbitmq (ingest pipeline), floci S3 (cold tier), floci Athena (cold query).
- **Frontend:** TanStack Start + Router + Tailwind/cva + TanStack Form + nuqs + zod@^4.
- **AWS-local:** floci (S3, Athena, SQS/SNS for alerting dispatch as needed).

## First vertical slice (tonight's build target)
**Ingest → store → live tail**, tenant-scoped end to end:
- `POST /v1/ingest` (Go+Gin) with tenant API-key auth → validate → publish to RabbitMQ.
- Processor: consume → persist to hot store with tenant_id.
- Live tail: `GET /v1/tail` (SSE) streaming new tenant-scoped logs (via redis pub/sub fan-out).
- Minimal frontend log explorer showing live tail for the authed tenant.
- Tests at unit + integration tiers (Docker-backed); TDD throughout.

## Acceptance criteria (slice)
- Ingesting a log for tenant A never appears in tenant B's tail or search.
- Invalid/unauthenticated ingest is rejected with correct status.
- A log POSTed appears in the live tail within 2s.
- `docker compose up` brings up all infra; integration tests pass against it.

## Open questions (resolve in architecture/data phases)
- Hot store choice: postgres-partitioned FTS vs OpenSearch (floci-backed) vs columnar. Tradeoff: ops simplicity vs search performance at volume.
- Does floci support the chosen hot store adequately, or is hot store self-hosted (mongodb/postgres) with floci only for cold tier? (Likely: hot = self-hosted, cold = floci S3/Athena.)
- Auth token format: opaque API keys (hashed) for ingest; session/JWT for UI.
- Confirm floci Kinesis/Glacier support or design around S3+Athena only.
