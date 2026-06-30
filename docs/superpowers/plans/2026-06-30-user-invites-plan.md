# User Invites — Implementation Plan (Phase 3, PLAN-THE-BUILD)

**Date:** 2026-06-30 · **Status:** Plan (approved design → sequenced build) · **Owner:** lead-engineer
**Discipline:** `superpowers:writing-plans` + `subagent-driven-development` (each task is independent, test-first, PR-sized, revertible).

**Sequences (does not re-decide):**
[spec](../specs/2026-06-30-user-invites-design.md) ·
[ADR-0012 (JIT provisioning)](../../adr/0012-user-invites-jit-provisioning.md) ·
[ADR-0013 (email delivery)](../../adr/0013-invite-email-delivery.md) ·
[threat model (R-INV-1..20)](../../security/threat-model-user-invites.md) ·
[data model (000018)](../../data/invites-data-model.md)

> This is a PLAN. No source, migration, or test files are written in this phase. Each task below is the unit the
> `project-manager` transcribes into a tracked issue; each is sized to one reviewable PR.

---

## 1. Build order / critical path (read first)

### The shared seams everything binds to (must land before anything that consumes them)

Five artifacts are the contracts the rest of the feature compiles against. They are the Wave 0 spine; nothing
downstream type-checks until they exist, so they are sequenced first and kept deliberately small:

1. **Contracts zod schemas** (`packages/contracts/src/invite.ts` + the `oidcCallbackRequestSchema` extension in
   `oauth.ts`) — the create/list/response DTOs and the optional `inviteToken` on the callback. The control-plane
   routes, the BFF relays, and the admin UI all import these, so a shape change can never drift across the three.
2. **Migration `000018_invites`** — the table the repository and the atomic consume bind to. Pure DDL, no backfill.
3. **The `InviteRepository` port + `EmailSender` port + audit-outcome additions** (`app/ports.ts`) and the
   **`Invite` domain entity + `lginv` token model** (`domain/entities.ts`, new `domain/invite.ts`). The app
   services, the provisioner, and the authenticator branch all depend on these types.
4. **RBAC operations** `invite:create` / `invite:list` / `invite:revoke` (`domain/rbac.ts` authority +
   `packages/contracts/src/rbac.ts` UI mirror).
5. **`OAuthAuditOutcome` additions** `invite_provisioned` + `reject_no_valid_invite` (folded into the ports task to
   keep `ports.ts` single-owner).

### The one structural seam the repos do NOT share yet (flagged by ADR-0012)

Today every repository opens its **own** `withTenantTx` (see `tenant-tx.ts`): `PgUserRepository.create`,
`PgOAuthIdentityRepository.linkFirst`, and the new `InviteRepository.consume` each `await pool.connect()`
independently. The JIT provisioner needs **consume + create-user + create-membership + linkFirst in ONE
tenant-armed transaction** (R-INV-17 / TI-10) — the codebase has no unit-of-work that shares a `PoolClient` across
repositories. **This is the single new structural seam, and it is sequenced before the provisioner** (Task 7 →
Task 9). It is resolved by *extracting client-accepting internals* from the existing repos without changing their
public behavior (KISS, revertible), so the provisioner can drive all four writes on one `client` inside one
`withTenantTx`.

### What is parallel-safe (file-disjoint)

- **Web vs backend.** After the contracts (Task 1) land, the entire web track (BFF relays, admin Invites section,
  `/invite/accept` route — Tasks W1–W3) is file-disjoint from the control-plane track and runs in parallel.
- **Within Wave 0**, Tasks 1–4/6 touch disjoint files (`invite.ts`/`oauth.ts`, the migration, `domain/invite.ts`,
  `rbac.ts`×2, `env.ts`). Task 5 (`ports.ts`) waits only on Task 4's entity types.
- **EmailSender adapters (Task 12)** are file-disjoint from the provisioning core and can land any time after the
  port (Task 5).

### File-contention notes (serialize these; do NOT parallelize)

- **`app/ports.ts`** — the `InviteRepository` port, the `EmailSender` port, **and** the two new audit outcomes all
  live here. Folded into a **single task (Task 5)** so two agents never edit `ports.ts` at once.
- **`app/oidc-authenticator.ts`** — only **Task 10** edits it (adds the optional `inviteProvisioner` dep,
  `inviteTokenHash` on `OidcCallbackCommand`, and replaces the reject branch). Nothing else touches this hot file.
- **`adapters/http/routes.ts`** — only **Task 13** edits it (invite routes + callback token-hash threading).
- **`container.ts`** — only **Task 14** edits it (wires repo, provisioner, service, email-sender selection).
- **`domain/rbac.ts` + `contracts/rbac.ts`** — only **Task 3** edits them.
- **`apps/web/src/server/admin.ts` + `control-plane.ts`** — relay functions added by **Task W1**; the admin section
  (W2) consumes them but does not edit those server modules' relay block beyond wiring.
- **`apps/web/src/server/oidc.ts`** — only **Task W3** edits it (the invite-token handshake cookie).

### Critical path (longest dependency chain)

```
T4 (token model) → T5 (ports) → T8 (PgInviteRepository) → T9 (InviteProvisioner UoW)
   → T10 (authenticator branch) → T13 (HTTP routes) → T17 (cross-service e2e) → T18 (security gate)
```

with **T7 (tx-scoped seam)** joining at T9 and **T2 (migration)** joining at T8. Everything else (web track,
email adapters, service, container) hangs off this spine and is not on the critical path.

**21 tasks across 6 waves (Wave 0–5).**

---

## 2. Cross-cutting seam tasks (Wave 0) — the contracts everything binds to

### Task 1 — Add invite zod contracts + extend the OIDC callback schema
- **Owner:** frontend-engineer · **Model:** Sonnet 4.5 (mechanical schema authoring, no security judgment).
- **Files:** create `packages/contracts/src/invite.ts`; edit `packages/contracts/src/index.ts` (export `./invite.js`);
  edit `packages/contracts/src/oauth.ts` (add optional `inviteToken` to `oidcCallbackRequestSchema`).
