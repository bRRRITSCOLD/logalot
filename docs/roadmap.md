# Logalot — Delivery Roadmap

**Status:** Platform MVP (epic #25) SHIPPED · Google OAuth (#86) + AWS IaC (#87) + User invites (#140) SHIPPED · **Date:** 2026-07-01 · **Owner:** project manager

Resumable mirror of the GitHub issue plan, so the build is sequenceable even if GitHub is
unreachable. Authoritative context: `docs/superpowers/specs/logging-platform.md`,
`docs/architecture/overview.md` + ADR-0001..0013, `docs/data/`, `migrations/`.

This file is a **reconciled status mirror** — cross-checked against `main` and
`gh issue list --state all` on 2026-07-01. GitHub issues remain authoritative for live state.

Every build issue: TDD (unit + Docker-backed integration), ports-and-adapters, multi-tenant
isolation acceptance criteria, one revertible PR per issue, squash-merge. Agent owner is in each
issue body as `Agent:`.

## Delivered epics

| Epic | Title | Issues | Status |
|---|---|---|---|
| **#25** | Logalot platform — master tracker (MVP vertical slice + foundation) | #1–#24 | **DONE** — all shipped except #24 (open, tech-debt) |
| **#86** | Google OAuth sign-in (invite-only, PKCE, control-plane BFF) | #88–#100 + follow-ups | **DONE + CLOSED** |
| **#87** | AWS IaC deployment (cost-first PoC, Terraform + Caddy TLS) | #101–#110 | **DONE + CLOSED** |
| **#140** | User invites (Google-native, invite-only preserved) | #141–#161 (waves 0–5) | **DONE + CLOSED** |

## Platform build (epic #25) — wave table

| # | Title | Agent | Wave | Blocked by | Status |
|---|---|---|---|---|---|
| 1 | infra: docker-compose local stack + Makefile bring-up + README | backend-engineer | 0 | — | ✅ done |
| 2 | infra: monorepo scaffolding (go.work + pnpm) + CI skeleton | backend-engineer | 0 | — | ✅ done |
| 3 | data: golang-migrate runner + NOSUPERUSER logalot_app role + seed | backend-engineer | 0 | #1 | ✅ done |
| 4 | backend: shared Go kernel — TenantContext + ports skeleton | backend-engineer | 0 | #2 | ✅ done |
| 5 | backend: API-key auth — Authenticator/KeyStore (Postgres + Redis cache) | backend-engineer | 1 | #3, #4 | ✅ done |
| 6 | backend: ingest-service POST /v1/ingest (Go+Gin → RabbitMQ) | backend-engineer | 1 | #4, #5, #1 | ✅ done |
| 7 | backend: processor — consume → log_events (RLS) → tail fan-out | backend-engineer | 1 | #3, #4 | ✅ done |
| 8 | backend: query-service live tail GET /v1/tail (SSE via Redis) | backend-engineer | 1 | #4, #5 | ✅ done |
| 9 | backend: vertical-slice e2e wiring + isolation test + demo | backend-engineer | 1 | #6, #7, #8 | ✅ done |
| 10 | backend: search/query API GET /v1/search (FTS+structured+keyset) | backend-engineer | 2 | #8 | ✅ done |
| 11 | backend: control-plane CRUD + RBAC + JWT sessions | backend-engineer | 2 | #3, #4 | ✅ done |
| 12 | backend: per-tenant ingest rate limiting (Redis) | backend-engineer | 2 | #6 | ✅ done |
| 13 | floci-risk: validate Firehose→Parquet + Glue cataloging fidelity | backend-engineer | 3 | #1 | ✅ done |
| 14 | floci-risk: validate Athena query templates + injected tenant projection | backend-engineer | 3 | #1, #13 | ✅ done |
| 15 | floci-risk: confirm Kinesis unused + Glacier/lifecycle deferral | backend-engineer | 3 | #1 | ✅ done |
| 16 | backend: alerting — rule CRUD + evaluator + notification dispatch | backend-engineer | 3 | #10, #11 | ⚠️ done — **email channel is a stub** → follow-up #187 |
| 17 | backend: cold tier — S3 Parquet tee + Athena query + retention (flagged) | backend-engineer | 3 | #7, #13, #14 | ✅ done — cold SEARCH enabled in prod via #108 (`COLD_SEARCH_ENABLED:-true`, `docker-compose.aws.yml`) |
| 18 | backend: dashboards + saved-queries backend | backend-engineer | 3 | #10, #11 | ⚠️ backend done — **no frontend page** → follow-up #186 |
| 19 | ux: design system + tokens in Figma | ux-designer | 4 | — | ✅ done |
| 20 | frontend: TanStack Start app scaffold + component library | frontend-engineer | 4 | #19, #11 | ✅ done |
| 21 | frontend: log explorer + live tail page | frontend-engineer | 4 | #20, #8 | ✅ done |
| 22 | frontend: historical search page | frontend-engineer | 4 | #20, #10 | ✅ done |
| 23 | frontend: alert management + tenant/key admin pages | frontend-engineer | 4 | #20, #11, #16 | ✅ done |
| 24 | ux: Code Connect mapping (Figma ↔ React) | ux-designer | 4 | #19, #20 | 🔓 **OPEN** — blockers closed; tracked tech-debt |
| 25 | epic: Logalot platform — master tracker | project manager | — | — | ✅ closed |

## Outstanding work

Post-delivery reconciliation (2026-07-01) surfaced these tracked items. None block the shipped MVP.

| Issue | Title | Origin | Priority |
|---|---|---|---|
| **#186** | frontend: Dashboards page + panel viz | Core-req gap (#6/#9) — backend #18 shipped, frontend never scheduled. **Highest-value gap.** | High |
| **#187** | backend: real email alert dispatch (retire email-stub) | Core-req gap (#7) — #16 shipped webhook + email-stub. Reuse invites SMTP/MailHog (#159). | Medium |
| **#24** | ux: Code Connect mapping (Figma ↔ React) | Original platform build; blockers closed, deferred as tech-debt. | Low |

### Not a gap (verified done)

- **Cold-tier search (#3/#17):** the code default (`ColdSearchEnabled: false`, `config.go`) is a
  dev default only. Production enables it via `docker-compose.aws.yml:205`
  (`COLD_SEARCH_ENABLED:-true`), flipped by #108 (closed, closes #63 AC#3). Athena/Glue fidelity
  validated by #13/#14. No outstanding work.

## Deferred / YAGNI inventory

Full list in `docs/superpowers/plans/2026-06-30-user-invites-plan.md` §10 and
`docs/superpowers/specs/logging-platform.md` "Out of scope". Highlights: bulk/CSV invites, SES-native
adapter, non-Google OIDC federation, distributed tracing/APM, billing, multi-region, mobile native,
ML/anomaly detection + vector search, richer dashboard panels (heatmap/table/gauge), more alert
channels (Slack/PagerDuty), alert dispatch retry/backoff.

## Critical path (historical — MVP, epic #25)

Longest dependency chain to a complete MVP (all closed):

```
#1 → #3 → #5 → #8 → #10 → #16 → #20 → #23
```

(#11 control-plane was a parallel gate that also fed #16/#20/#23; #4 gated the whole backend.)
