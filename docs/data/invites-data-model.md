# Logalot — `invites` data model + migration plan (Phase 2, PLAN-ONLY)

**Status:** Plan (Phase 2 — data modeling) · **Date:** 2026-06-30 · **Owner:** data architect
**Feature:** user-invites (Google-native JIT provisioning, invite-only preserved)
**Contract satisfied:**
[spec](../superpowers/specs/2026-06-30-user-invites-design.md) ·
[ADR-0012](../adr/0012-user-invites-jit-provisioning.md) ·
[ADR-0013](../adr/0013-invite-email-delivery.md) ·
[threat model §5](../security/threat-model-user-invites.md)

> **This document is a plan.** The DDL is shown inline so it can be reviewed as a unit. **No files are
> created under `migrations/` and no source/test code is written in this phase.** The actual
> `000018_invites.{up,down}.sql` pair is authored in the BUILD phase from the DDL below, verbatim.

Bounded context: **Identity & Access** (same context as `users`, `memberships`, `api_keys`,
`refresh_tokens`, `oauth_identities`). `invites` is a new **aggregate root** whose lifecycle
(`create → deliver → accept → consume → manage`) is owned entirely inside this context; it reuses
`memberships` (000004) for the granted role and writes through to `users`/`oauth_identities` at
consume time via the single-transaction unit-of-work (§5). It does **not** introduce a parallel role
store.

---

## 0. Decisions resolved against the existing schema (read this first)

These are the places where matching the **live codebase conventions** refined what the prose
contract literally wrote. Each is a deliberate, defensible alignment, not a re-litigation of an ADR.