- **Approach:** mirror `apiKey.ts`'s one-time-secret pattern. `createInviteRequestSchema` = `{ email (z.string().email().max(320)), role: z.enum(['member','admin']).default('member') }`.strict(). `inviteResponseSchema` (metadata only, **no token/hash**) = `{ id, tenantId, email, role, status: z.enum(['pending','consumed','revoked']), expiresAt, createdBy nullable, consumedAt nullable, createdAt, updatedAt }`. `inviteCreatedResponseSchema = inviteResponseSchema.extend({ inviteUrl: z.string().url() })` (the once-only link). `inviteListSchema = z.object({ invites: z.array(inviteResponseSchema) })`. In `oauth.ts`: `inviteToken: z.string().min(1).max(512).optional()` on the callback request (plaintext, body only — never a query param, R-INV-12).
- **Integration points:** consumed by Tasks 11 (routes), W1/W2 (BFF + UI), W3 (callback relay).
- **Acceptance criteria:** all four schemas exported from package root; `inviteResponseSchema` has no `token`/`tokenHash`/`secret` field; callback schema accepts a request with and without `inviteToken`; `pnpm --filter @logalot/contracts build` + `tsc --noEmit` green.
- **Tests (unit, contracts):** `invite.test.ts` — valid create parses; `role` defaults to `member`; an unknown role rejected; a body carrying `token`/extra key is rejected by `.strict()` (R-INV-8: the wire shape cannot smuggle a role override or a stored-secret field); `inviteCreatedResponseSchema` requires `inviteUrl`. `oauth.test.ts` — callback parses with and without `inviteToken`; `inviteToken` over 512 chars rejected.
- **Discharges:** R-INV-8 (no client-supplied role/secret beyond the constrained enum), R-INV-12 (token shape is body-only). **blockedBy:** none.

### Task 2 — Author migration 000018_invites (table + indexes + RLS)
- **Owner:** backend-engineer · **Model:** Opus 4.8 (security-load-bearing DDL: RLS, partial-unique, token-hash CHECK).
- **Files:** create `migrations/000018_invites.up.sql` and `000018_invites.down.sql` (scaffold via `make migrate-create name=invites`).
- **Approach:** transcribe the data-model §6 DDL **verbatim** — `token_hash bytea NOT NULL UNIQUE` + `octet_length=32` CHECK; `role text CHECK in ('member','admin')`; `status text CHECK in ('pending','consumed','revoked') default 'pending'`; `expires_at timestamptz NOT NULL` (no column default); `created_by uuid REFERENCES users ON DELETE SET NULL`; `trg_invites_updated` trigger; `uq_invites_pending_per_email` partial unique on `(tenant_id,email) WHERE status='pending'`; `idx_invites_tenant`; `ENABLE`+`FORCE ROW LEVEL SECURITY`; `invites_tenant_isolation` policy; **no explicit GRANT** (000011 default-privileges). Down = `DROP TABLE IF EXISTS invites`.
- **Integration points:** the table Task 8 (repo) and the atomic consume (Task 9) bind to.
- **Acceptance criteria:** `make migrate-up` then `make migrate-down` then `make migrate-up` cycle clean (reversibility); the partial unique rejects a 2nd `pending` row for the same `(tenant,email)` but allows one after the first is `revoked`/`consumed`; inserting a `token_hash` ≠ 32 bytes fails the CHECK; an unscoped (no `app.tenant_id`) `SELECT` returns zero rows (fail-closed).
- **Tests (integration, testcontainers Postgres):** apply migration; assert the partial-unique behavior, the length CHECK, RLS fail-closed, and that `logalot_app` (NOSUPERUSER NOBYPASSRLS) is subject to FORCE RLS.
- **Discharges:** R-INV-2 (hash-at-rest column), R-INV-4 (NOT NULL expiry), R-INV-5 (status enum), R-INV-7/15 (FORCE RLS), R-INV-10 (one-pending partial unique). **blockedBy:** none.

