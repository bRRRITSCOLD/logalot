# Logalot — Delivery Roadmap

**Status:** Phase 1 complete (issues decomposed + sequenced) · **Date:** 2026-06-26 · **Owner:** project manager

Resumable mirror of the GitHub issue plan (epic: **#25**), so the build is sequenceable even if
GitHub is unreachable. Authoritative context: `docs/superpowers/specs/logging-platform.md`,
`docs/architecture/overview.md` + ADR-0001..0007, `docs/data/`, `migrations/`. Milestone:
**MVP — vertical slice + platform foundation**.

Every build issue: TDD (unit + Docker-backed integration), ports-and-adapters, multi-tenant
isolation acceptance criteria, one revertible PR per issue, squash-merge. Agent owner is in each
issue body as `Agent:`.

## Wave table

| # | Title | Agent | Wave | Blocked by |
|---|---|---|---|---|
| 1 | infra: docker-compose local stack + Makefile bring-up + README | backend-engineer | 0 | — |
| 2 | infra: monorepo scaffolding (go.work + pnpm) + CI skeleton | backend-engineer | 0 | — |
| 3 | data: golang-migrate runner + NOSUPERUSER logalot_app role + seed | backend-engineer | 0 | #1 |
| 4 | backend: shared Go kernel — TenantContext + ports skeleton | backend-engineer | 0 | #2 |
| 5 | backend: API-key auth — Authenticator/KeyStore (Postgres + Redis cache) | backend-engineer | 1 | #3, #4 |
| 6 | backend: ingest-service POST /v1/ingest (Go+Gin → RabbitMQ) | backend-engineer | 1 | #4, #5, #1 |
| 7 | backend: processor — consume → log_events (RLS) → tail fan-out | backend-engineer | 1 | #3, #4 |
| 8 | backend: query-service live tail GET /v1/tail (SSE via Redis) | backend-engineer | 1 | #4, #5 |
| 9 | backend: vertical-slice e2e wiring + isolation test + demo | backend-engineer | 1 | #6, #7, #8 |
| 10 | backend: search/query API GET /v1/search (FTS+structured+keyset) | backend-engineer | 2 | #8 |
| 11 | backend: control-plane CRUD + RBAC + JWT sessions | backend-engineer | 2 | #3, #4 |
| 12 | backend: per-tenant ingest rate limiting (Redis) | backend-engineer | 2 | #6 |
| 13 | floci-risk: validate Firehose→Parquet + Glue cataloging fidelity | backend-engineer | 3 | #1 |
| 14 | floci-risk: validate Athena query templates + injected tenant projection | backend-engineer | 3 | #1, #13 |
| 15 | floci-risk: confirm Kinesis unused + Glacier/lifecycle deferral | backend-engineer | 3 | #1 |
| 16 | backend: alerting — rule CRUD + evaluator + notification dispatch | backend-engineer | 3 | #10, #11 |
| 17 | backend: cold tier — S3 Parquet tee + Athena query + retention (flagged) | backend-engineer | 3 | #7, #13, #14 |
| 18 | backend: dashboards + saved-queries backend | backend-engineer | 3 | #10, #11 |
| 19 | ux: design system + tokens in Figma | ux-designer | 4 | — |
| 20 | frontend: TanStack Start app scaffold + component library | frontend-engineer | 4 | #19, #11 |
| 21 | frontend: log explorer + live tail page | frontend-engineer | 4 | #20, #8 |
| 22 | frontend: historical search page | frontend-engineer | 4 | #20, #10 |
| 23 | frontend: alert management + tenant/key admin pages | frontend-engineer | 4 | #20, #11, #16 |
| 24 | ux: Code Connect mapping (Figma ↔ React) | ux-designer | 4 | #19, #20 |
| 25 | epic: Logalot platform — master tracker | project manager | — | — |

## Critical path

Longest dependency chain to a complete MVP:

```
#1 → #3 → #5 → #8 → #10 → #16 → #20 → #23
```

(#11 control-plane is a parallel gate that also feeds #16/#20/#23; #4 gates the whole backend.)

Slice critical path (tonight's priority):

```
#1 → #3 → #5 → {#6, #7, #8} → #9
```

## Ready to dispatch now (no open blockers)

- **#1** infra: docker-compose stack — backend-engineer
- **#2** infra: monorepo scaffolding + CI — backend-engineer
- **#19** ux: design system + tokens in Figma — ux-designer (can run fully in parallel with backend)

Closing #1 unblocks #3, #13, #15. Closing #2 unblocks #4. #3 + #4 together unblock the wave-1
vertical slice. #19 + #11 unblock the frontend.

## Wave sequencing summary

- **Wave 0 (foundation):** #1, #2 immediately; #3 (after #1), #4 (after #2). Parallelizable.
- **Wave 1 (vertical slice):** #5 → {#6, #7, #8} → #9. The tonight target.
- **Wave 2 (search + control-plane + rate limit):** #10, #11, #12.
- **Wave 3 (alerting, cold tier, dashboards):** floci validation #13/#14/#15 gate cold tier #17;
  #16, #18 after wave 2.
- **Wave 4 (frontend & design):** #19 design system (start early) → #20 app shell → #21/#22/#23
  feature pages → #24 Code Connect.