| # | Topic | Contract prose said | Repo convention (authority) | Resolution |
|---|---|---|---|---|
| D1 | `token_hash` column type | spec §Data + threat-model §5 wrote `token_hash **text**` | `api_keys.key_hash` and `refresh_tokens.token_hash` are **`bytea NOT NULL`** + `CHECK (octet_length(...) = 32)`; `domain/secret-hash.ts::sha256()` returns a 32-byte `Buffer`; ADR-0012 says "raw 32 bytes"; the `InviteRepository` port signature already types it `tokenHash: Buffer` | **`bytea NOT NULL`, 32-byte length CHECK, `UNIQUE`.** The task itself instructed "verify how api_keys stores its hash and mirror it" — `bytea` is that mirror. A `text` hex/base64 column would diverge from every other secret digest in the system and from the port type. |
| D2 | `email` column + the one-pending index | task asked for partial unique on `(tenant_id, **lower(email)**)` | `users.email`/`oauth_identities.email` are **plain `text`**, stored **app-normalized** (lowercase + trim + NFC — see `oauth_identities` header comment, threat-model R14), with plain equality uniqueness (`users UNIQUE(tenant_id, email)`) | **Store `email text` pre-normalized; partial unique on plain `(tenant_id, email) WHERE status='pending'`.** A SQL `lower()` only folds case — it would **miss** the trim/NFC the app already applies, and would not match the consume's plain `email = $2` predicate. Plain normalized email keeps the index, the consume, and the rest of the schema byte-consistent. `citext` is not installed (only `pgcrypto`), so it is not an option anyway. |
| D3 | `role` / `status` column types | spec/ADR/threat-model all wrote `text CHECK in (...)` | House style (000002 header, `oauth_provider`) prefers **enums** for "small, closed, load-bearing value sets" | **`text` + `CHECK`**, per the explicitly pinned contract. Rationale that makes this the right call here (not just contract-obedience): the invite role vocabulary is **`member \| admin`** — the Invites bounded-context ubiquitous language — which is *deliberately different* from the `membership_role` enum (`tenant_admin \| member`) and is translated at the provisioner seam (ADR-0012). Reusing `membership_role` would leak the membership vocabulary into the invite aggregate; minting a second near-identical enum buys nothing over a `CHECK`. Keeping both as `text CHECK` also makes the down-migration a single `DROP TABLE` with no `DROP TYPE` ordering. |
| D4 | consume keyed on `id` vs `token_hash` | threat-model §5 sketch wrote `WHERE id=$1 …` | ADR-0012 §"Single-use via one atomic conditional UPDATE" **refines** this to key on `token_hash` | **Key the consume on `token_hash`** (ADR-0012 is the authority; this is the ADR's own refinement, not a new deviation). Removes the TOCTOU window and binds provisioning to the exact link clicked. |
| D5 | App-role grants | task asked to confirm the grant pattern | 000011 sets `ALTER DEFAULT PRIVILEGES … GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO logalot_app`; later tables (incl. `oauth_identities` 000017) add **no explicit grant** and rely on it | **No explicit `GRANT` in the migration** — the default-privileges rule auto-grants the new table to `logalot_app`, exactly as 000012–000017 do. (Stated explicitly in §3 so the BUILD phase does not add a redundant grant.) |

**Membership-role mapping found (the headline answer):** the role lives in **`memberships.role`**, typed
`membership_role` enum = **`('tenant_admin', 'member')`** (migration 000002, table 000004 — `PRIMARY KEY
(tenant_id, user_id)`, not a column on `users`). The invite's `role` vocabulary `('member','admin')`
maps to it as:

```
invite.role 'member' → memberships.role 'member'
invite.role 'admin'  → memberships.role 'tenant_admin'
```

The translation happens **in the provisioner at the consume seam** (ADR-0012), never in SQL and never
by storing `tenant_admin` on the invite row. The invite row keeps the Invites-context word `admin`.

---

## 1. `invites` table DDL

```sql
-- 000018 — Invite aggregate (Identity & Access context).
--
-- A tenant admin creates an invite scoped to {email, role}; a one-time link (the
-- plaintext token, shown ONCE) authorizes JIT provisioning of a NEW Google user at
-- the formerly-rejecting `reject_no_provisioned_user` branch (ADR-0012). The invite
-- is a bearer AUTHORIZATION GRANT, so every property that made invite-only safe is a
-- column constraint here: hashed-at-rest token, mandatory expiry, status enum,
-- role CHECK, FORCE RLS, and a single atomic conditional UPDATE as the consume.
--
-- Token wire format (ADR-0012, mirrors api_keys lgk_<public_id>_<secret>):
--   lginv_<tenantPublicId>_<secret>
-- The slug is NOT secret — it lets the accept route arm RLS (SET LOCAL app.tenant_id)
-- BEFORE any scoped lookup, with no cross-tenant resolver (ADR-0008's structural
-- rule). Only token_hash = sha256(secret) (32 raw bytes) is stored — never plaintext.
--
-- role is the Invites-context vocabulary ('member'|'admin'); the provisioner
-- translates 'admin' -> membership_role 'tenant_admin' at the consume seam. It is NOT
-- the membership_role enum, deliberately (bounded-context ubiquitous language).

CREATE TABLE invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- App-normalized (lowercase + trim + NFC), the SAME normalization users/
  -- oauth_identities apply (threat-model R14). The email the consume binds against.
  email       text        NOT NULL,
  -- Invites-context role vocabulary. Mapped to membership_role at consume:
  -- 'member'->'member', 'admin'->'tenant_admin'. (R-INV-8)
  role        text        NOT NULL CHECK (role IN ('member', 'admin')),
  -- sha256(secret) as 32 raw bytes — same digest as api_keys.key_hash /
  -- refresh_tokens.token_hash (domain/secret-hash.ts). NEVER the plaintext. (R-INV-2)
  -- UNIQUE is GLOBAL (cross-tenant) and intentionally so: a 256-bit token is
  -- collision-free and global uniqueness leaks nothing under RLS (ADR-0012).
  token_hash  bytea       NOT NULL UNIQUE,
  status      text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'consumed', 'revoked')),
  -- Mandatory expiry — there is no "never expires" invite (default 7d set by the
  -- app at INSERT, not as a column default, so the window is explicit). (R-INV-4)
  expires_at  timestamptz NOT NULL,
  -- The admin who created the invite. SET NULL on user delete to preserve the row
  -- for the audit trail (mirrors api_keys.created_by).
  created_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  -- Set by the atomic consume; NULL until consumed. (audit / list view)
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invites_token_hash_len CHECK (octet_length(token_hash) = 32)
);

-- Mutable row (status flips, consumed_at) -> attach the shared updated_at trigger,
-- exactly like users/memberships/oauth_identities (refresh_tokens omits it because it
-- is append-then-mark; invites genuinely UPDATEs, so it keeps the trigger).
CREATE TRIGGER trg_invites_updated
  BEFORE UPDATE ON invites
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
```

Notes:
- `expires_at` carries **no column default**; `InviteService.create` computes `now() + INVITE_TTL`
  (default 7d, configurable) so the TTL is an explicit, testable app decision rather than buried in
  DDL. The column is `NOT NULL`, so a missing value fails closed (R-INV-4 / TI-13).
- The public `Invite` projection returned by the repo **never** carries `token_hash` outward (ADR-0012);
  the plaintext token lives only in the one-time create response (`InviteToken` VO).

---

## 2. Indexes & constraints

```sql
-- (a) One LIVE invite per (tenant, email): the partial unique that makes
--     "the valid invite for this email" at-most-one and unambiguous (ADR-0012;
--     R-INV-10). Consumed/revoked rows are excluded, so re-inviting after
--     revoke/consume is allowed. Plain (normalized) email — see decision D2.
CREATE UNIQUE INDEX uq_invites_pending_per_email
  ON invites (tenant_id, email)
  WHERE status = 'pending';

-- (b) Admin list-by-tenant over ALL statuses (pending/consumed/revoked).
--     Mirrors api_keys' idx_api_keys_tenant. The partial unique (a) is
--     pending-only, so the full list needs its own tenant-leading index.
CREATE INDEX idx_invites_tenant ON invites (tenant_id);
```

Index coverage matrix:

| Access pattern | Served by |
|---|---|
| Consume / accept-probe by `token_hash` (the hot security path) | `token_hash UNIQUE` (implicit B-tree) — O(1) equality |
| One-pending-per-`(tenant,email)` enforcement | `uq_invites_pending_per_email` (partial unique) |
| Per-tenant **outstanding-invite cap** count (`COUNT(*) WHERE tenant_id=? AND status='pending'`) | `uq_invites_pending_per_email` — tenant-leading + `status='pending'` partial, so the count is an index-only range scan |
| `listByTenant` (admin Invites section, all statuses) | `idx_invites_tenant` |
| `revoke(id)` lookup | `id` PK |

No bare per-`(tenant_id)`-only second index beyond `idx_invites_tenant`, and no index on
`created_by`/`expires_at` — none of those back a real access pattern (a janitor that prunes dead rows
by `expires_at` is a deferred data-phase concern, not load-bearing; if built it can add its own index
then, YAGNI).

The **per-tenant outstanding cap is enforced in the application** (`InviteService.create` counts
`pending` rows under RLS and rejects past `INVITE_MAX_OUTSTANDING_PER_TENANT`, default ~50 — ADR-0012),
**not** as a DB constraint. The index above makes that count cheap.

---

## 3. Row-Level Security + grants

Identical shape to every other tenant-owned table (`users`, `api_keys`, `refresh_tokens`,
`oauth_identities`). `invites` is tenant-owned, so **FORCE** RLS.

```sql
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE  ROW LEVEL SECURITY;

CREATE POLICY invites_tenant_isolation ON invites
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
```

- `app.current_tenant_id()` (000001) reads the per-transaction GUC `app.tenant_id`; unset/blank ⇒ NULL
  ⇒ predicate is NULL ⇒ FALSE ⇒ zero rows (fail-closed, ADR-0002). FORCE means even the table owner is
  subject to the policy; the app connects as `logalot_app` which is `NOSUPERUSER NOBYPASSRLS` (000011),
  so RLS bites.
- **Grants:** none in this migration. 000011's `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT
  SELECT, INSERT, UPDATE, DELETE ON TABLES TO logalot_app` auto-grants `invites` to the app role because
  the migration runs as the same migrate/owner role — exactly as 000012–000017 relied on it. (Decision
  D5.) No `SECURITY DEFINER` resolver and no BYPASSRLS role is introduced.

### Arming RLS on the accept/consume path (the tenant-self-identifying token)

The invitee presents only a token — no tenant. The token is **`lginv_<tenantPublicId>_<secret>`**
(ADR-0012, mirroring `lgk_<public_id>_<secret>`). The accept path resolves the tenant from the
**non-secret slug** before any scoped read, so every statement runs under normal RLS — no cross-tenant
resolver, no `SECURITY DEFINER` (ADR-0008's structural rule):

```
1. parse slug = tenantPublicId from the token (route/handshake-cookie layer; app core sees only the hash)
2. resolve tenants.public_id -> tenants.id        (tenants is the registry, no RLS — same as the
                                                    api-key ingest path, model.md §4.5)
3. SET LOCAL app.tenant_id = '<that tenant id>'   (arms RLS for the transaction)
4. token_hash = sha256(secret); run the scoped lookup/consume below
```

A wrong/forged slug resolves to no tenant (or the wrong tenant), and the subsequent `token_hash` probe
finds **zero rows** under RLS ⇒ the uniform `null` ⇒ generic 401 (R-INV-6). The global `UNIQUE
(token_hash)` cannot be probed across tenants because the policy still constrains the armed `UPDATE`
to `tenant_id = app.current_tenant_id()` — a token can only be consumed inside the tenant whose slug
armed the session, which is the tenant that owns it.

---

## 4. The atomic consume (the at-most-once authority)

A **single conditional `UPDATE … RETURNING`** keyed on the unique `token_hash`, run **after** RLS is
armed to the slug's tenant (§3). Validity (status, expiry, email-binding) and the consume are folded
into one statement — they cannot be split, so there is no TOCTOU window and concurrent accepts
serialize on the row (R-INV-3).

```sql
UPDATE invites
   SET status      = 'consumed',
       consumed_at = now()
 WHERE token_hash  = $1            -- bytea = sha256(secret); indexed unique equality (O(1))
   AND email       = $2            -- R-INV-1 email-binding: normalized id_token email
   AND status      = 'pending'     -- R-INV-3 single-use / R-INV-5 not revoked
   AND expires_at  > now()         -- R-INV-4 not expired
RETURNING id, role, email;
```

- **`tenant_id` is NOT in the `WHERE`** — RLS already scopes the statement to
  `app.current_tenant_id()` (the armed tenant). This is the house pattern: arm the GUC, then write an
  ordinary tenant-scoped statement.
- **0 rows ⇒ `null`** for *every* failure mode (no such token, wrong email, expired, revoked, already
  consumed, lost the race) ⇒ the provisioner returns `null` ⇒ the authenticator throws the unchanged
  generic `401 reject_no_valid_invite`. No enumeration oracle (R-INV-6).
- `RETURNING id, role, email` hands the provisioner the role to translate (`admin → tenant_admin`) and
  the bound email — read **from the row**, never from client input (R-INV-8).
- The read-only `findValidByTokenHash` accept-time **liveness probe** (UX fail-fast before bouncing to
  Google) is a plain `SELECT … WHERE token_hash=$1 AND status='pending' AND expires_at>now()` under the
  same armed RLS. It **never consumes**; the `UPDATE` above is the sole authority (ADR-0012).

---

## 5. Single-transaction provisioning unit-of-work

All four writes run inside **one transaction armed with the invite's `tenant_id`** (the new structural
seam ADR-0012 flags to the BUILD phase: the participating repositories must share one tx-scoped
client — a unit-of-work). Order and rollback semantics:

```
BEGIN;
  SET LOCAL app.tenant_id = '<tenant from slug>';      -- arm RLS once for the whole UoW

  (1) CONSUME   = the atomic UPDATE … RETURNING (§4).
                  0 rows -> ROLLBACK, return null -> authenticator throws 401. The invite
                  stays 'pending' (nothing was written). This is the gate.

  (2) INSERT user        (status 'active', password_hash = non-verifiable disabled placeholder —
                          Google-only; the local-password path can never match). Under RLS, so the
                          user lands in the armed tenant. users.UNIQUE(tenant_id, email) holds.

  (3) INSERT membership  (tenant_id, user_id, role = translate(invite.role)):
                          'member' -> 'member', 'admin' -> 'tenant_admin'. FK (tenant_id, user_id)
                          -> users(tenant_id, id) guarantees same-tenant integrity.

  (4) linkFirst oauth_identity (tenant_id, user_id, provider 'google', provider_sub, email):
                          the FIRST-LINK insert. Subject to oauth_identities'
                          UNIQUE(tenant_id, provider, provider_sub) and UNIQUE(tenant_id, user_id,
                          provider) — see R13 interaction below.
COMMIT;
```

**Rollback semantics (R-INV-17 / TI-10):** because (1)–(4) are one transaction, any failure at (2),
(3) or (4) rolls back the **whole** unit including the consume — the invite returns to `pending`, and
**no orphan** user / membership / identity is left behind. There is no best-effort compensation; the
ADR explicitly forbids emulating atomicity with compensation.

**Interaction with the existing R13 `oauth_identities` conflict handling:** this branch runs **only**
when `findCredentialsByEmail == null` *and* there is no existing `oauth_identity` for the sub (so it
provisions a **new** principal — it never re-links or escalates an existing user, R-INV-8). If a
concurrent flow nonetheless wins the link first, step (4)'s `linkFirst` hits the
`UNIQUE(tenant_id, provider, provider_sub)` and raises the existing `ConflictError` (R13). Under this
unit-of-work that conflict **rolls back the transaction** — including the consume — rather than
re-linking: the invite stays `pending`, no second user is minted, and the invitee gets the uniform
401. The R13 invariant ("identity pinned to `(provider, provider_sub)`, a changed email never
re-resolves") is preserved unchanged; the invite path only feeds the *first* link.

The returning-user login path (an existing `oauth_identities` hit) never reaches this UoW — zero added
cost on the ~99% hot path (ADR-0012 NFR).

---

## 6. Migration plan

- **Highest existing migration:** `000017_oauth_identities`. **Next sequential pair:**
  **`000018_invites.up.sql` / `000018_invites.down.sql`.** Scaffold in BUILD with
  `make migrate-create name=invites`.
- **No data backfill.** `invites` is a brand-new table with no historical rows to migrate and no
  derived data to populate; existing tables are untouched. The migration is pure DDL.
- **Reversibility:** `role` and `status` are `text + CHECK` (no new enum types), and the global
  `UNIQUE(token_hash)`, both indexes, the policy, and the trigger are all owned by the table, so the
  down is a single `DROP TABLE` — no `DROP TYPE` ordering to manage (unlike 000017). The full
  up→down→up cycle (migration-plan §4) is validated in BUILD.

### `000018_invites.up.sql` (assembled — table §1 + indexes §2 + RLS/grants §3)

```sql
-- 000018 — Invite aggregate (Identity & Access). See docs/data/invites-data-model.md.

CREATE TABLE invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('member', 'admin')),
  token_hash  bytea       NOT NULL UNIQUE,
  status      text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'consumed', 'revoked')),
  expires_at  timestamptz NOT NULL,
  created_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invites_token_hash_len CHECK (octet_length(token_hash) = 32)
);