### Task 3 — Add invite RBAC operations (authority + UI mirror)
- **Owner:** backend-engineer · **Model:** Sonnet 4.5 (small, additive matrix edit).
- **Files:** edit `services/control-plane/src/domain/rbac.ts` (append `invite:create`/`invite:list`/`invite:revoke` to `OPERATIONS` and to the `tenant_admin` set; member/platform_operator get none); edit `packages/contracts/src/rbac.ts` (append the three to `UI_OPERATIONS` and the `tenant_admin` UI set — keep the two matrices in sync, per that file's LIFT NOTE).
- **Integration points:** consumed by Task 13 (`makeRequireOperation`) and Task 10/11 service-layer `assertCan`; the UI mirror feeds `useCan` in Task W2.
- **Acceptance criteria:** `can('tenant_admin','invite:create') === true`; `can('member','invite:create') === false`; `can('platform_operator','invite:*') === false`; the two matrices agree on the invite rows.
- **Tests (unit):** extend `rbac.test.ts` (both packages) — tenant_admin permitted on all three; member + platform_operator denied on all three.
- **Discharges:** R-INV-7 (authz gating), R-INV-8 (admin-only `admin`-role invite creation). **blockedBy:** none.

### Task 4 — Invite domain entity + `lginv` tenant-self-identifying token model
- **Owner:** security-architect · **Model:** Opus 4.8 (token/entropy/hash — the bearer-credential primitive).
- **Files:** create `services/control-plane/src/domain/invite.ts`; edit `services/control-plane/src/domain/entities.ts` (add `Invite`, `InviteRef`, `ConsumedInvite`, `InviteStatus`).
- **Approach:** mirror `domain/api-key.ts` byte-for-byte in shape. Constants `INVITE_PREFIX='lginv'`, `INVITE_SECRET_BYTES=32` (256-bit, same class as `STATE_BYTES`). `assembleInviteToken(publicId, secret) = 'lginv'+'_'+publicId+'_'+secret`. `parseInviteToken(raw)` = `splitN(raw,'_',3)` → `{ publicId, secret }`, `ValidationError` on malformed (mirrors `parseApiKey`). `hashInviteSecret(secret): Buffer` = `sha256(secret)` (reuse `domain/secret-hash.ts` — **no new primitive**, R-INV-2). The `Invite` public projection carries metadata only — **never** `token`/`tokenHash` (data-model §1). Add an `InviteToken` value object holding the one-time plaintext.
- **Integration points:** the token model is used by Task 11 (service mint) and the accept-route parse seam (W3); the entity types are imported by Task 5 (ports).
- **Acceptance criteria:** `parse(assemble(slug,secret))` round-trips; a 3-component split so a `_` inside the secret is preserved as remainder; malformed (wrong prefix / missing component) throws `ValidationError`; `hashInviteSecret` returns 32 bytes equal to `sha256`; secret generated from a 32-byte CSPRNG.
- **Tests (unit):** `invite.test.ts` (domain) — round-trip; malformed inputs (`lgk_...`, two components, empty secret) rejected; hash length 32; assert no function returns the plaintext from a stored projection.
- **Discharges:** R-INV-2 (256-bit CSPRNG, sha256-at-rest, no plaintext outward). **blockedBy:** none.

### Task 5 — Define `InviteRepository` + `EmailSender` ports + audit outcomes
- **Owner:** backend-engineer · **Model:** Opus 4.8 (port boundary + audit union are load-bearing).
- **Files:** edit `services/control-plane/src/app/ports.ts` only (single-owner — avoids contention).
- **Approach:** add `NewInvite`, `InviteRef`, `ConsumedInvite` input/output shapes and the `InviteRepository` interface exactly as ADR-0012 specifies (`create`, `findValidByTokenHash(tenantId, tokenHash: Buffer, now)`, `consume(tenantId,{tokenHash:Buffer,email,now})`, `listByTenant`, `revoke(tenantId,id,now)`). Add the `EmailSender` port (`send(message: EmailMessage): Promise<void>` with `{ to, subject, text, html }`) and `EmailMessage`. Extend `OAuthAuditOutcome` with `'invite_provisioned'` and `'reject_no_valid_invite'`. Add an `InviteAuditEvent` + `InviteAuditLogger` (separate from `OAuthAuditEvent`, per threat-model §5 — admin-side `invite_created`/`invite_revoked` carry actor + invite id, **never** the token).
- **Integration points:** implemented by Tasks 8 (repo), 12 (email), 9 (provisioner emits `invite_provisioned`), 10 (authenticator emits `reject_no_valid_invite`), 11 (service emits create/revoke).
- **Acceptance criteria:** `tsc --noEmit` green across the package; `consume`/`findValidByTokenHash` type `tokenHash` as `Buffer` (matches `sha256` + the bytea column); `InviteRepository` never exposes `token`/`tokenHash` on its **outputs**.
- **Tests:** type-level only (compile). No runtime test for a pure interface (KISS).
- **Discharges:** R-INV-9 (audit-event surface, hashed not raw), structural hook for R-INV-3/17. **blockedBy:** Task 4.

### Task 6 — Add invite + email config to the control-plane env
- **Owner:** devops-engineer · **Model:** Sonnet 4.5 (config plumbing).
- **Files:** edit `services/control-plane/src/config/env.ts` (and its zod/`Config` shape).
- **Approach:** add `INVITE_TTL_SECONDS` (default 7d), `INVITE_MAX_OUTSTANDING_PER_TENANT` (default 50, ADR-0012), `INVITE_ACCEPT_BASE_URL` (used to build `inviteUrl`), `EMAIL_PROVIDER` (`'none'|'smtp'|'ses'`, default `'none'`), and SMTP params (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`). Secrets are read here only to be **handed to the adapter** (Task 12); the HTTP/auth layers never see them (ADR-0013, R-INV-14).
- **Acceptance criteria:** absent `EMAIL_PROVIDER` parses to `'none'`; missing SMTP params with `EMAIL_PROVIDER=smtp` is a startup config error; defaults applied for TTL/cap/base-url.
- **Tests (unit):** env-parse table — defaults, `smtp` requires host, invalid provider rejected.
- **Discharges:** R-INV-14 (provider config is fixed, not request-derived). **blockedBy:** none.

---

## 3. Persistence & the structural unit-of-work seam (Wave 1)

### Task 7 — Extract client-accepting internals (the tx-scoped seam)
- **Owner:** backend-engineer · **Model:** Opus 4.8 (the one structural refactor; atomicity correctness).
- **Files:** edit `services/control-plane/src/adapters/postgres/user-repository.ts` and `oauth-identity-repository.ts`; optionally add `adapters/postgres/provision-tx.ts` (the shared helpers).
- **Approach (KISS, no behavior change):** extract the **bodies** of `PgUserRepository.create` (the user+membership INSERTs) and `PgOAuthIdentityRepository.linkFirst` (the SAVEPOINT/23505 logic) into exported functions that take an existing `PoolClient` — e.g. `insertUserWithMembership(client, tenantId, NewUser)` and `linkFirstWithClient(client, tenantId, NewOAuthIdentity)`. The existing public methods keep their `withTenantTx(this.pool, …)` wrapper and now **delegate** to these — so external behavior, the 23505→ConflictError mapping (R13), and every existing test stay byte-identical. This is the seam the provisioner needs: a caller can now run both writes on **one** armed client.
- **Integration points:** consumed only by Task 9 (the provisioner's single transaction).
- **Acceptance criteria:** **all existing user-repository + oauth-identity-repository tests pass unchanged** (proof of no-behavior-change); the extracted functions perform no `connect`/`BEGIN`/`COMMIT` of their own (they assume an armed client); the ConflictError-on-different-sub path (R13) still surfaces from `linkFirstWithClient`.
- **Tests (integration):** add cases that drive both helpers on a single hand-rolled `withTenantTx` client and assert user+membership+identity all land; assert a forced 23505-different-sub from `linkFirstWithClient` raises `ConflictError` (so the provisioner can roll back, R-INV-17).
- **Discharges:** structural prerequisite for R-INV-17 (atomic provisioning). **blockedBy:** none (touches only existing repos).

### Task 8 — Implement `PgInviteRepository`
- **Owner:** backend-engineer · **Model:** Opus 4.8 (the atomic consume is the at-most-once security authority).
- **Files:** create `services/control-plane/src/adapters/postgres/invite-repository.ts`.
- **Approach:** implement the port (Task 5) over migration 000018. `create`, `findValidByTokenHash` (read-only liveness probe — `SELECT … WHERE token_hash=$1 AND status='pending' AND expires_at>now()`), `listByTenant`, `revoke` (status flip, returns boolean like `PgApiKeyRepository.revoke`) each use `withTenantTx`. **`consume` is provided in two forms:** the public `consume(tenantId, …)` wraps `withTenantTx`, delegating to an exported **`consumeWithClient(client, …)`** that runs the single conditional UPDATE keyed on `token_hash` with `email`/`status='pending'`/`expires_at>now()` AND-conditions and `RETURNING id, role, email` (data-model §4). `tenant_id` is **not** in the WHERE — RLS scopes it. `consumeWithClient` is what the provisioner calls inside the shared transaction (Task 9).
- **Integration points:** Task 9 (provisioner uses `consumeWithClient`), Task 11 (service uses `create`/`list`/`revoke` + the outstanding-cap count).
- **Acceptance criteria:** `consume` on a pending/unexpired/email-matched invite returns the row and flips status to `consumed`; **0 rows → `null`** for every other case (no such token, wrong email, expired, revoked, already consumed); `revoke` flips to `revoked` and returns false on a 2nd call; list returns all statuses under RLS; outputs never carry `token_hash`.
- **Tests (integration, testcontainers Postgres):** consume happy path; email-mismatch → null + row still `pending` (**R-INV-1**); expired → null + still pending (**R-INV-4**); revoked → null (**R-INV-5**); 2nd consume of a consumed row → null (**R-INV-3** sequential); cross-tenant probe under a different armed tenant → null (**R-INV-15**); `findValidByTokenHash` never mutates status.
- **Discharges:** R-INV-1, R-INV-3, R-INV-4, R-INV-5, R-INV-6 (uniform null), R-INV-15. **blockedBy:** Task 2, Task 4, Task 5.

---

## 4. Provisioning core — the JIT engine (Wave 2)

### Task 9 — `InviteProvisioner` single tenant-armed unit-of-work
- **Owner:** backend-engineer · **Model:** Opus 4.8 (THE atomicity + at-most-once core; highest blast radius).
- **Files:** create `services/control-plane/src/app/invite-provisioner.ts` (the port the authenticator calls) and `services/control-plane/src/adapters/postgres/pg-invite-provisioner.ts` (the UoW adapter); define the `InviteProvisioner` port + `provisionFromInvite(tenantId, { email, inviteTokenHash, providerSub, now })` in `ports.ts`-adjacent app types (or extend Task 5 — keep in the app layer).
- **Approach:** the adapter opens **one** `withTenantTx(pool, tenantId, client => …)` and runs, in order: (1) `consumeWithClient(client, …)` — `null` ⇒ `ROLLBACK`, return `null` (the gate, R-INV-3); (2) `insertUserWithMembership(client, tenantId, { email, passwordHash: DISABLED_PLACEHOLDER, role: translate(invite.role) })` with the **`admin→tenant_admin`, `member→member`** translation at this seam (ADR-0012; role read from the consumed row, never client input, R-INV-8); (3) `linkFirstWithClient(client, tenantId, { userId, provider:'google', providerSub, email })`; a `ConflictError` (R13 different-sub) propagates and **rolls back the whole tx** (R-INV-17) → returns `null`. On success emit `invite_provisioned` (hashed sub/email, never token) and return `{ userId }`.
- **Integration points:** injected into `OidcAuthenticator` (Task 10); composed in Task 14.
- **Acceptance criteria:** all four writes commit together or not at all; a fault injected at step 2 or 3 leaves the invite `pending` and zero orphan rows; the membership role equals the translated invite role; `provisionFromInvite` returns `null` (not throw) on any consume miss so the authenticator throws the uniform 401.
- **Tests (integration, testcontainers Postgres):** happy path → user+membership(role)+identity created, invite `consumed`, one `invite_provisioned` audit (**R-INV-1 happy / R-INV-8 role-from-row**); injected membership-insert failure → invite still `pending`, zero new rows (**R-INV-17**); injected R13 different-sub conflict → `null`, invite not consumed (**R-INV-17 / R13 preserved**); two concurrent `provisionFromInvite` for the same invite → exactly one `{ userId }`, one `null`, one user, one membership (**R-INV-3 race**); `admin` invite → membership `tenant_admin` (**R-INV-8 translation**).
- **Discharges:** R-INV-3 (atomic single-use + race), R-INV-8 (role from row + new-principal-only), R-INV-17 (atomic provisioning). **blockedBy:** Task 5, Task 7, Task 8.

### Task 10 — Wire the invite branch into `OidcAuthenticator`
- **Owner:** backend-engineer · **Model:** Opus 4.8 (surgical edit to the hot auth path; must preserve the control).
- **Files:** edit `services/control-plane/src/app/oidc-authenticator.ts` (the deps interface, `OidcCallbackCommand`, the reject branch); no other file.
- **Approach:** add `inviteProvisioner?: InviteProvisioner` to `OidcAuthenticatorDeps` and `inviteTokenHash?: string` to `OidcCallbackCommand`. At lines 287–290 (the `if (!userRecord)` arm), implement the ADR-0012 snippet exactly: call `deps.inviteProvisioner?.provisionFromInvite(tenantId, { email: normalizedEmail, inviteTokenHash, providerSub: claims.sub, now: deps.clock.now() })`; on `null` (or no provisioner / no `inviteTokenHash`) audit **`reject_no_valid_invite`** and throw the **unchanged** `UnauthorizedError` (byte-identical 401 to today). On a returned `{ userId }`, continue exactly as the email-match path does (set `userId`, `isFirstLink=true`) — the provisioner has already linked the identity, so **skip** the in-branch `linkFirst` (the provisioner owns it). Emit `invite_provisioned` from inside the provisioner (Task 9), not here. The no-cookie/normal-login path leaves `inviteTokenHash` undefined ⇒ old behavior preserved.
- **Integration points:** `inviteTokenHash` is supplied by Task 13 (the callback route hashes the body `inviteToken`); the provisioner is composed in Task 14.
- **Acceptance criteria:** with no `inviteProvisioner` and no `inviteTokenHash`, the branch is byte-for-byte the old `reject_no_provisioned_user` 401 (control preserved — **the non-negotiable invariant**); a valid invite path mints a session and audits `invite_provisioned`; a consume-miss audits `reject_no_valid_invite` and 401s; an **existing** user (`findCredentialsByEmail` non-null) **never** reaches the provisioner (R-INV-8); the 401 body for `reject_no_valid_invite` is identical to `reject_no_provisioned_user` (R-INV-6).
- **Tests (unit, fake repos/provisioner):** no-invite → unchanged 401 + `reject_no_provisioned_user`; provisioner returns `null` → 401 + `reject_no_valid_invite`, identical body (**R-INV-6**); provisioner returns userId → session minted + `invite_provisioned` + `first_link`-equivalent continuation; existing-user path bypasses provisioner entirely (**R-INV-8**); audit never carries the raw token or sub (**R-INV-9**).
- **Discharges:** R-INV-6 (no enumeration oracle), R-INV-8 (new-principal-only), R-INV-9 (audit outcomes), invite-only control preservation. **blockedBy:** Task 5, Task 9.

---

## 5. Admin service & HTTP surface (Wave 3)

### Task 11 — `InviteService` (create / list / revoke) with cap + best-effort email
- **Owner:** backend-engineer · **Model:** Opus 4.8 (mint + cap + best-effort delivery + audit are security-relevant).
- **Files:** create `services/control-plane/src/app/invite-service.ts`.
- **Approach:** mirror `ApiKeyService`. `create(ctx, { email, role })`: `assertCan(ctx,'invite:create')`; resolve `tenant.publicId` from the registry (for the slug, like ApiKeyService); **count pending invites under RLS and reject past `INVITE_MAX_OUTSTANDING_PER_TENANT`** (R-INV-10); normalize the email (`normalizeEmail`); generate a 32-byte secret, `assembleInviteToken(publicId, secret)`, `hashInviteSecret`; `repo.create(ctx.tenantId, { email, role, tokenHash, expiresAt: now+INVITE_TTL, createdBy: ctx.principalId })`; build `inviteUrl = INVITE_ACCEPT_BASE_URL + '/invite/accept?token=' + plaintext`; **return `{ invite, inviteUrl }` with the plaintext shown once** BEFORE delivery; then **best-effort** `EmailSender.send(...)` wrapped in try/catch that **audits but never throws** (ADR-0013, mirrors `touchLastLogin`). `list(ctx)`: `assertCan('invite:list')` → `repo.listByTenant`. `revoke(ctx,id)`: `assertCan('invite:revoke')` → `repo.revoke` (404 on miss, like ApiKeyService). Emit `invite_created`/`invite_revoked` via `InviteAuditLogger`.
- **Integration points:** Task 13 routes call it; Task 14 composes it with repo + email sender.
- **Acceptance criteria:** create returns the plaintext `inviteUrl` exactly once and persists only the hash; a failing/`NoOp` `EmailSender` does NOT fail create (link still returned); create past the cap throws a validation/conflict error (no row written); revoke on another tenant's id → 404 (RLS, **R-INV-15**); `admin`-role create requires `invite:create` (asserted, **R-INV-8**).
- **Tests (unit, fake repo + spy EmailSender):** create returns link + stores only hash (**R-INV-2/12**); create with `EMAIL_PROVIDER=none`/throwing sender still succeeds + audits send outcome (**R-INV-14**); create at cap+1 rejected, no row (**R-INV-10**); list/revoke gated by `assertCan` (**R-INV-7**); email recipient is the bound invite email only (**R-INV-14**); audit records carry invite id + actor, never the token (**R-INV-9**).
- **Discharges:** R-INV-2, R-INV-7, R-INV-9, R-INV-10, R-INV-12, R-INV-14. **blockedBy:** Task 4, Task 5, Task 6, Task 8.

### Task 12 — `EmailSender` adapters: NoOp + SMTP (nodemailer) + injection-safe template
- **Owner:** backend-engineer · **Model:** Sonnet 4.5 (thin adapter; the template-injection guard is the one careful bit).
- **Files:** create `services/control-plane/src/adapters/email/noop-email-sender.ts`, `smtp-email-sender.ts`, and an `invite-email-template.ts`. (`ses` is a reserved slot — **not built**, YAGNI.)
- **Approach:** `NoOpEmailSender.send` logs metadata only (recipient + invite id, **never** the link/token) and resolves. `SmtpEmailSender` wraps a nodemailer transport built from Task 6 config; composes via nodemailer's structured `{ to, subject, text, html }` params (**no string-concatenated headers**); the template auto-escapes interpolated fields and **rejects CR/LF + C0 control chars** in the recipient and any interpolated value (R-INV-13); the only URL is the server-built `inviteUrl`. The send path never logs the body/link (R-INV-12).
- **Integration points:** selected by `EMAIL_PROVIDER` in Task 14; called by Task 11.
- **Acceptance criteria:** `NoOp` is the default and logs no token; SMTP send targets only the passed recipient; a recipient/field containing `\r\nBcc:` or `<script>` is rejected/escaped and produces no extra header or executable markup.
- **Tests (unit, fake transport):** NoOp logs metadata only, no link (**R-INV-12**); CRLF in recipient rejected; `<script>` in an interpolated field escaped; header set comes only from structured params (**R-INV-13**); SMTP failure surfaces as a rejected promise (so Task 11 can catch it).
- **Discharges:** R-INV-12 (no token in logs), R-INV-13 (no header/template injection), R-INV-14 (fixed config target). **blockedBy:** Task 5, Task 6.

### Task 13 — Control-plane HTTP routes: invites CRUD + callback token-hash threading
- **Owner:** backend-engineer · **Model:** Opus 4.8 (RBAC wiring + the token-hash seam + rate limiting).
- **Files:** edit `services/control-plane/src/adapters/http/routes.ts` only.
- **Approach:** add `POST /v1/invites` (`makeRequireOperation('invite:create')`, parse `createInviteRequestSchema`, return 201 `{ ...invite, inviteUrl }`, **rate-limited** like the OIDC routes — R-INV-10), `GET /v1/invites` (`invite:list`, `{ invites }`), `POST /v1/invites/:id/revoke` (`invite:revoke`, `uuidParamSchema`, 204). In the existing `/v1/auth/oidc/google/callback` handler: parse the now-optional `inviteToken`, compute `inviteTokenHash = sha256(inviteToken)` **at the route layer** (the app core never sees plaintext — ADR-0012), and pass it into `handleCallback`. Ensure `body.inviteToken` is **never logged** (extend the never-log discipline already applied to `code`/`state`, R-INV-12).
- **Integration points:** invokes Task 11 (service) and Task 10 (authenticator field); consumes Task 1 contracts + Task 3 operations.
- **Acceptance criteria:** member token → 403 on all three invite ops (**R-INV-7**); create returns the one-time `inviteUrl`; revoke 204 / cross-tenant id → 404 (**R-INV-15**); the callback hashes `inviteToken` and never logs it; the callback still works with no `inviteToken` (normal login).
- **Tests (integration, fastify inject):** RBAC 403 for member/unauth on each op (**R-INV-7**); create happy path returns `inviteUrl`; rate-limit 429 after threshold on create (**R-INV-10**); callback with `inviteToken` reaches `handleCallback` with a 32-byte hash; log-capture over create+callback shows no plaintext token / `token_hash` (**R-INV-12**).
- **Discharges:** R-INV-7, R-INV-10, R-INV-12, R-INV-15. **blockedBy:** Task 1, Task 3, Task 10, Task 11.

### Task 14 — Compose invites in the container (repo + provisioner + service + email selection)
- **Owner:** backend-engineer · **Model:** Sonnet 4.5 (wiring; the selection logic is small).
- **Files:** edit `services/control-plane/src/container.ts` (and the `Services` interface).
- **Approach:** construct `PgInviteRepository`, `PgInviteProvisioner`, `InviteService`; select the `EmailSender` by `config.emailProvider` (`'none'→NoOp`, `'smtp'→Smtp`, `'ses'→` not built → fall back to NoOp + warn); inject `inviteProvisioner` into the existing `OidcAuthenticator` construction; add `invites` to `Services`. Provider secrets reach only the SMTP adapter (R-INV-14).
- **Acceptance criteria:** `EMAIL_PROVIDER=none` (default) wires NoOp; `smtp` wires the nodemailer adapter; the authenticator now receives a real `inviteProvisioner`; container builds with and without Google config (existing guard).
- **Tests (unit):** container builds under each `EMAIL_PROVIDER`; the OIDC authenticator receives a non-undefined provisioner; no provider secret is reachable from the route deps.
- **Discharges:** R-INV-14 (secret confinement). **blockedBy:** Task 9, Task 11, Task 12.

---

## 6. Web track (Wave 4) — parallel-safe with Waves 1–3 after Task 1

### Task W1 — BFF invite relays (admin-path, tenant-from-session)
- **Owner:** frontend-engineer · **Model:** Sonnet 4.5 (mirrors existing relays).
- **Files:** edit `apps/web/src/server/admin.ts` (add `listInvitesUpstream`/`createInviteUpstream`/`revokeInviteUpstream` + the `createServerFn` wrappers `cpCreateInvite`/`cpListInvites`/`cpRevokeInvite`); no path-tenant.
- **Approach:** copy the user/api-key relay shape exactly — `cpAuthedFetch`/`cpAuthedSend` against `/v1/invites`, `/v1/invites`, `/v1/invites/:id/revoke`, **tenant carried by the session Bearer token, never in the path/body** (the PR #139 convention: provider/admin paths + tenant-in-token, NOT tenant-in-path). Validate responses with the Task 1 contracts. Add invites to `loadAdminData` gated on `can(role,'invite:list')`.
- **Acceptance criteria:** relays attach the Bearer and pass no tenant id; a 403 surfaces as a clean `forbidden` outcome; the create relay returns the one-time `inviteUrl` to the server fn and never logs it.
- **Tests (unit, stubbed fetch):** each relay hits the right method/path with the Bearer; 401→`unauthorized`, 403→`forbidden`; create outcome carries `inviteUrl`.
- **Discharges:** R-INV-7 (tenant-from-session), R-INV-12 (no token logging in the BFF). **blockedBy:** Task 1.

### Task W2 — Admin Invites section (create / list / revoke / copy-link)
- **Owner:** frontend-engineer · **Model:** Sonnet 4.5 (mirrors `users-section.tsx`).
- **Files:** create `apps/web/src/features/admin/invites-section.tsx`; edit `features/admin/index.ts`, `admin-dashboard.tsx`, and `routes/_authed/admin.tsx` (wire executors).
- **Approach:** mirror `UsersSection`. Create dialog `{ email, role∈{member,admin} }`; list shows status + expiry + a **copy-link** affordance that surfaces the one-time `inviteUrl` from the create response (shown once, like the api-key plaintext modal); revoke button. Gate the section + actions on `useCan('invite:create'|'invite:list'|'invite:revoke')` (display-only mirror; server is the authority).
- **Acceptance criteria:** create surfaces the copyable `inviteUrl` once and does not re-display it after dismissal; revoke refreshes the list; a member never sees the section (server never ships the data, W1 gate).
- **Tests (component, vitest + RTL):** create dialog submits a valid `{email,role}`; the link is shown once then cleared; revoke calls the executor; the section is hidden when `can` is false.
- **Discharges:** R-INV-7 (UI gate, defense-in-depth), R-INV-12 (link shown once, not persisted client-side). **blockedBy:** Task 1, Task W1, Task 3.

### Task W3 — `/invite/accept` route + invite-token handshake cookie
- **Owner:** security-architect · **Model:** Opus 4.8 (untrusted token in a URL — the highest-leakage surface, TB-I2).
- **Files:** create `apps/web/src/routes/invite/accept.tsx` (public route); edit `apps/web/src/server/oidc.ts` (add the `lg_invite_token` httpOnly handshake cookie + thread it into the callback) and `control-plane.ts` (`cpOidcCallback` sends `inviteToken` in the body).
- **Approach:** the accept route reads `?token=`, **immediately moves it into a short-lived httpOnly `lg_invite_token` cookie** (same attributes as the OIDC handshake cookies — Secure, SameSite=Lax, ~10 min) and **strips it from the visible URL** (server redirect / history replace to a clean path); sets `Referrer-Policy: no-referrer`; parses the **non-secret slug** from the token to derive the `tenantSlug`, then calls `startGoogleSignin({ tenantSlug })` (the invitee never types a workspace, R-INV-20 — tenant from the invite). On the Google callback, `completeGoogleSignin` reads `lg_invite_token` and passes it as `inviteToken` in the callback body (**body, not query** — R-INV-12); the token is **never** placed in the onward redirect to Google (R-INV-11). Clear the cookie on every exit path.
- **Integration points:** the body `inviteToken` is hashed by Task 13's callback route → fed to Task 10.
- **Acceptance criteria:** post-accept URL/history carries no token; the accept response sets `Referrer-Policy: no-referrer`; the Google authorize redirect contains no invite token; the token travels to the CP in the request body; an invitee-supplied `tenant`/`returnTo` is ignored / passes the existing `sanitizeReturnTo` allowlist.
- **Tests (component + server-fn unit):** token stripped from URL + moved to httpOnly cookie (**R-INV-11**); `Referrer-Policy: no-referrer` asserted (**R-INV-11**); callback relay sends `inviteToken` in body, not query (**R-INV-12**); tenant derived from the slug, not an invitee param (**R-INV-20**); `returnTo=//evil.com` falls back to default (**R-INV-20**).
- **Discharges:** R-INV-11 (no URL leakage), R-INV-12 (body not query), R-INV-20 (tenant/returnTo from invite). **blockedBy:** Task 1.

---

## 7. Hardening, delivery & verification (Wave 5)

### Task 15 — Access-log hygiene for the accept path
- **Owner:** devops-engineer · **Model:** Sonnet 4.5 (proxy + BFF log config).
- **Files:** edit the Caddy/reverse-proxy config + BFF request-logging config (exclude query strings / the token param for `/invite/accept`); add the plaintext secret + `token_hash` to the never-log denylist.
- **Acceptance criteria:** a request to `/invite/accept?token=…` produces no access-log line containing the token; the create response body is not logged.
- **Tests (integration/log-capture):** capture proxy + BFF logs over an accept and a create; assert no plaintext token / `token_hash` present.
- **Discharges:** R-INV-12. **blockedBy:** Task 13, Task W3.

### Task 16 — MailHog dev compose + EMAIL_PROVIDER wiring
- **Owner:** devops-engineer · **Model:** Sonnet 4.5 (compose addition).
- **Files:** edit the dev `compose` file (add MailHog SMTP `:1025` / UI `:8025`); set `EMAIL_PROVIDER=smtp` pointed at it for the dev loop; document the env.
- **Acceptance criteria:** `make dev` (or equivalent) brings up MailHog; an invite create with `EMAIL_PROVIDER=smtp` shows the rendered invite in the MailHog UI; no real send.
- **Tests:** smoke — create an invite in dev, assert the message lands in MailHog. (No CI gate; dev-loop parity.)
- **Discharges:** ADR-0013 local-parity (no R-INV directly). **blockedBy:** Task 12.

### Task 17 — Cross-service invite e2e (testcontainers Postgres + fake Google)
- **Owner:** backend-engineer · **Model:** Opus 4.8 (the end-to-end security proof; mirrors commit 4097b6a).
- **Files:** create an e2e under the control-plane (or the existing cross-service e2e harness) using the fake-Google + testcontainers Postgres pattern already in the repo.
- **Approach:** drive create → accept → callback through the real HTTP surface + DB. Cover the full matrix from spec §137 and the threat model: happy path (user+membership(role)+identity+consumed); email mismatch → 401, not consumed; expired → 401; revoked → 401; **concurrent double-accept → provisioned exactly once**; no invite at all → unchanged `reject_no_provisioned_user` 401 (control preserved); cross-tenant list/revoke → absent/404; `EMAIL_PROVIDER=none` → create succeeds, link returned, no send.
- **Acceptance criteria:** every row of the matrix green; the no-invite control is byte-identical to pre-feature behavior; concurrency yields exactly one principal.
- **Tests (e2e):** the matrix above maps to **R-INV-1, R-INV-3, R-INV-4, R-INV-5, R-INV-6, R-INV-8, R-INV-14, R-INV-15** end-to-end.
- **Discharges:** end-to-end confirmation of the Critical + High set. **blockedBy:** Task 13, Task 14, Task W3.

### Task 18 — Security review gate (R-INV Critical/High sign-off)
- **Owner:** security-architect · **Model:** Opus 4.8 (independent control verification; mirrors commit 8995100).
- **Files:** none (review artifact / checklist; no `.md` report written by the implementer — findings returned in the PR).
- **Approach:** verify each **Critical** (R-INV-1,2,3,7,8,15) has a passing failing-test-first case, and each **High** (R-INV-4,5,6,10,11,12,13,17) is discharged by a named test from Tasks 8–17; confirm the single non-negotiable invariant (no user/membership/identity created except by atomically consuming a pending, unexpired, email-matched invite in the owning tenant) holds across the wired system; confirm no enumeration oracle and no token in any log.
- **Acceptance criteria:** every Critical/High R-INV maps to a green test; the invite-only control is provably preserved; gate blocks merge if any Critical is unproven.
- **Discharges:** the full R-INV verification. **blockedBy:** Task 17 (and transitively all).

---

## 8. Test design per major component (test-design discipline — failing-test-first)

Every Critical/High R-INV has at least one failing-test-first case. Tiers per `principles-tdd`:
unit (pure logic, fakes) · integration (real Postgres via testcontainers / fastify inject) · e2e (cross-service).

**Token model (`domain/invite.ts`, Task 4) — unit.** Round-trip assemble/parse; malformed rejected; 256-bit
secret; `hashInviteSecret` = 32-byte sha256; no plaintext on stored projections. → **R-INV-2**.

**Migration 000018 (Task 2) — integration.** Partial-unique (one pending per `(tenant,email)`); 32-byte
token_hash CHECK; RLS fail-closed; FORCE RLS binds `logalot_app`. → **R-INV-2, R-INV-4, R-INV-5, R-INV-7,
R-INV-10, R-INV-15**.

**`PgInviteRepository.consume` (Task 8) — integration.** The authority statement: email-mismatch/expired/
revoked/already-consumed/unknown all → `null` with the row untouched on failure; happy path flips to consumed;
cross-tenant probe → null. → **R-INV-1, R-INV-3, R-INV-4, R-INV-5, R-INV-6, R-INV-15**.

**`InviteProvisioner` (Task 9) — integration.** Atomic all-or-nothing; fault-injection rollback; concurrent
double-provision → exactly once; role translation; R13 conflict rolls back. → **R-INV-3, R-INV-8, R-INV-17**.

**`OidcAuthenticator` branch (Task 10) — unit.** No-invite → unchanged 401; consume-miss → `reject_no_valid_invite`
with identical body; existing-user bypasses provisioner; audit hygiene. → **R-INV-6, R-INV-8, R-INV-9**, control
preservation.

**`InviteService` (Task 11) — unit.** Link returned once + only hash stored; best-effort email never fails create;
cap enforced; gating; recipient-bound send; audit carries no token. → **R-INV-2, R-INV-7, R-INV-9, R-INV-10,
R-INV-12, R-INV-14**.

**EmailSender (Task 12) — unit.** NoOp logs no token; CRLF/`<script>` rejected/escaped; structured headers only.
→ **R-INV-12, R-INV-13, R-INV-14**.

**HTTP routes (Task 13) — integration (inject).** RBAC 403; rate-limit 429; callback hashes + never logs token.
→ **R-INV-7, R-INV-10, R-INV-12, R-INV-15**.

**Accept route + handshake (Task W3) — component + server-fn unit.** Token stripped from URL → httpOnly cookie;
`Referrer-Policy: no-referrer`; body-not-query; tenant from slug; returnTo allowlist. → **R-INV-11, R-INV-12,
R-INV-20**.

**Cross-service e2e (Task 17).** The full happy/mismatch/expired/revoked/race/no-invite/cross-tenant/no-email
matrix. → **R-INV-1, R-INV-3, R-INV-4, R-INV-5, R-INV-6, R-INV-8, R-INV-14, R-INV-15**.

---

## 9. Dependency edges (for the project-manager to transcribe into waves)

```
Wave 0:  T1  (none)
         T2  (none)
         T3  (none)
         T4  (none)
         T5  blockedBy T4
         T6  (none)
Wave 1:  T7  (none — refactors existing repos)
         T8  blockedBy T2, T4, T5
Wave 2:  T9  blockedBy T5, T7, T8
         T10 blockedBy T5, T9
Wave 3:  T11 blockedBy T4, T5, T6, T8
         T12 blockedBy T5, T6
         T13 blockedBy T1, T3, T10, T11
         T14 blockedBy T9, T11, T12
Wave 4:  W1  blockedBy T1
         W2  blockedBy T1, T3, W1
         W3  blockedBy T1
Wave 5:  T15 blockedBy T13, W3
         T16 blockedBy T12
         T17 blockedBy T13, T14, W3
         T18 blockedBy T17  (and transitively all)
```

**Critical path:** `T4 → T5 → T8 → T9 → T10 → T13 → T17 → T18` (with T7 → T9 and T2 → T8 joining).

---

## 10. Deferred / YAGNI (explicitly out of this plan)

- **Bulk / CSV invites** — single-invite create only; no batch endpoint or multi-row dialog.
- **Resend / expiry-extension UI** — re-invite is the ADR's "revoke then create" two-step; no resend button, no TTL bump.
- **SES-native adapter** — the `ses` slot behind `EmailSender` is reserved but **not built**; SMTP (incl. SES-SMTP) covers production. Build SES only when bounce/complaint handling is a real requirement (ADR-0013 trigger).
- **Non-Google providers / SCIM / directory sync** — the provisioner feeds only the Google first-link path.
- **Delivery guarantees (retries, dead-letter, RabbitMQ dispatch)** — email is in-request best-effort; the link is the contract.
- **Invite janitor / pruning of dead rows** — a data-phase concern; not load-bearing (data-model §2).
- **Per-admin / rate-limited invite budgets** — the static per-tenant soft cap is the only abuse control now (ADR-0012 trigger to revisit).
