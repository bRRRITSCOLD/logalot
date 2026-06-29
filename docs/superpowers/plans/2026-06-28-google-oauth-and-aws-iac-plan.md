# Implementation Plan — Google OAuth Sign-In + AWS IaC (cost-first PoC)

- **Status:** Draft for project-manager transcription (PLAN-ONLY; no code in this phase)
- **Date:** 2026-06-28
- **Author:** lead-engineer
- **Inputs (decided — not relitigated here):** spec `2026-06-28-google-oauth-and-aws-iac-design.md`; ADR-0007/0008/0009/0010/0011; threat model `threat-model-google-oauth.md` (R1–R16); data model `model.md` §4.6/§6 + `migration-plan.md` §6 + migration `000017`; C4 `google-oauth-aws-deployment.md`.
- **Output consumer:** `project-manager` transcribes each task below into one GitHub issue (default one issue → one PR), mirroring the `blockedBy` edges.

This plan sequences the two tracks into PR-sized tasks. Track A (Google OAuth) is `control-plane` + `web` + `contracts` only — downstream (`TenantContext`, query-service authenticator, kernel) is untouched (ADR-0008). Track B (AWS IaC) is greenfield `infra/aws/` + Docker/CI packaging. The two tracks are parallel-safe except for one hard join (below).

---

## 0. Cross-cutting technical decisions (made here, as lead-engineer)

These are the calls that span multiple specialists / services. They are decided so implementers do not diverge.

### D1 — state/nonce/PKCE-verifier live in control-plane Redis; web BFF is a thin relay (supersedes ADR-0008's cookie-sealed approach)

ADR-0008 chose a signed+encrypted httpOnly cookie on the `web` BFF, with the BFF minting `state`/`nonce` and forwarding only `{code, nonce}`. **That forwarding shape cannot carry a PKCE `code_verifier`** — and the spec/threat-model now require **PKCE S256 (R6)**, whose verifier must be present at the token-exchange point, which is **control-plane** (it holds `client_secret`). Putting the verifier in a client cookie (even encrypted) is strictly weaker than keeping it server-side.

**Decision:** `control-plane` generates `state`, `nonce`, and `code_verifier`, stores `{tenantSlug, nonce, code_verifier, returnTo, created_at}` in **Redis keyed by `state`** with a ~10-minute TTL and **single-use delete-on-consume** (atomic). `web` is a thin relay: it calls control-plane to start the flow, 302s the browser to the returned authorize URL, and on return relays `{code, state}` back to control-plane.

This is **not a relitigation** — it is ADR-0008's *own documented reversibility trigger* ("the same `{state, nonce, redirect}` record moves into the already-present Redis behind an internal interface — no flow change"; "Move state/nonce to Redis if … becomes a requirement"). The PKCE requirement is that requirement. **Action item:** PM files a one-line ADR-0008 supplement note to `systems-architect` recording this; it is not blocking.

Cost: `control-plane` gains a Redis dependency it does not have today (the Go side already uses Redis; control-plane/Node does not). Mitigated by hiding it behind an `OAuthStateStore` port with an in-memory fake for tests (T02). Redis is already on the box ($0 infra).

### D2 — Endpoint split (web BFF ↔ control-plane)

Two new control-plane endpoints, under the existing `/v1/auth/*` namespace (consistent with `/v1/auth/login`):

| Endpoint | Owner | Body | Responsibility |
|---|---|---|---|
| `POST /v1/auth/oidc/google/authorize` | control-plane | `{ tenantSlug, returnTo? }` | Mint+store `state`/`nonce`/`code_verifier`; build Google authorize URL (fixed server-side `redirect_uri`, `code_challenge`=S256, `scope=openid email`); return `{ authorizeUrl }`. |
| `POST /v1/auth/oidc/google/callback` | control-plane | `{ code, state }` | Consume Redis record by `state` (single-use); reject unknown/expired/consumed **before** any Google call; exchange `code` (with `code_verifier`); fully validate `id_token`; resolve+link user; mint the **same** access JWT + rotating refresh as the password path; return `TokenPair`. |

`web` server functions relay both and own the browser side: the "Sign in with Google" button, the `/auth/google/callback` route, the `returnTo` same-origin allowlist (R7), and setting/clearing the existing `lg_at`/`lg_rt` session cookies via the existing `sessionCookieAttributes()` (R16). The web BFF **optionally** also sets the `state` value in an httpOnly cookie and asserts it on return (browser-binding, defense-in-depth) — non-load-bearing; the authoritative single-use guard is the control-plane Redis record.

### D3 — Admin access to the EC2 box: SSM Session Manager (no SSH ingress)

Security-architect flagged SSM Session Manager vs locked-CIDR SSH. **Decision: SSM Session Manager.** The SG opens **only 443 + 80** inbound (80 for ACME HTTP-01 + HTTP→HTTPS redirect); **no port 22**. Admin shell is `aws ssm start-session`, gated by IAM, fully audited, no key material on the box. The instance profile gets the AWS-managed `AmazonSSMManagedInstanceCore` policy (SSM agent ships in Amazon Linux 2023 / Ubuntu AMIs). **Documented fallback:** if SSM is unavailable, open 22 to a single admin CIDR var (`admin_cidr`) — built as a togglable variable, default closed.

### D4 — Image packaging: two new Node Dockerfiles + multi-arch CI

