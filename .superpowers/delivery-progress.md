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
- [x] Data model + multi-tenant boundaries designed (docs/data/, migrations/)
- [x] Issues decomposed / sequenced / tracked (GitHub #1-#25; roadmap docs/roadmap.md)
- [ ] Docker infra scaffolded
- [ ] Design system + tokens in Figma
- [ ] First vertical slice built+reviewed+merged: ingest → store → live tail

## Environment (verified 2026-06-26)
- docker 29.4.1, compose v5.1.3 · go 1.26.2 · node 25.9.0 / npm 11.12.1 · rust 1.95.0 · pnpm 10.33.2
- gh authed as bRRRITSCOLD (ssh, repo scope) · figma authed (Blaine, pro, write)

## Phase status
- [x] Phase -1: Recon (env, auth, dirs)
- [x] Phase 0: Frame (spec) — docs/superpowers/specs/logging-platform.md
- [x] Phase 1: Plan & track (issues + roadmap) — DONE (GitHub #1-#25, docs/roadmap.md)
- [x] Phase 2: Architecture (C4, ADRs, NFRs)
- [x] Phase 3: Data (stores, schema, retention, MT boundaries)
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

### Data model (Phase 3 — 2026-06-26)
Full detail in `docs/data/model.md`, `docs/data/cold-tier.md`, `docs/data/migration-plan.md`;
runnable DDL in `migrations/` (applied + rolled back + RLS/partition-tested vs Postgres 16).

- **Stores (polyglot, each justified).** Postgres = control plane + hot log store (ADR-0003).
  Redis = key cache / rate limit / `tail:{tenant_id}` pub/sub. RabbitMQ = ingest pipeline. floci
  S3+Glue+Athena = cold Parquet tier. **MongoDB = reserved/unused (YAGNI)** — Postgres JSONB
  already covers dashboards/saved-queries/labels with transactions + RLS; not forced in.
- **Aggregate→table.** Tenant→`tenants` (registry, no RLS), User→`users`+`memberships` (RBAC),
  ApiKey→`api_keys`, RetentionPolicy→`retention_policies`, SavedQuery→`saved_queries`,
  Dashboard→`dashboards` (panels inline JSONB), AlertRule→`alert_rules` (state embedded),
  LogEvent hot→`log_events` (partitioned), LogEvent cold→S3 Parquet. Cross-aggregate refs by
  identity (no hard FK across roots); FKs only within an aggregate.
- **Tenant isolation = one convention.** Backend sets `SET LOCAL app.tenant_id = '<uuid>'` per
  request (GUC name authoritative, matches ADR-0002/overview). Every tenant-owned table has
  `ENABLE + FORCE ROW LEVEL SECURITY` and policy `USING/WITH CHECK (tenant_id =
  app.current_tenant_id())`. `app.current_tenant_id()` reads the GUC with `current_setting(...,
  true)` → NULL when unset → **fail-closed (zero rows)**. App role must be NOSUPERUSER +
  no BYPASSRLS. Verified: unset⇒0 rows, foreign-tenant INSERT rejected, cross-tenant SELECT⇒0.
- **Hot `log_events`.** PK `(tenant_id, ts, id)`; RANGE-partitioned daily on `ts` (+ DEFAULT
  partition); cols ts/tenant_id/service/level(enum)/message/labels(jsonb)/trace/span/raw +
  GENERATED STORED `search` tsvector. Indexes: BRIN(ts), GIN(search), GIN(labels jsonb_path_ops),
  btree (tenant_id,service,ts) & (tenant_id,level,ts); keyset via PK backward scan. RLS on parent
  governs all partitions; pruning confirmed (1 partition for tenant+1h). No FK to tenants (hot
  write cost; validity from auth).
- **Partition lifecycle.** `app.ensure_log_events_partitions(7)` (create-ahead, daily, idempotent,
  bootstrapped in migration), `app.drop_log_events_partitions_older_than(30)` (O(1) retention,
  never drops default). Pooled time-only partitions ⇒ shared hot horizon; per-tenant shorter hot =
  optional scoped DELETE; true per-tenant retention = cold S3 prefix delete.
- **Cold tier.** `s3://logalot-cold/logs/tenant_id=<uuid>/dt=YYYY-MM-DD/hour=HH/*.parquet`; Glue
  external table partitioned (tenant_id,dt,hour) with **partition projection** —
  `tenant_id` as `injected` so Athena REFUSES a query without the tenant predicate (engine-enforced
  isolation). Tee from day 0 (best-effort, retried). Cold search feature-flagged until floci
  Firehose/Glue/Athena fidelity validated (tracked gap).
- **Migrations.** golang-migrate `000001..000010` (.up/.down), validated up→down→up on PG16. Dev
  seed `migrations/seeds/dev_tenant.sql` (not auto-applied): dev tenant + tenant_admin +
  API key `lgk_dev_devkey001_devsecret0123456789` (hash via pgcrypto digest) + retention.

### Data-model decisions made (call-outs)
- GUC standardized on `app.tenant_id` (not `app.current_tenant`) to match the normative ADRs.
- `tenants` has no RLS (registry; provisioning predates tenant context); ingest key lookup is made
  RLS-scoped by parsing the tenant slug from the key first; alert-evaluator scheduler uses a
  BYPASSRLS role for rule *metadata* only, then re-enters per-tenant context for log reads.
- Hot retention is honestly uniform at the global partition-drop horizon; per-tenant retention is a
  cold-tier responsibility — documented, not hidden.

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

## Issue plan & wave roadmap (Phase 1 — 2026-06-26)

Full table + critical path in `docs/roadmap.md`. Epic master tracker: **#25**. Milestone:
"MVP — vertical slice + platform foundation". Labels created: `wave-0`..`wave-4`, `backend`,
`frontend`, `ux`, `infra`, `data`, `auth`, `multi-tenancy`, `vertical-slice`, `floci-risk`, `epic`.

25 issues created (#1-#24 tasks + #25 epic). All build issues: TDD + multi-tenant isolation
acceptance criteria + one revertible PR each.

- **Wave 0 — foundation (parallelizable):** #1 docker-compose stack (backend-engineer) ·
  #2 monorepo scaffold + CI (backend-engineer) · #3 migrate runner + NOSUPERUSER logalot_app
  + seed (backend-engineer, ⟵#1) · #4 shared Go kernel TenantContext + ports (backend-engineer, ⟵#2).
- **Wave 1 — VERTICAL SLICE:** #5 API-key auth (⟵#3,#4) · #6 ingest-service POST /v1/ingest
  (⟵#4,#5,#1) · #7 processor → log_events(RLS) → tail (⟵#3,#4) · #8 query-service live tail SSE
  (⟵#4,#5) · #9 slice e2e wiring + isolation test + demo (⟵#6,#7,#8). All backend-engineer.
- **Wave 2:** #10 search/query API (⟵#8) · #11 control-plane CRUD+RBAC+JWT (⟵#3,#4) ·
  #12 per-tenant rate limiting (⟵#6). All backend-engineer.
- **Wave 3:** #13 floci Firehose/Glue validate (⟵#1) · #14 floci Athena/projection validate
  (⟵#1,#13) · #15 floci Kinesis/Glacier confirm (⟵#1) · #16 alerting (⟵#10,#11) ·
  #17 cold tier, flagged (⟵#7,#13,#14) · #18 dashboards/saved-queries (⟵#10,#11). All backend-engineer.
- **Wave 4 — frontend & design:** #19 design system + tokens (ux-designer) · #20 TanStack Start
  scaffold + component lib (frontend-engineer, ⟵#19,#11) · #21 log explorer + live tail
  (frontend-engineer, ⟵#20,#8) · #22 search page (frontend-engineer, ⟵#20,#10) · #23 alert + admin
  pages (frontend-engineer, ⟵#20,#11,#16) · #24 Code Connect (ux-designer, ⟵#19,#20).

**Critical path (MVP):** #1 → #3 → #5 → #8 → #10 → #16 → #20 → #23.
**Slice critical path:** #1 → #3 → #5 → {#6,#7,#8} → #9.
**Ready to dispatch now (no blockers):** #1, #2, #19.

## GUARD CAP HIT — merge-to-main requires human approval
The harness auto-mode classifier blocks `gh pr merge ... main` for PRs authored
this session ("[Merge Without Review] ... no human approval"). The prompt
pre-authorized squash-merges, but the harness guard overrides — and the prompt
said to stop at guard caps. **Adaptation:** `feat/logging-platform` is the
integration branch; each issue is built on a sub-branch, staff-reviewed, then
merged into the integration branch via local `git merge` (PRs target the
integration branch for the review trail). PR #27 (`feat/logging-platform` ->
main) is the single deliverable for the user to review + squash-merge in the
morning. **Nothing reaches `main` without the user.** Slice still gets built +
reviewed + composed + verified end-to-end on the integration branch.

## Build loop progress (Phase 4)
- #1 docker-compose stack — PR #26, staff APPROVE. Integrating onto feat/logging-platform.

## Open / blocked
- Merge-to-main gated on user (guard cap above).
- Validate floci Athena/Firehose/Glue fidelity against our actual cold query templates before
  relying on cold search (tracked above; cold search feature-flagged until then).

## Morning status
- (pending)
