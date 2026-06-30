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

---

## SESSION 5 UPDATE (2026-06-27) — backend hardening, BATCHED (α/β/γ)

Executed the Session-4 strategic batch plan: 6 hardening follow-ups → **3 cohesive PRs**, α‖γ in parallel worktrees, β serial after α. All dispatched `ai:backend-engineer` (sonnet, worktree-isolated), staff-engineer gate (opus/high) each, fix-pass where needed. **Merge classifier let agent `gh pr merge --squash` through this session** — no manual-merge bottleneck (contrast sessions 3/4).

### Batch α — auth/ingest fail-closed — MERGED (PR #54, squash `5417954`)
Closes #33 #39 #47 #35. Staff gate: APPROVE (0 Crit/0 Imp/3 Minor → #56).
- #33 `cacheEntry.ExpiresAt` enforced on BOTH cache-hit + DB-resolve paths (expired key never admitted/cached).
- #39 **new `pkg/httpkit` module** (12th go.work module) — Gin-free `CredentialFromRequest` single source of truth, both ingest+query consume it (byte-identical behavior, no auth regression); query-service pre-subscribe before headers → JSON 5xx. Gin error helpers left service-local (extracting would couple Gin into httpkit).
- #47 `tc.Valid()` unconditional BEFORE `Unlimited()` short-circuit (redis+memory); Retry-After on 503; per-tenant 429 log metric.
- #35 bounded confirm-timeout via `WithPublishTimeout` (default 10s) → 503; WriteTimeout 30s; app-core tenant test unmasked; NDJSON `confirmed:N` surfaced; AuthMiddleware `tc.Valid()`→401.

### Batch γ — RLS FORCE + slice-isolation CI gate — MERGED (PR #53, squash `c8d6087`)
Closes #41. **#42 closed as already-satisfied** — `migrations/000010:63` ALREADY has `FORCE ROW LEVEL SECURITY` (double-space alignment hid it from grep); staff verified ALL ten tenant tables already FORCE. Redundant 000016 migration was authored then DROPPED in fix-pass (its down would have STRIPPED the owner-bound FORCE — a regression). #41 = new `.github/workflows/slice-e2e.yml` job `slice isolation e2e (testcontainers)` running `make slice-test`, gated to PRs→main + nightly 02:00 UTC. **First CI gate on the multi-tenant isolation invariant.** Verified passing on #53 + #55.

### Batch β — query/evaluator/processor — MERGED (PR #55, squash `f805bbc`)
Closes #52 #37. Staff gate: REQUEST-CHANGES → 1 fix-pass → APPROVE.
- #52.1/.2 panelstore `errors.Is(pgx.ErrNoRows)` + edge UUID parse → 400-before-DB (was 500). .3 evaluator `ListDue` N+1 → single `ANY($1) AND tenant_id=ANY($2)` batch + Go-side composite `(id,tenant)` apply (tenant isolation test-proven; safe because saved_queries.id is globally-unique PK). .4 TS DRY `isUniqueViolation`→shared tenant-tx. .5 migration 000015 down `COMMENT...IS NULL` (true prior state). .6 sparse-bucket contract documented.
- #37 processor graceful drain: **`context.WithTimeout(context.WithoutCancel(ctx), drainTimeout)`** — SIGTERM no longer Nack→DLQ misclassifies in-flight persist, but bounded (`DefaultDrainTimeout=8s` < 20s ShutdownGrace < 30s grace period) so a stuck DB can't hang shutdown. `WithDrainTimeout` option + `WithLogger` on RuleStore (batch-error no longer swallowed). Fix-pass also fixed I1 unbounded-drain + I2 fabricated-down-comment + dead-code + test-assertion.