The repo has **one** Dockerfile (Go services, `SERVICE=` arg). `control-plane` (Node/Fastify) and `web` (TanStack Start) have **no** Dockerfile today (the slice compose only runs the Go trio). The AWS box needs all 7 app images as `linux/arm64`. **Decision:** add `Dockerfile.control-plane` and `Dockerfile.web` (T05); publish all 7 images multi-arch (`linux/arm64` + `linux/amd64` for CI/local) via `docker buildx` in CI (T14).

### D6 — Multi-tenant membership: per-tenant uniqueness, no SECURITY DEFINER resolver (user design change, 2026-06-28)

**The user changed the requirement:** a single Google account **MUST** sign into **multiple tenants** (multi-tenant membership). This supersedes the PoC "one Google account ↔ one user, ever" decision (ADR-0008 / model.md §6.4 — which had pre-described this exact relax as the documented future change).

Concrete consequences baked into the plan:

1. **Constraint:** `UNIQUE(provider, provider_sub)` (GLOBAL) → **`UNIQUE(tenant_id, provider, provider_sub)`** (per-tenant). `UNIQUE(tenant_id, user_id, provider)` is retained. Net: one Google account → at most one user **per tenant**, linkable independently in many tenants.
2. **Drop the `SECURITY DEFINER` resolver** `app.resolve_oauth_identity_by_sub` entirely (and its grant/revoke and `.down.sql` line). The tenant is **always known before lookup**: every login carries a tenant hint via the server-side single-use `state` from the tenant-scoped login page. Subsequent-login lookup = **arm RLS with `state.tenant_id`, then an RLS-scoped `SELECT … WHERE provider = $ AND provider_sub = $`**. No global, no-tenant lookup exists anymore.
3. **The old cross-tenant cross-check (old R3) becomes structural.** Because the by-sub `SELECT` runs *inside* `state.tenant_id`'s RLS context, it is **impossible to resolve into any other tenant** — there is no code path that can return tenant A's identity when the user is on tenant B's login page. A sub linked only in A, presented via B's page, simply finds nothing in B and falls through to the **first-link-in-B** path (link if the email is provisioned in B; 401 otherwise). That is exactly the desired multi-tenant behavior.

This removes data-architect open-question #1 (the resolver's dependency on `POSTGRES_USER` being a superuser) — **it is now MOOT**: there is no `SECURITY DEFINER` bypass, control-plane stays entirely on its single `NOSUPERUSER` `logalot_app` pool, every OIDC DB statement runs under RLS.

**Migration impact:** `000017` was authored (data phase) with the global constraint + the resolver. Since it is freshly authored and not yet deployed, **T12 amends `000017` in place** (constraint swap + drop resolver fn + fix `.down.sql`) rather than adding a follow-up migration. **Coordinate with data-architect** — the DDL change is theirs to confirm; the plan records the required shape.

### D5 — Data-architect open questions (resolved)

| # | Question | Resolution |
|---|---|---|
| 1 | `POSTGRES_USER` superuser in target envs (resolver bypass depends on it) | **MOOT (D6).** The `SECURITY DEFINER` resolver is dropped; there is no RLS bypass. Control-plane runs the by-sub lookup RLS-scoped on its `NOSUPERUSER` `logalot_app` pool. No superuser dependency remains. |
| 2 | `UNIQUE(provider, provider_sub)` GLOBAL = one Google account per user — intent? | **Superseded by D6.** Now `UNIQUE(tenant_id, provider, provider_sub)`: one Google account → one user **per tenant**, multi-tenant membership supported. |
| 3 | First-link unique violation → 401/409 not 500 | **Resolved (semantics shift under D6).** `23505` on the per-tenant `UNIQUE(tenant_id, provider, provider_sub)` is now a **within-tenant** concurrency case (two racing first-links in the same tenant): the OIDC authenticator catches it via `isUniqueViolation` (tenant-tx.ts) and **re-resolves the now-existing row in-tenant and proceeds** (idempotent first-link), never a 500. Covered in T10. |
| 4 | Optional dev seed `oauth_identities` row | **Yes, optional, DEV ONLY.** Added to `migrations/seeds/dev_tenant.sql` under `SET LOCAL app.tenant_id`, `ON CONFLICT DO NOTHING`, placeholder `provider_sub`, normalized `admin@dev.local` (T12). |
| 5 | `oauth_identities.email` staleness on Google email change | **Resolved: leave as link-time snapshot.** Identity is pinned to `sub` (R13); the snapshot is audit-only and never re-resolves. No re-sync logic. |

---

## 1. Build-order rationale + foundations that must land first

The work has three layers of dependency:

1. **Shared contracts & seams** (Wave 0) — the OIDC DTOs (`contracts`), the `OAuthStateStore` port + Redis adapter, the `OAuthIdentityRepository`, the shared email-normalization helper, and the two Node Dockerfiles + Terraform state backend. Everything downstream compiles/builds against these, so they land first and are mostly file-disjoint (parallel-safe).
2. **Track-internal cores** (Wave 1) — Track A's verifier → authorize → callback → linking chain (a serialized chain on `control-plane` shared files), plus the parallel `web` relay; Track B's images, AWS compose, and Terraform network/compute/data layers.
3. **Integration, end-to-end, and the cold-smoke flip** (Wave 2) — the cross-service OIDC e2e, the `cold_smoke_aws` job against the *real* provisioned S3, the `#63 AC#3` flag flip, the security-architect review gates, and the single live-Google end-to-end demo (the critical-path join).

**Foundations that gate everything (land first, Wave 0):** T01 (contracts), T02 (state store), T03 (email normalize), T04 (oauth identity repo), T05 (Node Dockerfiles), T06 (TF state backend).

