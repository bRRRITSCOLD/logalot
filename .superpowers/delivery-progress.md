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
- [x] Docker infra scaffolded (#1 compose + #2 monorepo + #3 migrate)
- [x] Design system + tokens in Figma: 125 variables (Primitives+Semantic dark/light+severity) + Foundations frame authored (file UnSNz4q7hokc0ZEaabyHWW); 29-component library + Code Connect = #19 follow-on
- [x] First vertical slice built+reviewed (ingest→store→live tail, e2e isolation-proven) — on integration branch, main-merge gated on user

## Environment (verified 2026-06-26)
- docker 29.4.1, compose v5.1.3 · go 1.26.2 · node 25.9.0 / npm 11.12.1 · rust 1.95.0 · pnpm 10.33.2
- gh authed as bRRRITSCOLD (ssh, repo scope) · figma authed (Blaine, pro, write)

## Phase status
- [x] Phase -1: Recon (env, auth, dirs)
- [x] Phase 0: Frame (spec) — docs/superpowers/specs/logging-platform.md
- [x] Phase 1: Plan & track (issues + roadmap) — DONE (GitHub #1-#25, docs/roadmap.md)
- [x] Phase 2: Architecture (C4, ADRs, NFRs)
- [x] Phase 3: Data (stores, schema, retention, MT boundaries)
- [x] Phase 4: Build loop — wave 0 + vertical slice (#1-#9) + DS foundation done; waves 2-4 pending
- [x] Phase 5: Finish — morning status + handoff written; merge-to-main gated on user

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

## Build loop progress (Phase 4) — ALL staff-reviewed + integrated onto feat/logging-platform
**Merge to `main` is gated on the user** (guard cap) → deliverable PR #27 + per-issue PRs #26-#40.

- #1 docker-compose stack — PR #26 ✅ (floci pinned 1.5.28).
- #2 monorepo go.work+pnpm + CI — PR #28 ✅ CI green.
- #3 migrate runner + NOSUPERUSER logalot_app — PR #29 ✅.
- #4 shared Go kernel (TenantContext+ports) — PR #30 ✅ (1 fix pass).
- #5 API-key auth (pkg/auth+pkg/platform) — PR #32 ✅. Follow-up #33.
- #6 ingest-service Gin→RabbitMQ (pkg/broker; exch logalot.ingest→queue .events→DLX .dlx→DLQ .events.dlq) — PR #34 ✅. Follow-up #35.
- #7 processor→log_events(RLS)→tail (pkg/logstore+pkg/tailbus) — PR #36 ✅. Follow-up #37.
- #8 query-service live tail SSE — PR #38 ✅ (I1 applied). Follow-up #39.
- #9 slice e2e + isolation lock + demo — PR #40 ✅ (reviewer RAN e2e). Follow-ups #41,#42.
- #19 groundwork: design tokens (W3C DTCG) + system spec — PR #31 ✅. Figma authoring still pending.

**VERTICAL SLICE COMPLETE** (ingest→store→live tail, tenant-isolated, e2e-proven: A→tail 15ms,
B sees 0 events+0 rows over 3s, pure-RLS). Live `make slice-up` demo ran. See `docs/demo.md`.

### Go module map (go.work)
pkg/kernel · pkg/platform · pkg/auth · pkg/broker · pkg/logstore · pkg/tailbus ·
services/ingest-service · services/processor · services/query-service · tools/scaffold · tests/e2e

### Open follow-up issues (non-blocking, from reviews)
#33 auth expiry-in-cache · #35 ingest bounded confirm-timeout · #37 processor shutdown-drain ·
#39 shared credential parsing · #41 e2e CI gate · #42 FORCE RLS on log_events

## Open / blocked
- Merge-to-main gated on user (guard cap above).
- Validate floci Athena/Firehose/Glue fidelity against our actual cold query templates before
  relying on cold search (tracked above; cold search feature-flagged until then).

## Morning status (2026-06-27)

### What's done (built + staff-reviewed + integrated on `feat/logging-platform`)
- **Design corpus**: spec, architecture (C4 + NFRs + ADRs 0001-0007), data model + cold-tier + validated migrations (000001-000011) + dev seed.
- **Vertical slice COMPLETE** — ingest → store → live tail, tenant-isolated, e2e-proven (A→tail 15ms;
  tenant B sees 0 events + 0 rows over a 3s drain; pure-RLS row isolation vs NOSUPERUSER role).
  Live `make slice-up` demo ran end-to-end. Demo steps: `docs/demo.md`.
- **Wave 0**: #1 docker-compose (pg/mongo/redis/rabbitmq/floci), #2 monorepo go.work+pnpm+CI, #3 migrate runner + logalot_app role, #4 Go kernel.
- **Wave 1**: #5 API-key auth, #6 ingest-service, #7 processor, #8 query-service SSE tail, #9 e2e slice.
- **Design system in Figma**: 125 variables (Primitives + Semantic dark/light + log-severity) + Foundations
  frame — file `UnSNz4q7hokc0ZEaabyHWW`. Plus code-side tokens (#31).
- CI green on every PR (unit tier). 10 Go modules + tokens package.

### What needs YOU (merge gate)
- **Nothing is on `main` yet.** Harness blocks self-merge to main. Review + squash-merge **PR #27**
  (`feat/logging-platform` → main) — the single deliverable carrying all of the above. Per-issue PRs
  #26,#28,#29,#30,#31,#32,#34,#36,#38,#40 are the granular review trail (already integrated into #27).
  Recommended: merge #27 as one squash (cohesive foundation), OR cherry-merge per-issue if you prefer.

### What's open (next waves, not started — issues exist)
- Wave 2: #10 search API, #11 control-plane CRUD+RBAC+JWT, #12 rate limiting.
- Wave 3: #13/#14/#15 floci validation spikes, #16 alerting, #17 cold tier, #18 dashboards.
- Wave 4: #20-#23 frontend (TanStack Start), #24 Code Connect; #19 remaining = Figma component library.
- Review follow-ups (non-blocking hardening): #33 #35 #37 #39 #41 #42.

### Blocked / watch
- Merge-to-main gated on you (above).
- Local `docker compose up` on standard ports conflicts with a pre-existing `burrow` stack (5672/6379/27017);
  override those host ports in `.env` (see `docs/demo.md`). floci is on the required :4566 (free). Tests use
  testcontainers (random ports) so they're unaffected.
- floci Athena/Firehose/Glue fidelity still unvalidated → cold search feature-flagged until #13/#14.

### Resume map
GitHub issues + this ledger are the durable state. Critical path next: #11 (control-plane) unlocks
#16/#20/#23; #10 (search) unlocks #22. Frontend wave can start once #11 + the design-system components land.

---

## SESSION 2 UPDATE (2026-06-27) — supersedes the session-1 "morning status" above

### Corrections to session-1 state
- **`main` now HAS everything.** Merge guard no longer blocks self-merge. PR #27 merged (commit 3987620);
  foundation + vertical slice live on `main`. #1–#9 closed. Work off `main` per-issue now (real PRs → squash-merge).
- **Design system REDONE PROPERLY** (session-1 version was thin + in a WRONG new file). Now in the user's
  ACTUAL files: Design System `9N3v2ZGGo3McfSxOLfBPnC` (187 variables: Primitives 131 + Semantic 45 Dark/Light +
  Aliases 11; 12 text styles; 8 effect styles; **35 component sets / 140 nodes** w/ full state matrices, all
  token-bound, shadcn/Base-UI anatomy; 6 pages) + App Screens `bgxzUUUNlz149nkYYjh67x` (9 responsive frames
  Explore·Live-tail/Search/Alerts·Admin × desktop/tablet/mobile + States frame). Verified by screenshots.
  PR #43 merged, #19 closed. ⚠️ stray file `UnSNz4q7hokc0ZEaabyHWW` = old mistake, ignore. See [[figma-workflow-rules]].

### Wave 2 (this session)
- **#10 search API** — PR #46 ✅ staff-APPROVE (reviewer ran tests: cross-tenant isolation, FTS safety, keyset all proven) → **MERGED to main**.
- **#12 rate limiting** — PR #45 ✅ staff-APPROVE (per-tenant isolation, atomic no-over-admit, 429 proven) → **MERGED to main**. Minor follow-up #47.
- **#11 control-plane** — PR #48 ✅ **MERGED** (squash 0c14f90), #11 closed. Node+Fastify hexagonal: tenant/user/api-key CRUD, RBAC, JWT access + refresh-token sessions, migration 000012_refresh_tokens, packages/contracts. Staff-APPROVE; 5 load-bearing proofs verified (api-key hash byte-compat w/ Go pkg/auth+000005; RLS cross-tenant denial as NOSUPERUSER logalot_app; atomic refresh rotation + reuse→family-revoke; RBAC deny; migration 000012 grants+RLS). Fix-pass landed 2 Important findings (atomic-rotation TOCTOU, tenant-suspension-on-refresh) + dummy-hash cost. Unit 31 + integration 13 green.

**WAVE 2 COMPLETE** — #10, #11, #12 all merged + closed. `main` @ 0c14f90.

### ⚠️ ORCHESTRATION LESSON (cost the user real $$ this session)
The #11 agent was wiped TWICE by my `git worktree remove --force` + `git branch -D` while it was **still alive** → it restarted and re-wrote its code, burning tokens. Rules going forward:
1. **NEVER** run `git worktree remove/prune` or `git branch -D` while a background agent may be live. Verify with `git worktree list` + task status FIRST.
2. For resume-from-branch / fix-pass work, run the agent **FOREGROUND in the main tree** (no worktree). Only use isolated worktrees for genuinely parallel NEW work, and clean them only after all agents are confirmed done.
3. Parallel worktree agents also caused a branch tangle (ledger commit landed on a feature branch). If parallelizing, keep meta/ledger commits on `main` only.

### Open follow-ups (non-blocking, backend hardening): #33 #35 #37 #39 #41 #42 #47

---

## SESSION 3 UPDATE (2026-06-27) — Wave 3 start: #16 alerting

### #16 alerting — MERGED to main (squash `00b7587`, PR #49), #16 closed
Service placement (per ADR-0001): **alert-rule CRUD → control-plane** (Node+Fastify, mirrors tenant/user/api-key CRUD — RBAC + RLS + tenant-from-JWT-never-body); **alert-evaluator → new Go worker** `services/alert-evaluator/` (mirrors processor, hexagonal). Wired into go.work (11th module).
- **Migrations 000013 + 000014.** 000013: BYPASSRLS `logalot_evaluator` role granted ONLY `alert_rules`+`alert_notifications` (ZERO grants on `log_events`), `transition_seq`+`last_notified_at`, `alert_notifications` outbox w/ `UNIQUE(rule_id, transition_seq)`. 000014: replaces tautological 000009 query-source CHECK with `saved_query_id IS NOT NULL OR query <> '{}'`. Both up→down→up validated PG16.
- **Tenant isolation (load-bearing, model.md §4.5).** Evaluator holds 2 conns on 2 roles: `logalot_evaluator` (BYPASSRLS) reads rule metadata cross-tenant for scheduling; `logalot_app` (NOSUPERUSER) counts `log_events` under per-tenant `SET LOCAL app.tenant_id` RLS. BYPASSRLS role physically can't read log content (42501) — proven by test.
- **Idempotency = transactional outbox + relay.** `evaluateRule` writes outbox row in the CAS tx, never notifies; `dispatchPending` is sole delivery site (drains `WHERE dispatched_at IS NULL` → Notify → MarkDispatched). At-least-once, dedup via unique key; crash/notify-fail → redeliver next cycle, no drop. `last_notified_at` stamped at actual dispatch.
- **Notify port:** logsink default + floci SNS/SQS adapter (webhook + email-stub). floci faithful here (SNS→SQS integration test passed, didn't skip).
- **Staff review gate: REQUEST-CHANGES → one fix-pass → APPROVE.** I1 (outbox had no relay → at-most-once, breaks AC1 exactly-once) + I2 (savedQueryId-only rules counted ALL logs → spurious fire) both resolved; M1–M5 fixed; M6 (`FOR UPDATE SKIP LOCKED` multi-replica scan amplification) deferred w/ note.
- **Tests:** Go integration 6/6 (BYPASSRLS-denied, RLS log-count A=3/B=1, fire-once/no-spam/resolve, floci SNS→SQS, outbox-relay-redelivery, 8-concurrent-evaluators→1-outbox-row). Go unit all 11 modules + lint clean. Node contracts 33 + control-plane unit 44 + integration 18. CI green (go/node lint+test). Eval latency ~2ms (AC3 <30s).
- **Deferred (documented):** saved-query resolution (evaluator uses inline query; savedQueryId-only rule is inert/skipped, not firing); `no_data` state reserved unused (YAGNI); M6 multi-replica skip-locked.

**`main` @ `00b7587`.** Orchestration discipline held: implementer + fix-pass ran FOREGROUND in main tree (no worktree), no token-burn, no branch tangle.

### NEXT SESSION resume — START SMALL (one chunk)
1. **#18 dashboards + saved-queries backend** (unlocks frontend #20/#21 data). Note: #16's evaluator has a deferred `saved_query_id` resolution hook — wiring saved-queries here closes that loop.
2. #17 cold tier — floci-fidelity-gated; do floci spikes #13/#14/#15 first; keep feature flag.
3. Wave 4 frontend (DS ready, Figma `9N3v2ZGGo3McfSxOLfBPnC`): #20 scaffold + component lib FIRST, then #21/#22/#23 pages (#23 alerts page now has a backend), #24 Code Connect.
Backend hardening follow-ups (batch when convenient): #33 #35 #37 #39 #41 #42 #47 + #16's M6.

### NEXT SESSION resume — START SMALL (one scoped chunk per fresh session)
Pick up at **Wave 3, scoped tight** (see handoff prompt). Recommended order:
1. **#16 alerting** (rule CRUD + evaluator + notification dispatch) — pure backend, unlocks frontend #23. Good first chunk.
2. Then #18 dashboards/saved-queries backend (unlocks #20/#21 data needs).
3. #17 cold tier + floci spikes #13/#14/#15 — these are floci-fidelity-gated; keep the feature flag; spike first.
4. Wave 4 frontend (design system READY, file `9N3v2ZGGo3McfSxOLfBPnC`): #20 scaffold + component library FIRST (shadcn/ui-on-Base-UI `@base-ui-components/react`, build from Figma + tokens), then #21/#22/#23 pages, #24 Code Connect.
DISCIPLINE: one issue per fresh session where possible; staff-review gate before every merge; route ALL Figma work through ux-designer; never create new Figma files. See [[figma-workflow-rules]].

---

## SESSION 3 + 4 UPDATE (2026-06-27) — Wave 3 backend (#16 alerting, #18 dashboards)

> NOTE: the Session-3 ledger entry was lost with unpushed commit `34ec6de`; durable state (merged PRs + closed issues) was unaffected. This entry reconstructs #16 from the handoff and adds #18.

### #16 alerting — MERGED (Session 3)
PR #49, squash `00b7587`, #16 closed. Alert-rule CRUD → control-plane (Node+Fastify, mirrors tenant/user CRUD); alert-evaluator → new Go worker `services/alert-evaluator/` (11th go.work module). Migrations 000013 (BYPASSRLS `logalot_evaluator` role granted ONLY alert_rules+alert_notifications, ZERO on log_events; transition_seq + outbox `UNIQUE(rule_id,transition_seq)`) + 000014 (query-source CHECK). Idempotency = transactional outbox + relay-only dispatch (at-least-once + unique-key dedup). Notify: logsink default + floci SNS/SQS adapter. Staff gate: REQUEST-CHANGES → 1 fix-pass (I1 outbox relay, I2 savedQueryId-only spurious-fire) → APPROVE. Left a **deferred saved_query_id resolution hook** (savedQueryId-only rules inert).

### #18 dashboards + saved-queries backend — APPROVED, MERGE PENDING (Session 4)
PR #51 (branch `feat/18-dashboards`, head `2da7d4c`). Built by ai:backend-engineer foreground in main tree (no worktree). **Staff-engineer gate: APPROVE — 0 Critical / 0 Important / 6 Minor.** CI all green (go-lint, go-test, node-lint, node-test).
- Saved-query CRUD + dashboard CRUD in control-plane (hexagonal, RLS tenant-scoped via tenant-tx `SET LOCAL app.tenant_id`, tenant from TenantContext never body). New contracts `savedQuery.ts` + `dashboard.ts` (zod v4). Dashboards own panels inline (JSONB), reference savedQueryId by identity (no FK). Tables `saved_queries`(000007)/`dashboards`(000008) already existed w/ RLS + 000011 grants.
- **Panel-data**: `GET /v1/panel-data` placed in **query-service** (Go), not control-plane — query-service owns all log-content reads per ADR-0001; avoids service-to-service HTTP; reuses WithTenantScope/logalot_app RLS pool. Returns count + time-series + recent-logs.
- **Evaluator saved-query hook wired** (closes #16's deferral): `rulestore.go` resolves `saved_query_id`→RuleQuery; migration **000015** grants `logalot_evaluator` SELECT on `saved_queries` ONLY (definitions = metadata, NOT log content; count still via RLS LogCounter). Empty-query refusal preserved as fallback. savedQueryId-only rules now fire — test-proven.
- Tests: control-plane unit 18 + integration 13 (two-tenant RLS isolation proven); query-service panel unit 4 + integration 3 (AC3a/AC4); alert-evaluator integration +2 (resolve-and-fire, missing-saved-query-skipped). Random ports.
- **6 Minor follow-ups → issue #52** (panelstore errors.Is 404-vs-500 #1/#2, ListDue N+1 #3, service DRY isUniqueViolation #4, 000015 down comment #5, TimeSeries sparse-bucket contract #6).

### ⚠️ MERGE BLOCKER (same class as session-3 ledger push)
`gh pr merge 51 --squash` **denied by auto-mode classifier** ([Merge Without Review] — AI-only gate, no human approval). PR is reviewed+approved+green; needs USER to run `! gh pr merge 51 --squash --delete-branch` (or add a Bash allow-rule). #18 stays OPEN until then.

### Wave 3 status
#16 done (merged). #18 done (approved, merge-pending-user). Remaining: #17 cold tier (floci-gated; spikes #13/#14/#15 first). Backend hardening batch: #33 #35 #37 #39 #41 #42 #47 #52 + #16 M6 (FOR UPDATE SKIP LOCKED multi-replica). Wave 4 frontend next major (#20 scaffold+component-lib first, then #21/#22/#23, #24 Code Connect).