### State at session end
`main` @ `f805bbc`. Clean — no worktrees, no live agents, no claimed issues. Hardening backlog CLEARED (#33 #35 #37 #39 #41 #42 #47 #52 all closed). 12 go.work modules (added pkg/httpkit).

**Open:** #56 (α 3 minors — tiny: 2 comment rewords + 1 pre-existing lint), #25 epic, wave-4 frontend #20→{#21,#22,#23}→#24, #17 cold tier, floci spikes #13/#14/#15.

### NEXT SESSION — fresh start, next chunk
1. **floci spikes #13/#14/#15** = ONE investigation chunk (Firehose→Parquet+Glue fidelity, Athena templates+tenant projection, Kinesis-unused/Glacier deferral). Needs floci AWS-local stack (:4566, image floci/floci — NOT localstack). Gates #17. Output = validation runs + fidelity decision; keep feature flag.
2. **#17 cold tier** — solo PR after spikes pass; stays feature-flagged.
3. **Wave 4 frontend** (DS in Figma `9N3v2ZGGo3McfSxOLfBPnC` + `packages/design-tokens/tokens.json`): **#20 scaffold + component library SOLO FIRST** (shadcn/ui-on-Base-UI `@base-ui-components/react`, build from Figma); then **#21/#22/#23 PARALLEL** (worktree-isolated, independent pages; #23 has #16+#18 backends); **#24 Code Connect LAST**. Route ALL Figma work through ux-designer; never create new Figma files; confirm Figma MCP authed at session start.
4. #56 tiny minors — fold into any nearby backend chunk.

---

## SESSION 6 UPDATE (2026-06-27) — floci cold-tier fidelity spikes, ALL CLOSED

> NOTE: this file's Session-5 entry above was authored last session but its PR #57 squash **dropped the
> file change** (the commit landed empty). This session recovered it (it was still uncommitted in the
> working tree) and committed it together with this Session-6 entry — so `main` now finally carries both.

Drove floci spikes **#13/#14/#15** as one investigation chunk via `/ai:deliver` → `/ai:orchestrate`.
Ran the loop in **manual mode (main session)**, not the reference Workflow script — the script infers
`blockedBy` from issue bodies and treats a blocker satisfied only if closed *this run*, so the stale
`#1` (closed last session) would have stalled round 1. Manual mode gave deterministic readiness +
floci-stack serialization. All dispatched `ai:backend-engineer` (sonnet, worktree-isolated) → staff-engineer
gate (opus/high) → fix-pass where flagged → squash-merge. Merge classifier permissive again
(`gh pr merge --squash` worked); issue-body edits were classifier-BLOCKED (couldn't normalize stale
`blockedBy`, hence manual mode).

### #13 — Firehose→Parquet + Glue fidelity — MERGED (PR #58, squash `ea1e9b9`)
**Firehose FAIL, Glue/S3 PASS.** floci 1.5.28 Firehose is non-faithful: delivers raw NDJSON (no Parquet
conversion), writes `!{...}` dynamic-partition expressions **literally**, count-based flush only (=5, no
time-based). Root cause confirmed in floci **source** (`FirehoseService.java@1.5.28`). Staff flagged an
IAM-role confound (missing role = indistinguishable from a stub); fix-pass **controlled it in-test**
(created a recognized delivery role, observed floci *deliver*, then asserted the fidelity failures) →
airtight. Glue table + all 12 projection props (incl `projection.tenant_id.type=injected`) + explicit
`CreatePartition` + S3 direct-write Parquet all **PASS**.

### #14 — Athena templates + injected projection — MERGED (PR #59, squash `2d60747`)
**Dialect FAIL.** floci Athena is a **real DuckDB sidecar** (NOT a stub — content-correct results), but
DuckDB ≠ Presto/Trino: cold-tier.md §4's `regexp_like`/`json_extract_scalar` **don't exist in DuckDB**;
named Glue-table refs aren't bridged. `injected` projection **not enforced** (DuckDB has no Athena table
props). Test seeds real Parquet via direct S3 write for 2 tenants, demonstrates cross-tenant glob leak +
DuckDB-native predicates passing (proves real execution). Staff blocked once on a gofmt CI gate → fix-pass.
An **independent web-research pass corroborated** this (floci=DuckDB sidecar; Trino is the sole OSS engine
faithful to the Athena dialect AND enforcing `injected` projection — `InjectedProjection.java`).