---

## 2. Critical path, parallelism, and file-contention

**Critical path (longest dependency chain to the demoable outcome):**

```
T01 contracts
  → T07 id_token verifier ─┐
  → T08 authorize endpoint ┤→ T09 callback endpoint → T10 linking+session+audit
T02 state store ───────────┘                              │
T04 oauth-identity repo ──────────────────────────────────┤
T03 email normalize ──────────────────────────────────────┘
                                                           → T19 OIDC e2e
                                                           ↘
T06 TF state → T16 TF network → T17 TF compute (EC2+EIP+user-data)  → T23 LIVE Google e2e demo
                              ↘ T18 TF data (Route53/S3/SSM/Caddy TLS) ─┘
T05 Dockerfiles → T15 AWS compose → T17
T18 TF data (S3) → T20 cold_smoke_aws → T21 COLD flag flip (#63 AC#3)
```

**The one hard cross-track join:** Track A's **live** end-to-end demo (T23) needs a real HTTPS redirect URI (Google rejects non-HTTPS), which needs **Route53 + Caddy/Let's Encrypt on the running EC2** (T17 + T18). All other Track A work (unit + integration + the testcontainers OIDC e2e T19) is **fully independent of Track B** and can finish first. Sequence so Track A's logic is done-and-tested while Track B stands up the domain/TLS, then join only for T23.

**Parallel-safe lanes (genuinely file-disjoint):**
- **Lane A-verify:** T07 (new `adapters/crypto/google-*` + `adapters/http/google-oidc-client.ts` files only).
- **Lane A-web:** T13 (new `apps/web/src/server/oidc.ts` + `routes/auth/google/callback.tsx`; one small edit to `login.tsx`).
- **Lane B-pkg:** T05, T14, T15 (Dockerfiles, CI, new `docker-compose.aws.yml`).
- **Lane B-infra:** T06, T16, T17, T18 (all new files under `infra/aws/`).

**File-contention notes (serialize within a lane):**
- `services/control-plane/src/adapters/http/routes.ts`, `container.ts`, `app/ports.ts`, `config/env.ts` are touched by T02, T08, T09, T10, T11. **Serialize the control-plane endpoint chain T08 → T09 → T10 → T11** (each a coherent PR adding its block); T07 and T04 are file-disjoint and run alongside.
- `.env.example` is touched by both tracks (T02 Redis vars; T15/T18 AWS vars). **Coordinate via the PM:** T02 lands the OAuth/Redis block first; Track B appends its block — non-overlapping sections, but rebase order matters.
- `Makefile` is touched by T12 (migrate/seed already wired — minimal), T14, T15, T20. Distinct targets; low risk.
- `migrations/000017_*.sql` is **already authored** (data phase) — no task edits it; T12 only *wires* it (migrate step is already in `make migrate-up`) and adds the dev-seed row + validation tests.

---

## 3. Waves

Each task: **title · owner · files · integration points · blockedBy · test cases (tier; R-mapping)**. Tiers: **unit** (vitest/Go table tests, no I/O), **integration** (testcontainers: Redis/Postgres), **e2e** (cross-service / real-AWS / live).

### Wave 0 — Foundations (parallel-safe)

**T01 — Contracts: OIDC request/response DTOs**
- **Owner:** backend-engineer
- **Files:** `packages/contracts/src/oauth.ts` (new): `oidcAuthorizeRequestSchema { tenantSlug, returnTo? }`, `oidcAuthorizeResponseSchema { authorizeUrl }`, `oidcCallbackRequestSchema { code, state }`; export from `packages/contracts/src/index.ts`.
- **Integration points:** consumed by control-plane `routes.ts` (T08/T09) and web `server/oidc.ts` (T13) — the same schemas both sides validate (no drift), mirroring `auth.ts`.
- **blockedBy:** none
- **Tests:** unit — valid payloads parse; `returnTo` rejects absolute/`//`/`\\` forms; `code`/`state` non-empty; `tenantSlug` reuses `tenantPublicIdSchema`. *(supports R7)*

**T02 — control-plane OAuth in-flight state store (port + Redis adapter + config)**
- **Owner:** backend-engineer
- **Files:** `app/ports.ts` (add `OAuthStateStore { put(state, record, ttlSeconds); consume(state): record|null }`, atomic delete-on-consume); `adapters/redis/redis-client.ts` (new); `adapters/redis/oauth-state-store.ts` (new); `adapters/redis/in-memory-state-store.ts` (new test fake); `config/env.ts` (+`REDIS_URL`/host/port/password); `container.ts` (wire); `.env.example` (Redis block for control-plane).
- **Integration points:** Redis (already on the box / in compose). Consumed by T08 (put) and T09 (consume).
- **blockedBy:** none
- **Tests:** unit (fake) — `consume` returns the record once then `null` (single-use); TTL expiry → `null`. integration (testcontainers Redis) — atomic consume under two concurrent callers: exactly one wins. *(R4 store-side, R5 nonce-record single-use)*

**T03 — Shared email-normalization helper + provisioning parity**
- **Owner:** backend-engineer
- **Files:** `services/control-plane/src/domain/email.ts` (new `normalizeEmail` = lowercase + trim + NFC, no further unicode folding); apply in `app/user-service.ts` (+ `tenant-service.ts provisionAdmin`) at provisioning; export for OIDC match (T10).
- **Integration points:** `oauth_identities.email` and the first-link `users` match must use the identical normalization (model.md §6.3).
- **blockedBy:** none
- **Tests:** unit — `User@X.com ` → `user@x.com`; NFC composition cases; idempotent; no homograph fold. *(R14)*

