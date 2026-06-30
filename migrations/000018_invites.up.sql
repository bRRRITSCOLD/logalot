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
--
-- Design decisions (data model doc §0):
--   D1: token_hash bytea NOT NULL (matches api_keys.key_hash / refresh_tokens.token_hash)
--   D2: email text pre-normalized; partial unique on plain (tenant_id, email) WHERE pending
--   D3: role/status as text+CHECK (not enum — down is single DROP TABLE, no DROP TYPE)
--   D4: consume keyed on token_hash (ADR-0012 refinement, removes TOCTOU window)
--   D5: no explicit GRANT — 000011 ALTER DEFAULT PRIVILEGES auto-grants to logalot_app
--
-- See docs/data/invites-data-model.md for full context.

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

-- Mutable row (status flips, consumed_at) -> attach the shared updated_at trigger,
-- exactly like users/memberships/oauth_identities (refresh_tokens omits it because
-- it is append-then-mark; invites genuinely UPDATEs, so it keeps the trigger).
CREATE TRIGGER trg_invites_updated
  BEFORE UPDATE ON invites
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE  ROW LEVEL SECURITY;

CREATE POLICY invites_tenant_isolation ON invites
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- No explicit GRANT: 000011's ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT
-- SELECT, INSERT, UPDATE, DELETE ON TABLES TO logalot_app auto-grants DML on this
-- table to logalot_app because the migration runs as the same migrate/owner role
-- — exactly as 000012–000017 relied on it. (Decision D5.)

COMMENT ON TABLE invites IS
  'Invite aggregate (Identity & Access, ADR-0012). A bearer authorization grant '
  'that JIT-provisions a NEW Google user at the formerly-rejecting branch. Only '
  'token_hash (sha256, 32 bytes) stored — never plaintext. Tenant-owned (FORCE '
  'RLS); tenant armed from the lginv_<slug>_<secret> token before any scoped read. '
  'role is the Invites vocabulary (member|admin), translated admin->tenant_admin at '
  'the consume seam. Atomic conditional UPDATE on token_hash is the at-most-once '
  'consume authority; provisioning shares its transaction.';