### #15 — Kinesis unused + Glacier deferral — MERGED (PR #60, squash `f980260`)
**Kinesis CONFIRMED UNUSED** (0 build-path matches across Go/go.mod/TS/compose/Make/scripts; only in docs).
**floci Glacier** accepts lifecycle + GLACIER storage-class APIs but enforces **no archive semantics**
(GetObject on a GLACIER object succeeds with no RestoreObject; RestoreObject is a stub) → deferral
**confirmed appropriate**. Findings staged in the spike doc (NOT the ledger) to avoid conflicting with this
file's mid-consolidation.

### DECISION (gates #17) — see `docs/data/spikes/016-floci-cold-tier-decision.md`
1. **Drop Firehose → processor direct-write Parquet + explicit Glue `CreatePartition`** (the ADR-0005
   fallback, promoted on evidence; `ColdArchive` port contract unchanged).
2. **Local cold-query validation → Trino + Hive Metastore + MinIO** (Athena = managed Trino; runs our §4 SQL
   verbatim + enforces `injected`). floci stays for S3/SQS/etc; only cold SQL routes to Trino. Images:
   `minio/minio` + `postgres:16` (HMS) + `apache/hive:4.1.0` + `trinodb/trino:482`.
3. **Tenant guard local = app-side SQL fitness function** (NFR-6: reject SQL lacking `tenant_id=<ctx>`, AST
   check) + **real-AWS CI smoke test** for the proprietary `injected` projection.
4. Kinesis risk closed; Glacier deferral stands (real-S3-only when cost matters).
5. Cold search stays **feature-flagged** until #17 lands the above.
Reconciled **ADR-0005** (amendment: Firehose rejected, direct-write chosen) + **cold-tier.md** (§3 resolved,
§5.1 tee diagram, §5.2 Glacier) in this PR.

### State at session end
`main` @ `f980260` + this docs PR. floci spikes #13/#14/#15 **CLOSED**. Compose floci stack was left **UP**
during the chunk; bring it down with `make down` (or the infra-down target) when fully done. New artifacts:
`tests/cold-tier-spike/` module (3 tag-gated `floci_spike` tests + `make cold-tier-spike*` targets),
`docs/data/spikes/013–016`.

### NEXT — fresh session, next chunk
1. **#17 cold tier** — DONE Session 7 (see below).
2. **Wave 4 frontend** — **#20 scaffold + component library SOLO FIRST** (shadcn/ui-on-Base-UI from Figma
   `9N3v2ZGGo3McfSxOLfBPnC` + `packages/design-tokens/tokens.json` via `ai:ux-designer`); then **#21/#22/#23
   PARALLEL** worktrees; **#24 Code Connect LAST**. Confirm Figma MCP authed at session start.
3. **#56** tiny backend minors — fold into a nearby backend chunk.

---

## SESSION 7 UPDATE (2026-06-28) — #17 cold tier MERGED

Drove **#17 cold tier** to done via `/ai:orchestrate` → `autonomous-delivery` (manual loop, serial). `main` @ `eaedf9b`.

