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
- [ ] Architecture + ADRs decided
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
- [ ] Phase 2: Architecture (C4, ADRs, NFRs)
- [ ] Phase 3: Data (stores, schema, retention, MT boundaries)
- [ ] Phase 4: Build loop (per-issue dispatch → review → merge)
- [ ] Phase 5: Finish (cleanup, handoff)

## Decisions log
- (pending)

## Open / blocked
- (none yet)

## Morning status
- (pending)