**T04 — OAuthIdentityRepository (port + Postgres adapter) — tenant-scoped, no resolver (D6)**
- **Owner:** backend-engineer
- **Files:** `app/ports.ts` (add `OAuthIdentityRepository`); `adapters/postgres/oauth-identity-repository.ts` (new) — **`findByProviderSub(tenantId, provider, sub): {id, userId}|null`** RLS-scoped `SELECT` under `withTenantTx` (no `SECURITY DEFINER`, no global lookup — D6); `linkFirst(tenantId, {userId, providerSub, email})` INSERT under `withTenantTx` (catches `23505` via `isUniqueViolation` → re-resolve in-tenant, idempotent); `touchLastLogin(tenantId, id)` UPDATE under RLS; `container.ts` wiring.
- **Integration points:** migration `000017` as amended in T12 (table + per-tenant `UNIQUE(tenant_id, provider, provider_sub)`, **resolver removed**). Uses the existing `withTenantTx`/`isUniqueViolation` (tenant-tx.ts). Control-plane stays on the single `NOSUPERUSER` `logalot_app` pool.
- **blockedBy:** none (DDL amended in T12; this can build against the amended shape)
- **Tests:** integration (testcontainers Postgres, `logalot_app` role) — `findByProviderSub` returns the row **only under the matching tenant's RLS context**; the same `(provider, sub)` linked in tenant A is **invisible** under tenant B's context (returns null → first-link-in-B path); unknown sub → null; first-link INSERT visible only under its tenant; **same `(provider, sub)` links successfully in A *and* B (multi-tenant membership)**; duplicate `(tenant_id, provider, sub)` within one tenant → `23505` (caught → re-resolve). *(R2 storage-side; R3 now structural via RLS-scoped lookup; D5-Q3 in-tenant conflict)*

**T05 — Node service Dockerfiles (control-plane + web), arm64-capable**
- **Owner:** devops-engineer
- **Files:** `Dockerfile.control-plane` (new, multi-stage pnpm build → non-root runtime); `Dockerfile.web` (new); `.dockerignore` touch if needed.
- **Integration points:** consumed by T14 (multi-arch publish) and T15 (AWS compose).
- **blockedBy:** none
- **Tests:** CI — `docker buildx build --platform linux/arm64` of both succeeds; container starts and `/healthz`/readiness responds (smoke). *(build gate; supports R16 once behind Caddy)*

**T06 — Terraform skeleton + remote state backend (S3, encrypted, versioned, native lock)**
- **Owner:** devops-engineer
- **Files:** `infra/aws/` (new): `backend.tf` (S3 backend, versioning + SSE + native lock), `versions.tf`, `variables.tf`, `providers.tf`, `README.md` (bootstrap steps), `bootstrap/` (one-time state-bucket create).
- **Integration points:** all later TF tasks (T16/T17/T18) use this backend.
- **blockedBy:** none
- **Tests:** `terraform init`/`validate`/`fmt -check` in CI (new `tf-validate` job). State bucket is private + versioned + encrypted (assert in plan). *(supports R8/ADR-0010 state-hardening; security-architect review in T22)*

### Wave 1 — Track A cores (serialized control-plane chain + parallel web) · Track B packaging + infra

**T07 — Google `id_token` verifier + token-exchange client**
- **Owner:** backend-engineer
- **Files:** `adapters/crypto/google-id-token-verifier.ts` (new — `jose` JWKS by `kid`, RS256 only, reject `none`/HS*, `iss ∈ {accounts.google.com, https://accounts.google.com}`, `aud == client_id`, `azp`, `exp`+skew, `nonce` equality, `email_verified === true`; JWKS cached with bounded TTL, single refetch on unknown `kid`); `adapters/http/google-oidc-client.ts` (new — code→token exchange with `code_verifier`); `app/ports.ts` (verifier + token-client ports); `config/env.ts` (+`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_ISSUER`/discovery).
- **Integration points:** called by T09 callback. `client_secret` read from env (sourced from SSM on the box, T18).
- **blockedBy:** T01
- **Tests:** unit (one per failing field) — bad/absent signature; `alg:none`; `alg:HS256`; wrong `iss`; wrong `aud`; expired `exp`; `email_verified:false`; missing/mismatched `nonce`. JWKS rotation: token under new `kid` validates after one refetch; unknown `kid` → reject; verifier selects key by token `kid`, never an embedded key; accepts only RS256. **`client_secret`/`id_token` never returned or logged.** *(R1 each field, R5 nonce, R9 rotation, R8/R12 no-leak)*

**T08 — Authorize-initiation endpoint (PKCE + returnTo allowlist)**
- **Owner:** backend-engineer
- **Files:** `app/oidc-authenticator.ts` (new — `beginAuthorize(tenantSlug, returnTo)`: gen `state` (≥128-bit), `nonce`, `code_verifier`; `code_challenge`=S256; `OAuthStateStore.put`; build authorize URL with **fixed** server `redirect_uri`, `scope=openid email`, `code_challenge_method=S256`); `adapters/crypto/node-random.ts` (extend for verifier/challenge or new `pkce.ts`); `adapters/http/routes.ts` (`POST /v1/auth/oidc/google/authorize`, public); `container.ts`.
- **Integration points:** `OAuthStateStore` (T02); contracts (T01).
- **blockedBy:** T01, T02
- **Tests:** unit — authorize URL contains `code_challenge` + `code_challenge_method=S256`, `state`, `nonce`, fixed `redirect_uri` (never from request); `state` ≥128-bit + server-generated; `returnTo` absolute/`//evil`/`\\evil` rejected → default. integration — a stored record is retrievable exactly once. *(R4 mint, R6 authorize-half, R7 fixed redirect_uri)*