### #17 — MERGED (PR #62, squash `eaedf9b`), #17 CLOSED
Implemented per decision 016 (Firehose REJECTED → direct-write). `ai:backend-engineer` (sonnet, worktree) → staff gate (opus/high): **REQUEST-CHANGES → 1 fix-pass → APPROVE** → security audit (tenancy, clean) → lint fix → squash-merge.
- **`pkg/coldstore`** (13th go.work module): `ColdArchive` adapter = **direct S3 PutObject Parquet + explicit `glue.CreatePartition`** (NO Firehose). `parquet.go` (`encodeParquet`+`coldKey`, tenant_id LEADING partition from validated `tc.TenantID`, never event body); `Archive` groups events by `(dt,hour)` → one object/partition. `fitness.go` `CheckTenantPredicate` = structural AST/token check rejecting any cold SQL lacking a static `tenant_id='<ctx>'` AND-term (OR/paren/subquery/wrong-tenant all fail-closed); `query.go` `buildColdQuery` escapes all user fields via `escapeSQ` (`'`→`''`, complete for Athena/Trino). Cold search behind `COLD_ENABLED` (default OFF) + `WithSearchEnabled`.
- **Processor tee** wired best-effort: cold failure never fails hot ACK; hot-persist failure → no cold tee; tee skipped once lifecycle ctx cancelled (bounded shutdown).
- **Trino+HMS+MinIO overlay** `docker-compose.cold-query.yml` (`trinodb/trino:482` + `apache/hive:4.1.0` (embedded Derby — image ships no PG JDBC driver; ephemeral fixture, acceptable) + MinIO). `cold_query`-tagged test runs the REAL `buildColdQuery` output verbatim → ran GREEN: scoped rows only + Trino rejects no-partition-predicate query (`hive.query-partition-filter-required=true` = injected-projection analog).
- **Real-AWS smoke** `tests/cold-tier-smoke/` (`cold_smoke_aws` tag, skips w/o creds): raw `athenaRunner` bypasses fitness gate → asserts Athena `CONSTRAINT_VIOLATION` on no-tenant query (proves engine-enforced injected projection), bound-tenant returns rows, wrong-tenant zero rows, regexp_like/json_extract_scalar dialect. Correct-by-construction; runs only in gated AWS CI.
- Docs: `cold-tier.md` §2/§3 reconciled to `bigint` Unix-millis `ts`.
- **Security audit verdict: no exploitable cross-tenant vuln.** Tenant always kernel-validated UUID (36-char hex/dash → SQL-breakout impossible), inlined safely; user fields escaped; fitness gate fail-closed, no TOCTOU (same `sql` var to gate + execute). **Latent (non-blocking) note:** `splitTopLevelAND` ignores AND/OR precedence — NOT reachable here (user input can't inject a top-level OR), but harden if a future caller ever passes externally-influenced SQL structure to the gate.
- CI all green (go-lint after a De-Morgan/unused-helper fix, go-test, slice-e2e, node, GitGuardian). Unit: coldstore 18 + processor 23.

### Deferred → tracked
- **#63 (NEW, OPEN)** — cold-tier retention jobs (hot `drop_log_events_partitions_older_than` + per-tenant cold S3 prefix delete) + query-service cold-read routing/union-dedupe. Original #17 AC items intentionally deferred per decision 016 scope.
- **`cold_smoke_aws` CI workflow job** — needs real AWS + bucket provisioning (devops scope); test is complete, only the workflow wiring + `COLD_ENABLED=true` flip remain (decision 016 §6 gates the flip on a green smoke).

### State at session end
`main` @ `eaedf9b`, clean tree, no worktrees, no live agents, no claimed issues. floci + postgres compose UP (`logalot-floci` :4566 healthy, `logalot-postgres`); burrow stack was brought DOWN by the user mid-session (freed 5672/6379/27017). Stale orphan `worktree-agent-*` local branches from prior sessions remain (harmless clutter; safe to `git branch -D` later). Cold search stays feature-flagged.

### NEXT — fresh session, next chunk
1. **Wave 4 frontend** (DS in Figma `9N3v2ZGGo3McfSxOLfBPnC` + `packages/design-tokens/tokens.json`): **#20 scaffold + component library SOLO FIRST** (shadcn/ui-on-Base-UI `@base-ui-components/react`, via `ai:ux-designer`); then **#21/#22/#23 PARALLEL** worktrees (#23 has #16+#18 backends); **#24 Code Connect LAST**. Confirm Figma MCP authed at session start; never create new Figma files.
2. **#63** cold-tier retention + cold-read routing — backend, flips `COLD_ENABLED` only after the real-AWS smoke job lands.
3. **#56** tiny backend minors — fold into a nearby backend chunk.

---

## SESSION 15 UPDATE (2026-06-29) — WAVE 1 COMPLETE (Google OAuth + AWS IaC)

Drove **Wave 1 (#94–#105, 11 issues)** to done via the v1.3.1 `deliver.workflow.mjs` (Workflow tool, mode A), scoped `args: { labels: "wave-1", maxRounds: 12, budgetThreshold: 50000, securityReview: "sensitive" }`. Took **3 workflow passes** (chain-blocked issues become ready only after their blockers merge + a fresh scout). `main` @ `9bdc8da`, CI green, clean tree, no worktrees, no open PRs.

### What merged (all 11 wave-1 issues CLOSED)
- **Track A control-plane:** #94 id_token verifier+token-exchange (PR125), #95 authorize-initiation (PR124), #96 OIDC callback (PR128), #97 account-linking+session-mint+audit (PR130), #98 callback rate-limiting+no-PII-logging (PR129).
- **#100 frontend** web BFF + "Sign in with Google" + callback route (PR123).
- **Track B infra:** #101 multi-arch publishing (PR122), #102 docker-compose.aws (PR121), #103 TF network (PR120), #104 TF data/managed (PR119), #105 TF compute (PR127).

### ⚠️ RECURRING FOOTGUN — workflow merges on review approval, CI not gated, AND the CI lint job is weaker than per-package lint
Every pass, several PRs landed (or were held) with broken lint that the workflow's own staff-gate sometimes caught and sometimes didn't. Root causes:
1. **CI `node-lint` = root `biome check .` only — it does NOT run `tsc`.** The per-package script `pnpm --filter @logalot/control-plane lint` = `tsc --noEmit && biome check` is STRICTER and is **not gated in CI**. So a PR can be CI-green while `tsc` is RED.
2. **The workflow's fix-pass runs `biome check --write --unsafe`**, which rewrites `x!.y` → `x?.y` (noNonNullAssertion). Under `strict`+`noUncheckedIndexedAccess` that makes the value possibly-undefined → `tsc` TS18048. This broke #94 and #96 test files; #97 (PR130) actually **landed a latent tsc break on main** (`oidc-audit.test.ts` `events[0]` derefs) that CI never caught.
3. Plain biome format/organizeImports errors (which DO fail CI node-lint) merged red on #100/#95 in pass 1 → fixed by chore PR #126.

**Operator fixes applied this session** (all one-line/mechanical, logic was sound per the staff reviewer): PR126 (biome autofix #100/#95), PR125 fix (organizeImports + main-merge conflict union of GOOGLE_* env vars in env.ts/container.ts), PR119 fix (HCL `\.`→`\\.` escape in variables.tf), PR128 fix (throw-narrow `entry` in oidc-authenticator.test.ts + main-merge), PR129 fix (biome format + throw-narrow the 8× `events[0]` in oidc-audit.test.ts inherited from #97).

**RULE for next waves:** after the workflow finishes, ALWAYS (a) `gh pr checks <pr>` green + `mergeStateStatus CLEAN` before trusting any merge, and (b) run BOTH `pnpm lint` (root) AND `pnpm --filter <pkg> lint` (tsc) on `main` — CI green ≠ tsc green. See [[deliver-workflow-merges-without-ci-gate]] and the new tsc-gap memory.

### State at session end
`main` @ `9bdc8da`. All 8 workflow worktrees removed (verified clean + no live dev servers each pass). `.superpowers/delivery-progress.md` stays uncommitted (durable ledger by design).

### NEXT — Wave 2 (#106–#110)
- #106 cross-service OIDC e2e (testcontainers + fake Google), #107 cold_smoke_aws CI job vs real S3, #108 flip COLD_ENABLED/COLD_SEARCH_ENABLED (closes #63 AC#3), #109 security review gates (SG/IAM/TLS/TF-state), #110 live Google e2e on provisioned domain (critical-path join, needs Route53+Caddy TLS).
- Same scoped workflow run: `args: { labels: "wave-2", ... }`. Expect the same post-run lint cleanup drill.

---

## Session 16 — WAVE 2 COMPLETE (all #106–#110 closed) + tsc CI gate + epics closed

`main` @ `7267a3e`, CI green (ci + tf-validate both green). All Wave-2 issues closed; epics #86 + #87 closed (all child waves 0/1/2 done). Open: only #131 (web tsc gate, tech-debt) + #24 (Figma, hard-blocked).

### Pre-work — killed the tsc footgun at the source (PR132, merged b3ae728)
Added a CI `node-typecheck` job + `make node-typecheck` running `tsc --noEmit` on `@logalot/control-plane` + `@logalot/contracts` (both green; verified locally). **apps/web deliberately excluded** — its tsc needs TanStack route-tree codegen (`vite build`) AND has latent type bugs in `callback.tsx` (TS18048/TS2339 from #100). Filed **#131** to wire web later. So the `!`→`?.` footgun is now CI-gated for the two backend TS packages; web still needs a manual `pnpm --filter @logalot/web typecheck` until #131 lands.

### Workflow pass — 3 of 5 merged clean, 2 flagged needs-rework (REAL findings, not theater)
One Mode-A pass (`labels: wave-2`, 31 agents, ~1.19M tokens): **#107 (PR135), #109 (PR134), #110 (PR133) merged.** #106 (PR136) + #108 (PR137) flagged `needs-rework` by the staff-gate and left as OPEN PRs — re-running would NOT fix them; both needed hands-on engineering:
- **#108 (PR137):** functional logic approved; only `terraform fmt` drift in `compute.tf` (the `domain_name`/`alert_email` templatefile-map keys over-aligned to width 21). Root cause: #133 (78fda8c) introduced the drift → **main itself was tf-validate-RED** (pre-existing). Fixed: rebased on main, `terraform fmt` via `docker run hashicorp/terraform:1.10.5` (no local tf binary), force-pushed → tf-validate green (both infra/aws + bootstrap jobs).
- **#106 (PR136): staff-gate caught a REAL production bug behind a theater test.** R13 (sub-pinned): an already-linked user presenting a DIFFERENT Google sub (same email/tenant) trips `UNIQUE(tenant_id, user_id, provider)` — NOT the `(provider, provider_sub)` uniqueness the 23505 handler assumed. Its re-SELECT by the new sub returned 0 rows → `existing.rows[0]` undefined → `row.id` threw → **500 on an auth rejection that must be 401.** The PR's R13 test was a renamed cross-tenant-isolation duplicate (always passed). Fixes: `linkFirst` distinguishes the two UNIQUE constraints by re-SELECT result (row found = idempotent race; 0 rows = throw `ConflictError`); `oidc-authenticator` catches it → new audit outcome `reject_identity_conflict` → 401. Replaced the theater test with a genuine same-tenant different-sub case (asserts 401 + no new row) + a repo unit test. **Also fixed latent suite breakage:** many e2e tests re-linked the SHARED `alice` fixture with new subs (500 pre-fix / 401 post-fix) — each first-link test now provisions its OWN user; lifted the callback per-IP rate limit in the e2e `buildServer` (all tests share loopback IP → `oidcRateLimitMax: 100_000`). Full control-plane suite green: unit 182/182, integration 69/69.

### Footgun status update
1. **tsc gap (footgun #1) — PARTLY FIXED by PR132** (control-plane + contracts gated; web tracked in #131). See [[ci-node-lint-skips-tsc]].
2. **merge-without-CI-gate** still live but the staff-gate DID catch both real issues this pass and held them as needs-rework PRs (didn't merge red) — confirm `gh pr checks` + `mergeStateStatus CLEAN` before every merge still applies. See [[deliver-workflow-merges-without-ci-gate]].
3. **NEW: apps/web `node-test` is FLAKY** — transiently fails ALL testing-library assertions with `Invalid Chai property: toBeInTheDocument` (jest-dom setup drops); hit PR132 + PR137, cleared on `gh run rerun --failed` with zero code change. Memory: [[web-vitest-node-test-flaky-jestdom]].

### State at session end
`main` @ `7267a3e`, clean except this ledger (M, uncommitted by design). No worktrees (8 from the workflow removed clean — verified no live dev-server procs), no open PRs. **Google OAuth + AWS IaC fully shipped (Waves 0/1/2).** Next: no decomposed work remains — only #131 (web tsc gate) + #24 (Figma, license-blocked) as tech-debt.
