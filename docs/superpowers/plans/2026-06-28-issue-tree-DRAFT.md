# Issue Tree — DRAFT (Google OAuth + AWS IaC) — NOT YET FILED

- **Status:** DRAFT for user review. **NO GitHub issues have been created.** This is a transcription of the lead-engineer plan into a fileable issue tree.
- **Date:** 2026-06-28
- **Author:** project-manager
- **Source of truth (plan — granularity/sequencing decided there, transcribed here verbatim):** `docs/superpowers/plans/2026-06-28-google-oauth-and-aws-iac-plan.md`
- **Spec / ADRs:** `docs/superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md`; ADR-0008/0009/0010/0011; threat model `docs/security/threat-model-google-oauth.md` (R1–R16).
- **Repo:** `bRRRITSCOLD/logalot` · **main @ 19fe720** · last issue #85.

> **Filing constraint:** every `gh issue create` in §4 is held until the user approves. Read-only `gh` was used to build this draft. Nothing was created or modified.

---

## 1. Epic structure

Two epics (matching the plan's two tracks + their join), filed as `epic`-labelled tracker issues:

| Epic | Title | Tasks | Labels |
|---|---|---|---|
| **A** | `epic: Google OAuth sign-in (invite-only, PKCE, control-plane BFF)` | T01–T04, T07–T13, T19 | `epic` `auth` `backend` `frontend` |
| **B** | `epic: AWS IaC deployment (cost-first PoC, Terraform + Caddy TLS)` | T05, T06, T14–T18, T20, T21, T23 | `epic` `infra` |

- **T22** (security-architect review of the IaC) and **T23** (live Google e2e) are the cross-track join; T22 is tracked under Epic B (it reviews B's artifacts), T23 lives under Epic B as the demoable outcome but closes Epic A's flow. Both reference each other.
- **Milestone (recommended):** create a new milestone **`Google OAuth + AWS IaC (cost-first PoC)`**. The existing milestone #1 (`MVP — vertical slice + platform foundation`) is the prior feature set (24/25 closed) and is a poor fit. A milestone is worth the small overhead here because the 23-issue set is a coherent, time-boxed delivery and the milestone gives a single % -done view. (KISS check: 2 epics already give structure; the milestone adds a roll-up burn-down — keep it, skip GitHub Projects board.)

---

## 2. Issues (one per plan task, T01–T23)

Format mirrors the repo convention (see #24/#82/#84): `**Agent:**` / `**Wave:**` header, `## Context`, `## Acceptance criteria` checklist (carried from the plan task's named test cases + R-numbers), trailing `**Blocked by:**`. Titles are conventional-commit-ish (`scope: desc`). `blockedBy` is shown by **plan task id**; real `#numbers` are substituted at file time (the §4 script does this automatically via topological creation order — see the two-pass note).

Owner → specialist-agent mapping is in the `**Agent:**` line. `Plan task` cross-refs the source.

### Wave 0 — Foundations (parallel-safe; gate everything)

**T01 · `contracts(auth): OIDC authorize/callback request+response DTOs`**
- Agent: backend-engineer · Wave: 0 · Labels: `backend` `auth` `wave-0` · Plan: T01
- Context: shared Zod DTOs both control-plane and web validate (no drift), mirroring `auth.ts`. New `packages/contracts/src/oauth.ts` + index export.
- AC: valid `oidcAuthorize{Request,Response}` / `oidcCallbackRequest` parse; `returnTo` rejects absolute / `//` / `\\`; `code`/`state` non-empty; `tenantSlug` reuses `tenantPublicIdSchema`. (R7)
- blockedBy: none

**T02 · `backend(control-plane): OAuth in-flight state store (port + Redis adapter)`**
- Agent: backend-engineer · Wave: 0 · Labels: `backend` `auth` `wave-0` · Plan: T02
- Context: `OAuthStateStore` port + Redis adapter + in-memory fake; `REDIS_URL` config; `.env.example` Redis block; container wiring. Single-use atomic delete-on-consume, ~10-min TTL (D1).
- AC: `consume` returns the record once then `null`; TTL expiry → `null`; integration (testcontainers Redis) atomic consume under two concurrent callers → exactly one wins. (R4 store-side, R5 single-use)
- blockedBy: none

**T03 · `backend(control-plane): shared email-normalization helper + provisioning parity`**
- Agent: backend-engineer · Wave: 0 · Labels: `backend` `auth` `wave-0` · Plan: T03
- Context: `domain/email.ts normalizeEmail` (lowercase + trim + NFC, no homograph fold); applied at `user-service`/`tenant-service provisionAdmin` and exported for OIDC match (T10).
- AC: `User@X.com ` → `user@x.com`; NFC cases; idempotent; no homograph fold. (R14)
- blockedBy: none

**T04 · `backend(control-plane): OAuthIdentityRepository (port + Postgres adapter)`**
- Agent: backend-engineer · Wave: 0 · Labels: `backend` `data` `auth` `wave-0` · Plan: T04
- Context: `linkFirst` (INSERT under `withTenantTx`, maps `23505`), `resolveBySub` (calls `app.resolve_oauth_identity_by_sub`, no tenant armed), `touchLastLogin` (under RLS). DDL (migration 000017) already merged.
- AC: integration (testcontainers, `logalot_app` role) — `resolveBySub` returns tuple with no tenant context (bypass works); unknown sub → null; first-link INSERT visible only under its tenant; duplicate `sub` across tenants → `23505`. (R2/R3 storage; D5-Q1/Q3)
- blockedBy: none

**T05 · `infra(docker): control-plane + web Dockerfiles (arm64-capable)`**
- Agent: devops-engineer · Wave: 0 · Labels: `infra` `wave-0` · Plan: T05
- Context: new `Dockerfile.control-plane` + `Dockerfile.web` (multi-stage pnpm → non-root runtime). The repo's lone Dockerfile only builds the Go trio (D4).
- AC: `docker buildx build --platform linux/arm64` of both succeeds; container starts and `/healthz`/readiness responds. (build gate; supports R16 behind Caddy)
- blockedBy: none

**T06 · `infra(aws): Terraform skeleton + remote state backend (S3, encrypted, versioned, locked)`**
- Agent: devops-engineer · Wave: 0 · Labels: `infra` `wave-0` · Plan: T06
- Context: new `infra/aws/` — `backend.tf` (S3 backend: versioning + SSE + native lock), `versions/variables/providers.tf`, `README`, `bootstrap/`.
- AC: `terraform init`/`validate`/`fmt -check` in a new `tf-validate` CI job; state bucket private + versioned + encrypted (assert in plan). (ADR-0010 state-hardening; reviewed in T22)
- blockedBy: none

### Wave 1 — Track A cores (serialized control-plane chain + parallel web) · Track B packaging + infra

**T07 · `backend(control-plane): Google id_token verifier + token-exchange client`**
- Agent: backend-engineer · Wave: 1 · Labels: `backend` `auth` `wave-1` · Plan: T07
- Context: `jose` JWKS-by-`kid` verifier (RS256 only, reject `none`/HS*), full claim validation + nonce; code→token exchange client with `code_verifier`; `GOOGLE_*` config. `client_secret` from env (SSM on box).
- AC: unit per failing field — bad/absent sig; `alg:none`; `alg:HS256`; wrong `iss`/`aud`; expired `exp`; `email_verified:false`; missing/mismatched `nonce`. JWKS rotation: new `kid` validates after one refetch; unknown `kid` → reject; key selected by token `kid`; RS256-only. `client_secret`/`id_token` never returned or logged. (R1, R5, R9, R8/R12)
- blockedBy: **T01**

**T08 · `backend(control-plane): authorize-initiation endpoint (PKCE + returnTo allowlist)`**
- Agent: backend-engineer · Wave: 1 · Labels: `backend` `auth` `wave-1` · Plan: T08
- Context: `oidc-authenticator.beginAuthorize` — gen `state`(≥128-bit)/`nonce`/`code_verifier`, S256 challenge, `OAuthStateStore.put`, build authorize URL with **fixed server** `redirect_uri`, `scope=openid email`. `POST /v1/auth/oidc/google/authorize` (public).
- AC: unit — URL contains `code_challenge`+`code_challenge_method=S256`, `state`, `nonce`, fixed `redirect_uri` (never from request); `state` ≥128-bit + server-generated; `returnTo` `//evil`/`\\evil`/absolute → default. integration — record retrievable exactly once. (R4 mint, R6 authorize-half, R7)
- blockedBy: **T01, T02**

**T09 · `backend(control-plane): OIDC callback endpoint (consume state → exchange → verify)`**
- Agent: backend-engineer · Wave: 1 · Labels: `backend` `auth` `wave-1` · Plan: T09
- Context: `handleCallback(code, state)` — `OAuthStateStore.consume` rejecting unknown/expired/consumed **before any Google call**; exchange `code` with verifier; verify `id_token` (T07) using record's `nonce`. `POST /v1/auth/oidc/google/callback` (public). **Serialized after T08 (shared `routes.ts`/`oidc-authenticator.ts`).**
- AC: missing/unknown/expired/already-consumed `state` → 401 with **zero outbound Google calls** (fake client asserts); replayed valid `state` → 401; nonce mismatch → 401; missing/mismatched verifier → exchange fails → 401, no session. (R4, R5, R6 exchange-half, R11 pre-Google)
- blockedBy: **T07, T08, T02**

**T10 · `backend(control-plane): account linking + session mint + audit`**
- Agent: backend-engineer · Wave: 1 · Labels: `backend` `auth` `multi-tenancy` `wave-1` · Plan: T10
- Context: subsequent-login `resolveBySub` → SET LOCAL resolved tenant → **cross-check resolved tenant == state tenantSlug's tenant** (mismatch → 401) → `touchLastLogin`; first-link `findByPublicId` → `findCredentialsByEmail(normalizeEmail)` → no match → 401 → `linkFirst` (23505 → 401); mint via the **same** `AuthService` path (new refresh family + access JWT); emit audit. **Serialized after T09.**
- AC: integration (testcontainers) — first-link cross-tenant → 401, no `oauth_identities` row; subsequent cross-tenant → 401, no session; success mints a **new** refresh `familyId`; second login same `sub`/changed email → same user, no new row; `User@X.com` matches `user@x.com`; audit on link/login/each reject (tenant_id, user_id?, provider, hashed sub, outcome, ts). (R2, R3, R10, R13, R14, R15, D5-Q3)
- blockedBy: **T09, T04, T03**

**T11 · `backend(control-plane): callback rate-limiting + no-PII/secret logging`**
- Agent: backend-engineer · Wave: 1 · Labels: `backend` `auth` `wave-1` · Plan: T11
- Context: per-IP + global rate-limit on OIDC routes (Redis from T02 / `@fastify/rate-limit`); logging audit pass (redact/hash `sub`/`email`, never log `id_token`/`code`/`client_secret`). **Serialized after T09.**
- AC: integration — `429` after threshold on callback; bad-`state` path → zero Google calls; log-capture across a full login asserts no raw `id_token`/`code`/`client_secret`/full `email`, `sub`/`email` only hashed/redacted. (R11, R12, R8 log-side)
- blockedBy: **T09**

**T12 · `backend(data): migration 000017 wiring + RLS/resolver validation + dev seed`**
- Agent: backend-engineer · Wave: 1 · Labels: `backend` `data` `multi-tenancy` `wave-1` · Plan: T12
- Context: migration SQL already authored (`make migrate-up` applies it); this task only wires/validates + appends an optional DEV-ONLY `oauth_identities` seed row (`SET LOCAL app.tenant_id`, `ON CONFLICT DO NOTHING`).
- AC: integration (full up→down→up) — RLS fail-closed (no context ⇒ 0 rows; foreign-tenant INSERT ⇒ `WITH CHECK` reject); global uniqueness across RLS-invisible tenants ⇒ `23505`; resolver returns tuple as `logalot_app` w/o context, denies non-`logalot_app` (PUBLIC revoke holds); same-tenant composite FK violation; dev seed idempotent. (R2/R3 storage; D5-Q1/Q4)
- blockedBy: none

**T13 · `web(auth): BFF thin relay + "Sign in with Google" + callback route`**
- Agent: frontend-engineer · Wave: 1 · Labels: `frontend` `auth` `wave-1` · Plan: T13
- Context: `server/oidc.ts` (`startGoogleSignin`/`completeGoogleSignin` server fns relaying to control-plane), `control-plane.ts` client (T01 contracts), `routes/auth/google/callback.tsx`, button on `login.tsx`. Reuses `sessionCookieAttributes()` (R16) + `ControlPlaneError` collapse. **Contract-only dep on T08/T09 — can build against T01 schema before they merge.**
- AC: unit — `returnTo` `//evil.com`/`https://evil.com`/`\\evil.com` → default; success sets `lg_at`/`lg_rt` `HttpOnly`+`Secure`(per `COOKIE_SECURE`)+`SameSite=Lax`; control-plane 4xx collapses to one generic message. (R7, R16)
- blockedBy: **T01**

**T14 · `infra(ci): multi-arch (arm64) image publishing for all 7 app images`**
- Agent: devops-engineer · Wave: 1 · Labels: `infra` `wave-1` · Plan: T14
- Context: new `.github/workflows/release-images.yml` (`docker buildx` matrix: 5 Go via `SERVICE=` + control-plane + web; `linux/arm64`+`linux/amd64`; push on tag/main); Makefile buildx targets.
- AC: all 7 manifests build for `linux/arm64`; published manifest is multi-arch (`docker buildx imagetools inspect` asserts).
- blockedBy: **T05**

**T15 · `infra(aws): docker-compose.aws.yml (Caddy TLS, mem-limits+swap, real S3)`**
- Agent: devops-engineer · Wave: 1 · Labels: `infra` `wave-1` · Plan: T15
- Context: new `docker-compose.aws.yml` (postgres/redis/rabbitmq + 5 Go + control-plane + web + **Caddy**; **no** mongodb/floci; per-container `mem_limit` per ADR-0011; cold env → real S3) + `Caddyfile` (TLS terminate + reverse-proxy + HSTS) + `.env.example` AWS block.
- AC: `docker compose -f docker-compose.aws.yml config` validates; local bring-up smoke (mongo/floci absent; mem_limits present); `caddy validate`. (R16 HSTS/TLS)
- blockedBy: **T05**

**T16 · `infra(aws): Terraform network layer (VPC/subnet/IGW/SG; SSM admin, no port 22)`**
- Agent: devops-engineer · Wave: 1 · Labels: `infra` `wave-1` · Plan: T16
- Context: `network.tf` (VPC, 1 public subnet, IGW, route table) + `security.tf` (SG inbound **443 + 80** only, egress open; **no 22** by default; togglable `admin_cidr` SSH fallback per D3).
- AC: `terraform validate`/`plan`; policy assertion — SG has no `0.0.0.0/0:22` ingress by default; only 443/80 open. (R16; reviewed T22)
- blockedBy: **T06**

**T17 · `infra(aws): Terraform compute (EC2 t4g.small + EIP + gp3 + instance profile + user-data)`**
- Agent: devops-engineer · Wave: 1 · Labels: `infra` `wave-1` · Plan: T17
- Context: `compute.tf` (t4g.small ARM64, 30GB gp3, EIP) + `iam.tf` (instance profile: `AmazonSSMManagedInstanceCore` + **least-priv `ssm:GetParameter*` scoped to `/logalot/<env>/*`** + S3 cold access) + `user-data.sh.tftpl` (Docker+compose, swap, SSM params → env, compose up). Apply order: T16 → T18 → T17.
- AC: `terraform validate`/`plan`; user-data `shellcheck`; instance type `t4g.small`, arch arm64, root gp3 30GB; swap present. (ADR-0011 sizing)
- blockedBy: **T16, T15, T18**

**T18 · `infra(aws): Terraform data + managed services (S3/Glue/SSM/Route53/CloudWatch/Budgets)`**
- Agent: devops-engineer · Wave: 1 · Labels: `infra` `wave-1` · Plan: T18
- Context: `s3.tf` (cold + Athena-results buckets, lifecycle expiry, private+encrypted+versioned), `glue.tf`, `ssm.tf` (SecureString params under `/logalot/<env>/*`), `dns.tf` (Route53 zone + A/AAAA → EIP), `observability.tf` (CloudWatch OOM alarm + **AWS Budget $30 @ 80/100% + forecast**).
- AC: `terraform validate`/`plan`; **IAM SSM read scoped to `/logalot/<env>/oauth/google/*` (+ logalot path), not `ssm:*`/`Resource:*`** (R8); S3 lifecycle rule present + bucket private/encrypted; Budget $30 @ 80/100. (R8, ADR-0010/0011)
- blockedBy: **T06**

### Wave 2 — Integration, end-to-end, cold-smoke flip, review gates

**T19 · `backend(test): cross-service OIDC end-to-end (testcontainers + fake Google)`**
- Agent: backend-engineer · Wave: 2 · Labels: `backend` `auth` `wave-2` · Plan: T19
- Context: new `tests/oidc-e2e/` (slice-style) with a fake Google (token endpoint + JWKS) — no live IdP. Exercises authorize→callback→link→mint end to end. **Independent of Track B — finishes first.**
- AC: e2e — happy path (first-link then subsequent) + all Critical/High rejections end to end: R1 (each invalid field), R2 (cross-tenant first-link), R3 (cross-tenant subsequent), R4 (state replay/unknown), R5 (nonce), R6 (PKCE missing verifier), R10 (fresh family), R13 (sub-pinned), R14 (normalization).
- blockedBy: **T10, T11, T12, T13**

**T20 · `infra(ci): wire cold_smoke_aws job against the real provisioned S3 bucket`**
- Agent: devops-engineer · Wave: 2 · Labels: `infra` `wave-2` · Plan: T20
- Context: new `.github/workflows/cold-smoke-aws.yml` (gated/manual or post-apply; sets `COLD_BUCKET`/`COLD_GLUE_DB`/`COLD_ATHENA_RESULT_BUCKET` from T18 outputs; runs `go test -tags=cold_smoke_aws ./tests/cold-tier-smoke/...`) + Makefile target. Smoke test already written (skips without env vars).
- AC: smoke canary passes against real S3/Athena/Glue (EnsureGlueTable → WriteParquet → partition → bound/no-tenant/wrong-tenant/dialect). **Unblocks #63 AC#3.**
- blockedBy: **T18**

**T21 · `backend(deploy): flip COLD_ENABLED / COLD_SEARCH_ENABLED (closes #63 AC#3)`**
- Agent: backend-engineer + devops-engineer · Wave: 2 · Labels: `backend` `infra` `wave-2` · Plan: T21
- Context: set both `true` in `docker-compose.aws.yml`/SSM/deploy env + config-comment notes in query-service/processor. Valid **only after T20 green** (the documented gate, decision 016 §6). **This closes the long-deferred #63 AC#3 (see §5).**
- AC: post-flip, query-service routes cold reads + processor tees to real S3; re-run T20 smoke green. (closes #63 AC#3)
- blockedBy: **T20**

**T22 · `security: review gates (SG/IAM/TLS/Terraform-state hardening)`**
- Agent: security-architect · Wave: 2 · Labels: `security` `infra` `wave-2` · Plan: T22
- Context: review-only over T16/T17/T18 (+ checklist note in `docs/security/`). Asserts threat-model controls landed in IaC.
- AC: SG inbound = {443,80} only, no 22 (D3); IAM SSM read scoped to param path, not `ssm:*` (R8); TF state bucket private+encrypted+versioned (ADR-0010); Caddy enforces HTTPS+HSTS, cookies `Secure` in non-dev (R16).
- blockedBy: **T16, T17, T18**

**T23 · `infra(demo): live Google end-to-end on the provisioned domain (critical-path join)`**
- Agent: lead-engineer (validation) + devops-engineer (env) · Wave: 2 · Labels: `infra` `auth` `wave-2` · Plan: T23
- Context: runbook note (Google console redirect URI = `https://<domain>/auth/google/callback`); no app code. **The hard cross-track join** — needs T17 (EC2/EIP running compose) + T18 (Route53 + Caddy/ACME TLS) + T10/T13 (the working flow). Google rejects non-HTTPS redirect URIs.
- AC: manual/scripted e2e — a provisioned user signs in via real Google, lands authenticated with `lg_at`/`lg_rt`; an unprovisioned Google user is rejected (401, invite-only). (transport https-only R16)
- blockedBy: **T10, T13, T17, T18**

---

## 3. Sequenced delivery roadmap (waves) + critical path

**Wave 0 — Foundations (6 issues, all parallel-safe, no blockers):** T01, T02, T03, T04, T05, T06. Drain all six first; everything downstream compiles/builds against them.

**Wave 1 — Cores (12 issues):**
- *Track A control-plane chain (SERIALIZE on shared `routes.ts`/`container.ts`/`oidc-authenticator.ts`):* **T08 → T09 → T10 → T11**.
- *Track A parallel lanes (file-disjoint):* T07 (crypto/http verifier files), T13 (web), T12 (DB-only).
- *Track B packaging:* T14, T15 (both gated on T05).
- *Track B infra:* T16 (gated T06), T18 (gated T06), then **T17 last** (gated T16+T15+T18).

**Wave 2 — Integration / flip / review (5 issues):** T19 (Track A e2e, runs as soon as T10–T13 land — independent of Track B), T20 (gated T18) → T21 (gated T20, closes #63 AC#3), T22 (gated T16/17/18), **T23 (the join — gated T10, T13, T17, T18)**.

### Critical path (longest chain to the demoable outcome) — as issue titles

```
contracts(auth): OIDC DTOs  [T01]
  → backend(control-plane): id_token verifier + token client  [T07]
  → backend(control-plane): authorize endpoint (PKCE)  [T08]
  → backend(control-plane): callback endpoint  [T09]
  → backend(control-plane): account linking + session + audit  [T10]
  → infra(demo): live Google e2e on provisioned domain  [T23]   ◀ JOIN
```
…where T23 also requires the **Track B domain/TLS sub-chain** converging in parallel:
```
infra(aws): TF state backend [T06] → TF network [T16] → TF compute (EC2+EIP) [T17]
                                   ↘ TF data (Route53/S3/SSM/Caddy TLS) [T18] ↗
infra(docker): Node Dockerfiles [T05] → docker-compose.aws.yml [T15] → [T17]
```
**Single hard cross-track join = T23** (live demo needs a real HTTPS redirect URI). All other Track A work — including the testcontainers e2e (T19) — is fully independent of Track B and should finish first. Sequence so Track A logic is done-and-tested while Track B stands up domain/TLS, then join only for T23.

### Owner distribution (24 issues incl. 2 epics)

| Owner agent | Count | Issues |
|---|---|---|
| backend-engineer | 10 | T01, T02, T03, T04, T07, T08, T09, T10, T11, T19 (+ shared T12, T21) |
| devops-engineer | 8 | T05, T06, T14, T15, T16, T17, T18, T20 (+ shared T21, T23) |
| frontend-engineer | 1 | T13 |
| security-architect | 1 | T22 |
| lead-engineer | — | T23 (validation, shared with devops) |
| (epics) | 2 | Epic A, Epic B (tracker-owned) |

---

## 4. Labels + fileable `gh` script (HELD until approval)

### Labels: existing vs. needs-creating

| Label | Status |
|---|---|
| `epic`, `backend`, `frontend`, `infra`, `data`, `auth`, `multi-tenancy`, `wave-0`, `wave-1`, `wave-2` | **EXIST** — reuse as-is |
| `security` | **MISSING — needs `gh label create`** (T22) |

> Note: the existing `wave-0/1/2` label *descriptions* reference the prior delivery ("Search + control-plane + rate limit" etc.). The label *names* fit this run's 3 waves; reusing the names keeps the taxonomy lean (no new wave labels). Optionally re-describe later — not load-bearing.

### Two-pass note

`blockedBy` is a **body convention** in this repo (no native GitHub dependency field). The script below avoids a literal second pass by **creating issues in topological order** — every blocker exists (and its `#number` is captured in the `I[...]` map) before any issue that references it — so `**Blocked by:**` lines are written with real `#numbers` on first creation. The **only** deferred edits are the **2 epic bodies** (their child checklists need all child `#numbers`), done in the short Pass 2 at the end. If you prefer the classic two-pass instead (create everything with task-id placeholders, then bulk-rewrite), the topological order still holds; just split the `gh issue edit` calls out.

### Script (review, then run top-to-bottom in one shell)

```bash
set -euo pipefail
# ── 0. Missing label ──────────────────────────────────────────────────────
gh label create security --color "ee0701" --description "Security review / threat-model control" || true

# ── 1. Milestone (optional but recommended) ───────────────────────────────
MS="Google OAuth + AWS IaC (cost-first PoC)"
gh api repos/:owner/:repo/milestones -f title="$MS" \
  -f description="Google OAuth sign-in (invite-only, PKCE) + AWS IaC cost-first PoC. Plan: docs/superpowers/plans/2026-06-28-google-oauth-and-aws-iac-plan.md" >/dev/null || true

# helper: create an issue, echo its number
declare -A I
mk(){ # $1 title  $2 labels(csv)  $3 body
  gh issue create --title "$1" --label "$2" --milestone "$MS" --body "$3" | grep -oE '[0-9]+$'; }

# ── 2. Epics first (children reference these) ─────────────────────────────
I[EA]=$(mk "epic: Google OAuth sign-in (invite-only, PKCE, control-plane BFF)" "epic,auth,backend,frontend" \
"Master tracker for Google OAuth sign-in (Track A). Invite-only; PKCE S256; state/nonce/verifier in control-plane Redis (D1); web BFF is a thin relay.

Plan: docs/superpowers/plans/2026-06-28-google-oauth-and-aws-iac-plan.md
Spec: docs/superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md

## Child tasks
(filled in Pass 2)")

I[EB]=$(mk "epic: AWS IaC deployment (cost-first PoC, Terraform + Caddy TLS)" "epic,infra" \
"Master tracker for AWS IaC (Track B). Single t4g.small EC2 + EIP, Terraform, Caddy/ACME TLS, SSM admin (no port 22, D3), real S3 cold tier, AWS Budget \$30.

Plan: docs/superpowers/plans/2026-06-28-google-oauth-and-aws-iac-plan.md

## Child tasks
(filled in Pass 2)")

# ── 3. Wave 0 (no blockers) ───────────────────────────────────────────────
I[T01]=$(mk "contracts(auth): OIDC authorize/callback request+response DTOs" "backend,auth,wave-0" \
"**Agent:** backend-engineer
**Wave:** 0
**Epic:** #${I[EA]}  ·  **Plan task:** T01

## Context
Shared Zod DTOs both control-plane and web validate (no drift), mirroring auth.ts. New packages/contracts/src/oauth.ts + index export.

## Acceptance criteria
- [ ] oidcAuthorize{Request,Response} / oidcCallbackRequest parse valid payloads.
- [ ] returnTo rejects absolute / // / \\\\ forms.
- [ ] code/state non-empty; tenantSlug reuses tenantPublicIdSchema.
- [ ] (R7)

**Blocked by:** none")

I[T02]=$(mk "backend(control-plane): OAuth in-flight state store (port + Redis adapter)" "backend,auth,wave-0" \
"**Agent:** backend-engineer
**Wave:** 0
**Epic:** #${I[EA]}  ·  **Plan task:** T02

## Context
OAuthStateStore port + Redis adapter + in-memory fake; REDIS_URL config; .env.example Redis block; container wiring. Single-use atomic delete-on-consume, ~10-min TTL (D1).

## Acceptance criteria
- [ ] consume returns the record once then null (single-use).
- [ ] TTL expiry → null.
- [ ] integration (testcontainers Redis): atomic consume under two concurrent callers → exactly one wins.
- [ ] (R4 store-side, R5 single-use)

**Blocked by:** none")

I[T03]=$(mk "backend(control-plane): shared email-normalization helper + provisioning parity" "backend,auth,wave-0" \
"**Agent:** backend-engineer
**Wave:** 0
**Epic:** #${I[EA]}  ·  **Plan task:** T03

## Context
domain/email.ts normalizeEmail (lowercase + trim + NFC, no homograph fold); applied at user-service / tenant-service provisionAdmin and exported for OIDC match (T10).

## Acceptance criteria
- [ ] 'User@X.com ' → 'user@x.com'.
- [ ] NFC composition cases; idempotent; no homograph fold.
- [ ] (R14)

**Blocked by:** none")

I[T04]=$(mk "backend(control-plane): OAuthIdentityRepository (port + Postgres adapter)" "backend,data,auth,wave-0" \
"**Agent:** backend-engineer
**Wave:** 0
**Epic:** #${I[EA]}  ·  **Plan task:** T04

## Context
linkFirst (INSERT under withTenantTx, maps 23505 via isUniqueViolation), resolveBySub (calls app.resolve_oauth_identity_by_sub, no tenant armed), touchLastLogin (under RLS). DDL (migration 000017) already merged.

## Acceptance criteria
- [ ] integration (testcontainers, logalot_app role): resolveBySub returns tuple with NO tenant context (bypass works).
- [ ] unknown sub → null.
- [ ] first-link INSERT visible only under its tenant.
- [ ] duplicate sub across tenants → 23505.
- [ ] (R2/R3 storage; D5-Q1/Q3)

**Blocked by:** none")

I[T05]=$(mk "infra(docker): control-plane + web Dockerfiles (arm64-capable)" "infra,wave-0" \
"**Agent:** devops-engineer
**Wave:** 0
**Epic:** #${I[EB]}  ·  **Plan task:** T05

## Context
New Dockerfile.control-plane + Dockerfile.web (multi-stage pnpm → non-root runtime). Repo's lone Dockerfile only builds the Go trio (D4).

## Acceptance criteria
- [ ] docker buildx build --platform linux/arm64 of both succeeds.
- [ ] container starts and /healthz / readiness responds (smoke).
- [ ] (build gate; supports R16 behind Caddy)

**Blocked by:** none")

I[T06]=$(mk "infra(aws): Terraform skeleton + remote state backend (S3, encrypted, versioned, locked)" "infra,wave-0" \
"**Agent:** devops-engineer
**Wave:** 0
**Epic:** #${I[EB]}  ·  **Plan task:** T06

## Context
New infra/aws/: backend.tf (S3 backend: versioning + SSE + native lock), versions/variables/providers.tf, README, bootstrap/.

## Acceptance criteria
- [ ] terraform init/validate/fmt -check in a new tf-validate CI job.
- [ ] state bucket private + versioned + encrypted (assert in plan).
- [ ] (ADR-0010 state-hardening; reviewed in T22)

**Blocked by:** none")

# ── 4. Wave 1 (topological: T07,T08,T09,T10,T11,T12,T13,T14,T15,T16,T18,T17) ──
I[T07]=$(mk "backend(control-plane): Google id_token verifier + token-exchange client" "backend,auth,wave-1" \
"**Agent:** backend-engineer
**Wave:** 1
**Epic:** #${I[EA]}  ·  **Plan task:** T07

## Context
jose JWKS-by-kid verifier (RS256 only, reject none/HS*), full claim validation + nonce; code→token exchange client with code_verifier; GOOGLE_* config. client_secret from env (SSM on box).

## Acceptance criteria
- [ ] unit per failing field: bad/absent sig; alg:none; alg:HS256; wrong iss; wrong aud; expired exp; email_verified:false; missing/mismatched nonce.
- [ ] JWKS rotation: new kid validates after one refetch; unknown kid → reject; key selected by token kid; RS256-only.
- [ ] client_secret / id_token never returned or logged.
- [ ] (R1, R5, R9, R8/R12)

**Blocked by:** #${I[T01]}")

I[T08]=$(mk "backend(control-plane): authorize-initiation endpoint (PKCE + returnTo allowlist)" "backend,auth,wave-1" \
"**Agent:** backend-engineer
**Wave:** 1
**Epic:** #${I[EA]}  ·  **Plan task:** T08

## Context
oidc-authenticator.beginAuthorize: gen state(>=128-bit)/nonce/code_verifier, S256 challenge, OAuthStateStore.put, build authorize URL with FIXED server redirect_uri, scope=openid email. POST /v1/auth/oidc/google/authorize (public). SERIALIZE control-plane chain T08->T09->T10->T11.

## Acceptance criteria
- [ ] unit: URL has code_challenge + code_challenge_method=S256, state, nonce, fixed redirect_uri (never from request).
- [ ] state >=128-bit + server-generated.
- [ ] returnTo //evil / \\\\evil / absolute → default.
- [ ] integration: record retrievable exactly once.
- [ ] (R4 mint, R6 authorize-half, R7)

**Blocked by:** #${I[T01]} #${I[T02]}")

I[T09]=$(mk "backend(control-plane): OIDC callback endpoint (consume state -> exchange -> verify)" "backend,auth,wave-1" \
"**Agent:** backend-engineer
**Wave:** 1
**Epic:** #${I[EA]}  ·  **Plan task:** T09

## Context
handleCallback(code, state): OAuthStateStore.consume rejecting unknown/expired/consumed BEFORE any Google call; exchange code with verifier; verify id_token (T07) using record's nonce. POST /v1/auth/oidc/google/callback (public). Serialized after T08.

## Acceptance criteria
- [ ] missing/unknown/expired/already-consumed state → 401 with ZERO outbound Google calls (fake client asserts).
- [ ] replayed valid state → 401 (single-use).
- [ ] nonce mismatch → 401.
- [ ] missing/mismatched verifier → exchange fails → 401, no session.
- [ ] (R4, R5, R6 exchange-half, R11 pre-Google)

**Blocked by:** #${I[T07]} #${I[T08]} #${I[T02]}")

I[T10]=$(mk "backend(control-plane): account linking + session mint + audit" "backend,auth,multi-tenancy,wave-1" \
"**Agent:** backend-engineer
**Wave:** 1
**Epic:** #${I[EA]}  ·  **Plan task:** T10

## Context
Subsequent-login resolveBySub -> SET LOCAL resolved tenant -> cross-check resolved tenant == state tenantSlug's tenant (mismatch -> 401) -> touchLastLogin; first-link findByPublicId -> findCredentialsByEmail(normalizeEmail) -> no match -> 401 -> linkFirst (23505 -> 401); mint via the SAME AuthService path (new refresh family + access JWT); emit audit. Serialized after T09.

## Acceptance criteria
- [ ] first-link cross-tenant → 401, no oauth_identities row.
- [ ] subsequent cross-tenant → 401, no session.
- [ ] success mints a NEW refresh familyId distinct from any prior.
- [ ] second login same sub / changed email → same user, no new row.
- [ ] User@X.com matches user@x.com.
- [ ] audit emitted on first-link, login, and each reject (tenant_id, user_id?, provider, hashed sub, outcome, ts).
- [ ] (R2, R3, R10, R13, R14, R15, D5-Q3)

**Blocked by:** #${I[T09]} #${I[T04]} #${I[T03]}")

I[T11]=$(mk "backend(control-plane): callback rate-limiting + no-PII/secret logging" "backend,auth,wave-1" \
"**Agent:** backend-engineer
**Wave:** 1
**Epic:** #${I[EA]}  ·  **Plan task:** T11

## Context
Per-IP + global rate-limit on OIDC routes (Redis from T02 / @fastify/rate-limit); logging audit pass (redact/hash sub/email, never log id_token/code/client_secret). Serialized after T09.

## Acceptance criteria
- [ ] 429 after threshold on the callback.
- [ ] bad-state path makes ZERO Google calls.
- [ ] log-capture across a full login: no raw id_token/code/client_secret/full email; sub/email only hashed/redacted.
- [ ] (R11, R12, R8 log-side)

**Blocked by:** #${I[T09]}")

I[T12]=$(mk "backend(data): migration 000017 wiring + RLS/resolver validation + dev seed" "backend,data,multi-tenancy,wave-1" \
"**Agent:** backend-engineer
**Wave:** 1
**Epic:** #${I[EA]}  ·  **Plan task:** T12

## Context
Migration SQL already authored (make migrate-up applies it); this task only wires/validates + appends an optional DEV-ONLY oauth_identities seed row (SET LOCAL app.tenant_id, ON CONFLICT DO NOTHING).

## Acceptance criteria
- [ ] integration (full up->down->up): RLS fail-closed (no context => 0 rows; foreign-tenant INSERT => WITH CHECK reject).
- [ ] global uniqueness across RLS-invisible tenants => 23505.
- [ ] resolver returns tuple as logalot_app w/o context; denies non-logalot_app (PUBLIC revoke holds).
- [ ] same-tenant composite FK violation; dev seed idempotent.
- [ ] (R2/R3 storage; D5-Q1/Q4)

**Blocked by:** none")

I[T13]=$(mk 'web(auth): BFF thin relay + "Sign in with Google" + callback route' "frontend,auth,wave-1" \
"**Agent:** frontend-engineer
**Wave:** 1
**Epic:** #${I[EA]}  ·  **Plan task:** T13

## Context
server/oidc.ts (startGoogleSignin/completeGoogleSignin server fns relaying to control-plane), control-plane.ts client (T01 contracts), routes/auth/google/callback.tsx, button on login.tsx. Reuses sessionCookieAttributes() (R16) + ControlPlaneError collapse. Contract-only dep on T08/T09 — can build against T01 schema before they merge.

## Acceptance criteria
- [ ] unit: returnTo //evil.com / https://evil.com / \\\\evil.com → default.
- [ ] success sets lg_at/lg_rt HttpOnly + Secure(per COOKIE_SECURE) + SameSite=Lax.
- [ ] control-plane 4xx collapses to one generic message (no enumeration).
- [ ] (R7, R16)

**Blocked by:** #${I[T01]}")

I[T14]=$(mk "infra(ci): multi-arch (arm64) image publishing for all 7 app images" "infra,wave-1" \
"**Agent:** devops-engineer
**Wave:** 1
**Epic:** #${I[EB]}  ·  **Plan task:** T14

## Context
New .github/workflows/release-images.yml (docker buildx matrix: 5 Go via SERVICE= + control-plane + web; linux/arm64 + linux/amd64; push on tag/main); Makefile buildx targets.

## Acceptance criteria
- [ ] all 7 manifests build for linux/arm64.
- [ ] published manifest is multi-arch (docker buildx imagetools inspect asserts).

**Blocked by:** #${I[T05]}")

I[T15]=$(mk "infra(aws): docker-compose.aws.yml (Caddy TLS, mem-limits+swap, real S3)" "infra,wave-1" \
"**Agent:** devops-engineer
**Wave:** 1
**Epic:** #${I[EB]}  ·  **Plan task:** T15

## Context
New docker-compose.aws.yml (postgres/redis/rabbitmq + 5 Go + control-plane + web + Caddy; NO mongodb/floci; per-container mem_limit per ADR-0011; cold env → real S3) + Caddyfile (TLS terminate + reverse-proxy + HSTS) + .env.example AWS block.

## Acceptance criteria
- [ ] docker compose -f docker-compose.aws.yml config validates.
- [ ] local bring-up smoke (mongo/floci absent; mem_limits present).
- [ ] caddy validate passes.
- [ ] (R16 HSTS/TLS)

**Blocked by:** #${I[T05]}")

I[T16]=$(mk "infra(aws): Terraform network layer (VPC/subnet/IGW/SG; SSM admin, no port 22)" "infra,wave-1" \
"**Agent:** devops-engineer
**Wave:** 1
**Epic:** #${I[EB]}  ·  **Plan task:** T16

## Context
network.tf (VPC, 1 public subnet, IGW, route table) + security.tf (SG inbound 443 + 80 only, egress open; NO 22 by default; togglable admin_cidr SSH fallback per D3).

## Acceptance criteria
- [ ] terraform validate/plan.
- [ ] policy assertion: SG has no 0.0.0.0/0:22 ingress by default; only 443/80 open.
- [ ] (R16; reviewed T22)

**Blocked by:** #${I[T06]}")

I[T18]=$(mk "infra(aws): Terraform data + managed services (S3/Glue/SSM/Route53/CloudWatch/Budgets)" "infra,wave-1" \
"**Agent:** devops-engineer
**Wave:** 1
**Epic:** #${I[EB]}  ·  **Plan task:** T18

## Context
s3.tf (cold + Athena-results buckets, lifecycle expiry, private+encrypted+versioned), glue.tf, ssm.tf (SecureString params under /logalot/<env>/*), dns.tf (Route53 zone + A/AAAA → EIP), observability.tf (CloudWatch OOM alarm + AWS Budget \$30 @ 80/100% + forecast).

## Acceptance criteria
- [ ] terraform validate/plan.
- [ ] IAM SSM read scoped to /logalot/<env>/oauth/google/* (+ logalot path), NOT ssm:* / Resource:* (R8).
- [ ] S3 lifecycle rule present + bucket private/encrypted.
- [ ] Budget \$30 @ 80/100 thresholds.
- [ ] (R8, ADR-0010/0011)

**Blocked by:** #${I[T06]}")

I[T17]=$(mk "infra(aws): Terraform compute (EC2 t4g.small + EIP + gp3 + instance profile + user-data)" "infra,wave-1" \
"**Agent:** devops-engineer
**Wave:** 1
**Epic:** #${I[EB]}  ·  **Plan task:** T17

## Context
compute.tf (t4g.small ARM64, 30GB gp3, EIP) + iam.tf (instance profile: AmazonSSMManagedInstanceCore + least-priv ssm:GetParameter* scoped to /logalot/<env>/* + S3 cold access) + user-data.sh.tftpl (Docker+compose, swap, SSM params → env, compose up). Apply order: T16 → T18 → T17.

## Acceptance criteria
- [ ] terraform validate/plan.
- [ ] user-data shellcheck passes.
- [ ] instance type t4g.small, arch arm64, root gp3 30GB; swap present.
- [ ] (ADR-0011 sizing)

**Blocked by:** #${I[T16]} #${I[T15]} #${I[T18]}")

# ── 5. Wave 2 ─────────────────────────────────────────────────────────────
I[T19]=$(mk "backend(test): cross-service OIDC end-to-end (testcontainers + fake Google)" "backend,auth,wave-2" \
"**Agent:** backend-engineer
**Wave:** 2
**Epic:** #${I[EA]}  ·  **Plan task:** T19

## Context
New tests/oidc-e2e/ (slice-style) with a fake Google (token endpoint + JWKS) — no live IdP. Exercises authorize→callback→link→mint end to end. Independent of Track B — finishes first.

## Acceptance criteria
- [ ] e2e happy path: first-link then subsequent.
- [ ] all Critical/High rejections end to end: R1 (each invalid field), R2 (cross-tenant first-link), R3 (cross-tenant subsequent), R4 (state replay/unknown), R5 (nonce), R6 (PKCE missing verifier), R10 (fresh family), R13 (sub-pinned), R14 (normalization).

**Blocked by:** #${I[T10]} #${I[T11]} #${I[T12]} #${I[T13]}")

I[T20]=$(mk "infra(ci): wire cold_smoke_aws job against the real provisioned S3 bucket" "infra,wave-2" \
"**Agent:** devops-engineer
**Wave:** 2
**Epic:** #${I[EB]}  ·  **Plan task:** T20

## Context
New .github/workflows/cold-smoke-aws.yml (gated/manual or post-apply; sets COLD_BUCKET/COLD_GLUE_DB/COLD_ATHENA_RESULT_BUCKET from T18 outputs; runs go test -tags=cold_smoke_aws ./tests/cold-tier-smoke/...) + Makefile target. Smoke test already written (skips without env vars).

## Acceptance criteria
- [ ] smoke canary passes against real S3/Athena/Glue (EnsureGlueTable → WriteParquet → partition → bound/no-tenant/wrong-tenant/dialect).
- [ ] Unblocks #63 AC#3.

**Blocked by:** #${I[T18]}")

I[T21]=$(mk "backend(deploy): flip COLD_ENABLED / COLD_SEARCH_ENABLED (closes #63 AC#3)" "backend,infra,wave-2" \
"**Agent:** backend-engineer + devops-engineer
**Wave:** 2
**Epic:** #${I[EB]}  ·  **Plan task:** T21

## Context
Set both true in docker-compose.aws.yml / SSM / deploy env + config-comment notes in query-service/processor. Valid ONLY after T20 green (the documented gate, decision 016 §6). Closes the long-deferred #63 AC#3.

## Acceptance criteria
- [ ] post-flip, query-service routes cold reads + processor tees to real S3.
- [ ] re-run T20 smoke green.
- [ ] Closes #63 AC#3.

**Blocked by:** #${I[T20]}
**Closes (AC):** #63 (AC#3 only — the COLD_ENABLED/COLD_SEARCH_ENABLED flip)")

I[T22]=$(mk "security: review gates (SG/IAM/TLS/Terraform-state hardening)" "security,infra,wave-2" \
"**Agent:** security-architect
**Wave:** 2
**Epic:** #${I[EB]}  ·  **Plan task:** T22

## Context
Review-only over T16/T17/T18 (+ checklist note in docs/security/). Asserts threat-model controls landed in IaC.

## Acceptance criteria
- [ ] SG inbound = {443,80} only, no 22 (D3).
- [ ] IAM SSM read scoped to the param path, not ssm:* (R8).
- [ ] Terraform state bucket private + encrypted + versioned (ADR-0010).
- [ ] Caddy enforces HTTPS + HSTS; cookies Secure in non-dev (R16).

**Blocked by:** #${I[T16]} #${I[T17]} #${I[T18]}")

I[T23]=$(mk "infra(demo): live Google end-to-end on the provisioned domain (critical-path join)" "infra,auth,wave-2" \
"**Agent:** lead-engineer (validation) + devops-engineer (env)
**Wave:** 2
**Epic:** #${I[EB]}  ·  **Plan task:** T23

## Context
Runbook note (Google console redirect URI = https://<domain>/auth/google/callback); no app code. THE hard cross-track join — needs T17 (EC2/EIP running compose) + T18 (Route53 + Caddy/ACME TLS) + T10/T13 (the working flow). Google rejects non-HTTPS redirect URIs.

## Acceptance criteria
- [ ] a provisioned user signs in via real Google, lands authenticated with lg_at/lg_rt.
- [ ] an unprovisioned Google user is rejected (401, invite-only).
- [ ] (transport https-only R16)

**Blocked by:** #${I[T10]} #${I[T13]} #${I[T17]} #${I[T18]}")

# ── 6. Pass 2 — fill epic child checklists with real numbers ───────────────
gh issue edit "${I[EA]}" --body "Master tracker for Google OAuth sign-in (Track A). Invite-only; PKCE S256; state/nonce/verifier in control-plane Redis (D1); web BFF is a thin relay.

Plan: docs/superpowers/plans/2026-06-28-google-oauth-and-aws-iac-plan.md
Spec: docs/superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md

## Child tasks
- [ ] #${I[T01]} contracts: OIDC DTOs
- [ ] #${I[T02]} state store
- [ ] #${I[T03]} email normalize
- [ ] #${I[T04]} oauth-identity repo
- [ ] #${I[T07]} id_token verifier
- [ ] #${I[T08]} authorize endpoint
- [ ] #${I[T09]} callback endpoint
- [ ] #${I[T10]} linking + session + audit
- [ ] #${I[T11]} rate-limit + no-PII logging
- [ ] #${I[T12]} migration wiring + RLS validation
- [ ] #${I[T13]} web relay + Sign in with Google
- [ ] #${I[T19]} cross-service OIDC e2e"

gh issue edit "${I[EB]}" --body "Master tracker for AWS IaC (Track B). Single t4g.small EC2 + EIP, Terraform, Caddy/ACME TLS, SSM admin (no port 22, D3), real S3 cold tier, AWS Budget \$30.

Plan: docs/superpowers/plans/2026-06-28-google-oauth-and-aws-iac-plan.md

## Child tasks
- [ ] #${I[T05]} Node Dockerfiles
- [ ] #${I[T06]} TF state backend
- [ ] #${I[T14]} multi-arch CI
- [ ] #${I[T15]} docker-compose.aws.yml
- [ ] #${I[T16]} TF network
- [ ] #${I[T17]} TF compute
- [ ] #${I[T18]} TF data/managed services
- [ ] #${I[T20]} cold_smoke_aws CI
- [ ] #${I[T21]} COLD flag flip (#63 AC#3)
- [ ] #${I[T22]} security review gates
- [ ] #${I[T23]} live Google e2e demo"

# ── 7. Echo the task-id → issue-number map (paste into the delivery ledger) ─
for k in EA EB T01 T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 T12 T13 T14 T15 T16 T17 T18 T19 T20 T21 T22 T23; do
  printf '%s = #%s\n' "$k" "${I[$k]}"
done
```

---

## 5. Relationship notes

- **T21 ↔ existing #63 AC#3 (REAL dependency).** Issue #63 (`cold-tier retention + cold-read routing`, MERGED 38d040a / PR #81) deliberately left **AC#3 unchecked**: "Flip `COLD_ENABLED` / `COLD_SEARCH_ENABLED` to true", gated on the real-AWS `cold_smoke_aws` smoke passing (decision 016 §6). That smoke could not run because no real S3/Glue existed. This plan provisions it (T18) and wires the gated job (T20); **T21 performs the flip and closes #63 AC#3.** Chain: **T18 → T20 → T21 ⇒ #63 AC#3 done.** T21's body carries `Closes (AC): #63 (AC#3 only)` so the link is visible from #63. (The delivery ledger `.superpowers/delivery-progress.md` has tracked this as a deferred follow-up since Session "LOOP COMPLETE"; T21 retires it.)
- **#24 (NOT related).** Issue #24 (`ux: Code Connect mapping (Figma ↔ React)`, OPEN, blocked on the Figma license gate, owner ux-designer, Wave 4 of the prior MVP milestone) is **unrelated** to this OAuth/IaC delivery. It shares no files, owner, or dependency with any of T01–T23. Leave it untouched; it remains the only pre-existing open issue and should NOT be added to either epic or this milestone.

---

## 6. Confirmation

**NO GitHub issues, labels, or milestones were created or modified in producing this draft.** Only read-only `gh` commands ran (`gh label list`, `gh issue view/list`, `gh api .../milestones` GET, `gh repo view`). The §4 script is held for explicit user approval before any `gh issue create` / `gh label create` runs.