**T09 — Callback endpoint (consume state → exchange → verify)**
- **Owner:** backend-engineer
- **Files:** `app/oidc-authenticator.ts` (add `handleCallback(code, state)`: `OAuthStateStore.consume` — reject unknown/expired/consumed **before any Google call**; exchange `code` with `code_verifier`; verify `id_token` via T07 using the record's `nonce`); `adapters/http/routes.ts` (`POST /v1/auth/oidc/google/callback`, public).
- **Integration points:** T02 (consume), T07 (exchange+verify). Hands the verified `(sub, email, tenantSlug)` to T10.
- **blockedBy:** T07, T08, T02
- **Tests:** unit/integration — missing/unknown/expired/already-consumed `state` → 401, **zero outbound Google calls** (assert with a fake client); replayed valid `state` → 401 (single-use); nonce mismatch → 401; missing/mismatched `code_verifier` → exchange fails → 401, no session. *(R4, R5, R6 exchange-half, R11 pre-Google rejection)*

**T10 — Account linking + session mint + audit — tenant-always-known (D6)**
- **Owner:** backend-engineer
- **Files:** `app/oidc-authenticator.ts` (resolve+link+mint). **Single tenant-scoped flow (no global resolver, no cross-check — D6):** `tenants.findByPublicId(state.tenantSlug)` → `SET LOCAL app.tenant_id = tenant.id` → `OAuthIdentityRepository.findByProviderSub(tenant.id, 'google', sub)`. **Found** → subsequent login in this tenant → `touchLastLogin` → mint. **Not found** → first-link-in-this-tenant: `users.findCredentialsByEmail(tenant.id, normalizeEmail(id_token.email))` → no match → 401 (no row) → match → `linkFirst` (23505 → re-resolve in-tenant, proceed). On success mint via the **same** `AuthService` path (new refresh family + access JWT); emit audit events; `domain/errors.ts` if needed.
- **Integration points:** `AuthService` mint (auth-service.ts), `OAuthIdentityRepository` (T04), `normalizeEmail` (T03), `TenantRepository.findByPublicId` + `UserRepository.findCredentialsByEmail` (existing). Cross-tenant isolation is now **structural** (the by-sub lookup never leaves `state.tenant_id`'s RLS context) — no explicit mismatch check.
- **blockedBy:** T09, T04, T03
- **Tests:** integration (testcontainers Postgres) — first-link: email provisioned only in tenant A, login via tenant B page → **401, no `oauth_identities` row in B**; **multi-tenant membership: a Google `sub` linked in A *and* B (user provisioned in both) → login from A's page resolves A's user, login from B's page resolves B's user** (correct tenant each time); cross-tenant structural: `sub` linked only in A, login via B where the email is provisioned in B → **links into B** (new B row), where the email is **not** provisioned in B → **401** (never resolves into A); success mints a **new** refresh `familyId` distinct from any prior; second login same `sub` + changed email resolves the **same** in-tenant user (no new row); normalized `User@X.com` matches `user@x.com`; audit record emitted on first-link, login, and each reject (tenant_id, user_id?, provider, hashed sub, outcome, ts). *(R2, R3-structural, R10, R13, R14, R15, D5-Q3)*

**T11 — Callback rate-limiting + no-PII/secret logging**
- **Owner:** backend-engineer
- **Files:** `adapters/http/rate-limit.ts` (new, per-IP + global on the OIDC routes — reuse Redis from T02 or `@fastify/rate-limit`); apply in `routes.ts`; logging audit pass across the OIDC code (redact/hash `sub`/`email`, never log `id_token`/`code`/`client_secret`).
- **Integration points:** Redis (T02) for the limiter store; the OIDC endpoints (T08/T09).
- **blockedBy:** T09
- **Tests:** integration — `429` after threshold on the callback; bad-`state` path makes **zero** Google calls; log-capture across a full login asserts no raw `id_token`/`code`/`client_secret`/full `email`, `sub`/`email` only hashed/redacted. *(R11, R12, R8 log-side)*

**T12 — Migration 000017 amendment (per-tenant unique, drop resolver) + RLS validation + optional dev seed (D6)**
- **Owner:** backend-engineer (coordinate with data-architect — DDL change is theirs to confirm)
- **Files:** `migrations/000017_oauth_identities.up.sql` — **change `UNIQUE(provider, provider_sub)` → `UNIQUE(tenant_id, provider, provider_sub)`** and **delete the `CREATE FUNCTION app.resolve_oauth_identity_by_sub` block + its `REVOKE`/`GRANT`** (D6); `migrations/000017_oauth_identities.down.sql` — **remove the `DROP FUNCTION … resolve_oauth_identity_by_sub` line** (function no longer exists); `migrations/seeds/dev_tenant.sql` (append optional dev `oauth_identities` row under `SET LOCAL app.tenant_id`, `ON CONFLICT DO NOTHING`); a migration integration test (extend `tests/` or control-plane integration suite). Since `000017` is freshly authored and undeployed, amend in place (no follow-up migration).
- **Integration points:** RLS policy on `oauth_identities`; `logalot_app` table DML grants from `000011` default privileges (no function grant anymore).
- **blockedBy:** none (DB-only; feeds T04/T10/T19)
- **Tests:** integration (testcontainers, full up→down→up) — RLS fail-closed (no context ⇒ 0 rows; foreign-tenant INSERT ⇒ `WITH CHECK` reject); **per-tenant uniqueness: same `(provider, sub)` inserts successfully under tenant A *and* tenant B (multi-tenant); a duplicate `(tenant_id, provider, sub)` within one tenant ⇒ `23505`**; an RLS-scoped by-sub `SELECT` returns the row only under the matching tenant's context (none cross-tenant); **assert `app.resolve_oauth_identity_by_sub` no longer exists** (function dropped); same-tenant composite FK violation; dev seed idempotent. *(R2/R3-structural storage; D5-Q1 moot, D5-Q4)*

**T13 — web BFF thin relay + "Sign in with Google" + callback route**
- **Owner:** frontend-engineer
- **Files:** `apps/web/src/server/oidc.ts` (new — `startGoogleSignin({tenantSlug, returnTo})` server fn → control-plane `/authorize` → returns `authorizeUrl`; `completeGoogleSignin({code, state})` server fn → control-plane `/callback` → on success `writeSessionCookies` + return validated `returnTo`); `apps/web/src/server/control-plane.ts` (add `cpOidcAuthorize`/`cpOidcCallback` using T01 contracts); `apps/web/src/routes/auth/google/callback.tsx` (new — reads `code`/`state`, calls `completeGoogleSignin`, redirects); `apps/web/src/routes/login.tsx` (add the button → `startGoogleSignin` → `window.location` 302); optional state httpOnly cookie helper in `server/session.ts`.
- **Integration points:** reuses `sessionCookieAttributes()` (R16), `ControlPlaneError` collapse-to-generic pattern (auth.ts). `returnTo` same-origin allowlist (relative only).
- **blockedBy:** T01 (contracts); contract-only dependency on T08/T09 (can build against the schema before they merge)
- **Tests:** unit (vitest) — `returnTo` `//evil.com`/`https://evil.com`/`\\evil.com` rejected → default; success sets `lg_at`/`lg_rt` with `HttpOnly`+`Secure`(per `COOKIE_SECURE`)+`SameSite=Lax`; control-plane 4xx collapses to one generic message (no enumeration). *(R7, R16)*

**T14 — Multi-arch (arm64) image publishing in CI for all 7 app images**
- **Owner:** devops-engineer
- **Files:** `.github/workflows/release-images.yml` (new — `docker buildx` matrix: 5 Go via `SERVICE=` + control-plane + web; `linux/arm64`+`linux/amd64`; push to registry on tag/main); `Makefile` (buildx targets).
- **Integration points:** T05 Dockerfiles; the AWS compose (T15) pulls these tags.
- **blockedBy:** T05
- **Tests:** CI — all 7 manifests build for `linux/arm64`; published manifest is multi-arch (assert `docker buildx imagetools inspect`).

**T15 — AWS docker-compose (drop mongo/floci, add Caddy, mem-limits + swap, real S3)**
- **Owner:** devops-engineer
- **Files:** `docker-compose.aws.yml` (new — postgres/redis/rabbitmq + 5 Go + control-plane + web + **Caddy**; **no** mongodb, **no** floci; per-container `mem_limit` (ADR-0011 budget); cold-tier env points at **real S3** not floci); `Caddyfile` (new — TLS terminate + reverse-proxy to web/query/control/ingest, HSTS); `.env.example` (AWS block). Per-container limits + a ~2GB gp3 swap file are configured here / in user-data (T17).
- **Integration points:** consumed by EC2 user-data (T17); images from T14; S3/SSM from T18.
- **blockedBy:** T05
- **Tests:** `docker compose -f docker-compose.aws.yml config` validates; a local bring-up smoke (mongo/floci absent; mem_limits present). Caddy config `caddy validate`. *(R16 HSTS/TLS termination)*

**T16 — Terraform: network layer (VPC / public subnet / IGW / route / SG; SSM admin)**
- **Owner:** devops-engineer
- **Files:** `infra/aws/network.tf` (VPC, 1 public subnet, IGW, route table); `infra/aws/security.tf` (SG: inbound **443 + 80** only, egress open; **no 22** by default; togglable `admin_cidr` SSH fallback var per D3).
- **Integration points:** EC2 (T17) attaches to this subnet/SG.
- **blockedBy:** T06
- **Tests:** `terraform validate`/`plan`; policy assertion — SG has no `0.0.0.0/0:22` ingress by default; only 443/80 open. *(R16, security-architect review T22)*

**T17 — Terraform: compute (EC2 t4g.small + EIP + gp3 + instance profile + user-data)**
- **Owner:** devops-engineer
- **Files:** `infra/aws/compute.tf` (t4g.small ARM64, 30GB gp3, Elastic IP); `infra/aws/iam.tf` (instance profile: `AmazonSSMManagedInstanceCore` + **least-priv `ssm:GetParameter*` scoped to `/logalot/<env>/*`** + S3 cold bucket access); `infra/aws/user-data.sh.tftpl` (install Docker+compose, create swap file, read SSM params → env, `docker compose -f docker-compose.aws.yml up -d`); `variables.tf`/`outputs.tf`.
- **Integration points:** pulls T14 images, runs T15 compose, reads T18 SSM params; EIP feeds Route53 (T18).
- **blockedBy:** T16, T15 (compose), T18 (SSM params exist) — see note: T17 references SSM paths but can plan before T18 applies; coordinate apply order T16→T18→T17.
- **Tests:** `terraform validate`/`plan`; user-data lints (`shellcheck`); instance type == `t4g.small`, arch arm64, root gp3 30GB. *(ADR-0011 sizing; swap present)*

**T18 — Terraform: data + managed services (S3+lifecycle, Glue DB, SSM SecureString, Route53, CloudWatch, Budgets)**
- **Owner:** devops-engineer
- **Files:** `infra/aws/s3.tf` (cold bucket + Athena-results bucket, **lifecycle expiry**, private+encrypted+versioned); `infra/aws/glue.tf` (cold DB); `infra/aws/ssm.tf` (SecureString params: `google_client_secret`, JWT secret, refresh pepper, DB/Redis/RabbitMQ creds — path `/logalot/<env>/*`); `infra/aws/dns.tf` (Route53 hosted zone + A/AAAA → EIP); `infra/aws/observability.tf` (CloudWatch: memory/OOM alarm → resize trigger; **AWS Budget $30 @ 80%/100% + forecast**).
- **Integration points:** S3 bucket name feeds T20 cold-smoke; SSM consumed by user-data (T17); Route53 + EIP + Caddy give Google the HTTPS redirect URI (T23).
- **blockedBy:** T06 (T16 for VPC refs where needed)
- **Tests:** `terraform validate`/`plan`; **IAM policy assertion: SSM read is scoped to `/logalot/<env>/oauth/google/*` (and the logalot path), not `ssm:*`/`Resource:*`** (R8); S3 lifecycle rule present + bucket private/encrypted; Budget at $30 with 80/100 thresholds. *(R8, ADR-0011 budget, ADR-0010 secrets)*

### Wave 2 — Integration, end-to-end, cold-smoke flip, review gates

**T19 — Cross-service OIDC end-to-end (testcontainers: control-plane + Redis + Postgres)**
- **Owner:** backend-engineer
- **Files:** `tests/oidc-e2e/` (new, mirrors `tests/e2e` slice style) with a **fake Google** (token endpoint + JWKS) so no live IdP is needed.
- **Integration points:** exercises the full authorize→callback→link→mint chain end to end.
- **blockedBy:** T10, T11, T12, T13
- **Tests:** e2e — happy path (first-link then subsequent), all Critical/High rejections end to end: R1 (each invalid id_token field), R2 (first-link email not provisioned in `state` tenant → 401), **R3-structural (multi-tenant): same Google `sub` provisioned + linked in tenant A and tenant B — login from A's page lands as A's user, login from B's page lands as B's user; a `sub` linked only in A, login via B with no B provisioning → 401, never resolves into A)**, R4 (state replay/unknown), R5 (nonce), R6 (PKCE missing verifier), R10 (fresh family), R13 (sub-pinned), R14 (normalization). *(R1–R6, R10, R13, R14 integrated; R3 structural)*

**T20 — Wire `cold_smoke_aws` CI job against the real provisioned S3 bucket**
- **Owner:** devops-engineer
- **Files:** `.github/workflows/cold-smoke-aws.yml` (new — gated/manual or post-apply; OIDC-to-AWS or scoped creds; sets `COLD_BUCKET`/`COLD_GLUE_DB`/`COLD_ATHENA_RESULT_BUCKET` from T18 outputs; runs `go test -tags=cold_smoke_aws ./tests/cold-tier-smoke/...`); `Makefile` (`cold-smoke-aws` target).
- **Integration points:** the existing `tests/cold-tier-smoke/smoke_test.go` (already written; skips without the env vars). Bucket/Glue from T18.
- **blockedBy:** T18
- **Tests:** the smoke canary sequence passes against real S3/Athena/Glue (EnsureGlueTable → WriteParquet → partition → bound/no-tenant/wrong-tenant/dialect). *(unblocks #63 AC#3)*

**T21 — Flip `COLD_ENABLED` / `COLD_SEARCH_ENABLED` (#63 AC#3)**
- **Owner:** backend-engineer + devops-engineer
- **Files:** `docker-compose.aws.yml` / SSM / deploy env (set both `true`); any doc note in `services/query-service` / `processor` config comments referencing the gate.
- **Integration points:** only valid **after** T20 is green (the documented gate, decision 016 §6).
- **blockedBy:** T20
- **Tests:** post-flip, query-service routes cold reads and processor tees to real S3; re-run T20 smoke green. *(closes #63 AC#3)*

**T22 — Security-architect review gates (SG/IAM/TLS/state hardening)**
- **Owner:** security-architect
- **Files:** review-only over T16/T17/T18 (+ checklist note in `docs/security/`).
- **Integration points:** asserts the threat-model controls landed in IaC.
- **blockedBy:** T16, T17, T18
- **Tests:** assertions — SG inbound = {443,80} only, no 22 (D3); IAM SSM read scoped to the param path, not `ssm:*` (R8); Terraform state bucket private+encrypted+versioned (ADR-0010); Caddy enforces HTTPS+HSTS, cookies `Secure` in non-dev (R16). *(R8, R16, state-hardening)*

**T23 — Live Google end-to-end demo on the provisioned domain (critical-path join)**
- **Owner:** lead-engineer (validation) + devops-engineer (env)
- **Files:** runbook note in `docs/` (Google console redirect URI = `https://<domain>/auth/google/callback`); no app code.
- **Integration points:** **the join** — needs T17 (EC2/EIP running the compose) + T18 (Route53 + Caddy/ACME TLS) + T10/T13 (the working flow).
- **blockedBy:** T10, T13, T17, T18
- **Tests:** manual/scripted e2e — a provisioned user signs in via real Google, lands authenticated with a `lg_at`/`lg_rt` session; an unprovisioned Google user is rejected (401, invite-only). *(end-to-end acceptance; transport https-only R16)*

---

## 4. Security requirement coverage (R1–R16 → task)

| Req | Requirement (short) | Satisfied by | Tier |
|---|---|---|---|
| **R1** | Complete `id_token` validation (per-field) | **T07** (unit/field) · T19 (e2e) | unit, e2e |
| **R2** | First-link tenant scoping (email match scoped to `state.tenant_id`) | **T10** · T04/T12 (storage) · T19 | integration, e2e |
| **R3** | Cross-tenant isolation — **now structural** (by-sub lookup is RLS-scoped to `state.tenant_id`; no global resolver, so resolving into another tenant is impossible by construction); multi-tenant membership supported (D6) | **T10** · T04/T12 (RLS-scoped lookup, per-tenant unique) · T19 (multi-tenant) | integration, e2e |
| **R4** | CSRF / `state` single-use ≥128-bit | **T08** (mint) · **T09** (consume) · T02 (atomic store) | unit, integration |
| **R5** | Nonce replay protection | **T07** (assert) · **T09** (bind) · T02 | unit, integration |
| **R6** | PKCE S256 enforced | **T08** (challenge) · **T09** (verifier at exchange) | unit, integration |
| **R7** | No open redirect (fixed `redirect_uri` + `returnTo` allowlist) | **T08** (server const) · **T13** (web allowlist) · T01 | unit |
| **R8** | `client_secret` confinement (no leak; IAM path-scoped) | **T18** (IAM scope) · T07/T11 (never logged/returned) · T22 | unit, plan-assert, review |
| **R9** | JWKS rotation / key-by-`kid` / RS256-only | **T07** | unit |
| **R10** | Fresh refresh family on OAuth login | **T10** | integration |
| **R11** | Callback abuse resistance (rate-limit; reject pre-Google) | **T11** · **T09** | integration |
| **R12** | No PII/secret in logs | **T11** | integration (log-capture) |
| **R13** | Identity pinned to `sub` | **T10** · T19 | integration, e2e |
| **R14** | Email normalization parity | **T03** · **T10** | unit, integration |
| **R15** | Auth audit events (link/login/reject) | **T10** | integration |
| **R16** | Transport security (https-only, cookie flags, HSTS) | **T13** (cookies) · **T15/T18** (Caddy/TLS) · T22 | unit, review |

Every R1–R16 maps to at least one task with a named test; the Critical set (R1–R4) is covered both at the unit/component layer **and** end-to-end (T19). Under D6, R3 is satisfied **structurally** (RLS-scoped by-sub lookup) rather than by an explicit cross-check, and the e2e adds a positive multi-tenant-membership assertion.

---

## 5. Summary for the project-manager

- **Tasks:** 23 (T01–T23). One issue per task (one PR each). Two epics: **Epic A — Google OAuth** (T01–T04, T07–T13, T19) and **Epic B — AWS IaC** (T05–T06, T14–T18, T20–T23), with T22 (security-architect) and T23 (live demo) as the join.
- **Waves:** Wave 0 foundations (T01–T06, parallel-safe) → Wave 1 cores (Track A serialized control-plane chain T08→T09→T10→T11 + parallel T07/T13; Track B packaging + infra T14–T18) → Wave 2 integration/cold-smoke/flip/review (T19–T23).
- **Owner distribution:** backend-engineer 10 (T01,T02,T03,T04,T07,T08,T09,T10,T11,T19; +T12,T21 shared) · devops-engineer 8 (T05,T06,T14,T15,T16,T17,T18,T20; +T21,T23 shared) · frontend-engineer 1 (T13) · security-architect 1 (T22) · lead-engineer (T23 validation).
- **Critical path:** `T01 → T07/T08 → T09 → T10 → T19` for the logic, joined with `T06 → T16 → T18 + T17` for the domain/TLS, converging at **T23** (live Google e2e needs real HTTPS). Track A's testcontainers e2e (T19) is independent of Track B and finishes first.
- **Cross-cutting decisions made:** (D1) state/nonce/**PKCE-verifier** in **control-plane Redis**, single-use, **web BFF is a thin relay** — exercising ADR-0008's own documented Redis reversibility trigger because PKCE's verifier must stay server-side at the exchange point; (D2) endpoint split = `POST /v1/auth/oidc/google/authorize` + `/callback`; (D3) admin access = **SSM Session Manager, no port 22** (SSH-to-CIDR is a togglable fallback); (D4) two new Node Dockerfiles + multi-arch arm64 CI; (**D6 — user design change**) **multi-tenant membership**: constraint → `UNIQUE(tenant_id, provider, provider_sub)`, **SECURITY DEFINER resolver dropped**, by-sub lookup is RLS-scoped to the always-known `state.tenant_id`, cross-tenant isolation is now **structural**; (D5) open questions: **Q1 now MOOT** (no resolver → no superuser dependency), Q2 superseded by D6, Q3 `23505`→in-tenant re-resolve, Q4 optional dev seed yes, Q5 email = link-time snapshot.
- **Watch-outs to track:** `.env.example` and `routes.ts`/`container.ts` are shared-file contention points — serialize per the file-contention notes; the **only** hard cross-track dependency is T23 (live demo needs Route53 + Caddy/ACME); `#63 AC#3` is closed by **T20 → T21** (cold-smoke green gates the COLD flag flip).
</content>
</invoke>