CREATE UNIQUE INDEX uq_invites_pending_per_email
  ON invites (tenant_id, email)
  WHERE status = 'pending';

CREATE INDEX idx_invites_tenant ON invites (tenant_id);

CREATE TRIGGER trg_invites_updated
  BEFORE UPDATE ON invites
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE  ROW LEVEL SECURITY;

CREATE POLICY invites_tenant_isolation ON invites
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- No explicit GRANT: 000011's ALTER DEFAULT PRIVILEGES auto-grants DML on this
-- table to logalot_app (same as 000012–000017).

COMMENT ON TABLE invites IS
  'Invite aggregate (Identity & Access, ADR-0012). A bearer authorization grant '
  'that JIT-provisions a NEW Google user at the formerly-rejecting branch. Only '
  'token_hash (sha256, 32 bytes) stored — never plaintext. Tenant-owned (FORCE '
  'RLS); tenant armed from the lginv_<slug>_<secret> token before any scoped read. '
  'role is the Invites vocabulary (member|admin), translated admin->tenant_admin at '
  'the consume seam. Atomic conditional UPDATE on token_hash is the at-most-once '
  'consume authority; provisioning shares its transaction.';
```

### `000018_invites.down.sql`

```sql
-- 000018 down. The table owns its policy, indexes, trigger, and the global
-- UNIQUE(token_hash); DROP TABLE removes them all. No enum type to drop (role and
-- status are text+CHECK), so no DROP TYPE ordering (unlike 000017).
DROP TABLE IF EXISTS invites;
```

---

## 7. Where to fold this into the standing data docs (BUILD phase)

- [`docs/data/migration-plan.md`](./migration-plan.md) §1 layout table — add the `000018_invites`
  row after `000017_oauth_identities` (matching the existing one-line-per-migration voice):
  `000018_invites.{up,down}.sql  Invite (RLS) + partial UNIQUE(tenant_id,email) WHERE pending; token_hash bytea UNIQUE; atomic consume`.
- [`docs/data/model.md`](./model.md) — add an **Invite** aggregate subsection under the Identity &
  Access context, cross-referencing ADR-0012, the membership-role translation, and the
  single-transaction provisioning unit-of-work.

These edits are **not** made in this PLAN phase.
