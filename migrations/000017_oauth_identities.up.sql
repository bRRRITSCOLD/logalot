-- 000017 — OAuthIdentity: links an EXISTING logalot user to an external OIDC
-- identity (Google for v1). Part of the Identity & Access context (ADR-0007 —
-- the Authenticator port the ADR pre-built for SSO).
--
-- INVITE-ONLY: this table NEVER creates a user. A row is written only when a
-- verified Google id_token's (email_verified=true) email matches an ALREADY-
-- PROVISIONED user INSIDE the tenant carried in the OAuth `state` (the tenant-
-- scoped login page). See the threat model
-- (docs/security/threat-model-google-oauth.md §0): first-link tenant scoping is
-- the load-bearing invariant — an unmatched email writes NO row and mints NO
-- session (R2).
--
-- IDENTITY IS PINNED TO `provider_sub`, NOT email. After first link, subsequent
-- logins resolve by (provider, provider_sub); a changed Google email does NOT
-- re-resolve (threat model R13). `email` here is the link-time snapshot of the
-- matched, NORMALIZED email — for audit/consistency, not a resolution key.
--
-- TWO ACCESS PATHS (both must be satisfiable under FORCE ROW LEVEL SECURITY):
--   1. First link — tenant KNOWN from `state`:
--        SET LOCAL app.tenant_id = <state tenant>;        -- arm RLS
--        find the user via users (UNIQUE(tenant_id, email));
--        INSERT this row under RLS.
--      The GLOBAL UNIQUE(provider, provider_sub) rejects a sub already linked in
--      ANY tenant (even an RLS-invisible one) — "one Google account => exactly one
--      logalot user, ever". The control-plane treats that unique violation as
--      "already linked elsewhere" -> 401/409.
--   2. Subsequent login — tenant UNKNOWN, the sub is authoritative:
--      resolve (provider, provider_sub) -> (tenant_id, user_id) BEFORE any tenant
--      context exists. Under FORCE RLS a by-sub SELECT with no app.tenant_id
--      returns ZERO rows (fail-closed), so this lookup goes through the
--      SECURITY DEFINER resolver app.resolve_oauth_identity_by_sub (below). The
--      control-plane then arms RLS with the resolved tenant_id, cross-checks it
--      against state.tenant_id (mismatch => 401, threat model R3), and updates
--      last_login_at under normal RLS.
--
-- GLOBAL-UNIQUE LIMITATION (PoC, locked decision): UNIQUE(provider, provider_sub)
-- is GLOBAL, so one Google account links to exactly ONE logalot user across all
-- tenants. A person who is a member of two tenants (same email, two user rows)
-- can Google-login only to the tenant they linked first; the other stays
-- password-only for that Google account. To support multi-tenant membership via a
-- single Google account, relax to UNIQUE(tenant_id, provider, provider_sub) and
-- ALWAYS scope resolution by state.tenant_id (dropping the by-sub resolver, since
-- the tenant would then always be known). Documented future change — NOT
-- implemented here (threat model §0 escalation).

-- Provider enum (house style, 000002: small, closed, load-bearing value sets are
-- enums, not free-text + CHECK). Only 'google' ships (spec §Out of scope); a new
-- provider is a one-line `ALTER TYPE oauth_provider ADD VALUE '<name>'`.
CREATE TYPE oauth_provider AS ENUM ('google');

CREATE TABLE oauth_identities (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid           NOT NULL,
  provider      oauth_provider NOT NULL DEFAULT 'google',
  -- Google's stable subject identifier (the OIDC `sub`): the authoritative,
  -- immutable identity key after first link.
  provider_sub  text           NOT NULL,
  -- Link-time snapshot of the matched, app-NORMALIZED email (lowercase + trim +
  -- NFC, the SAME normalization user provisioning applies — threat model R14).
  -- NOT a lookup key; identity is pinned to provider_sub.
  email         text           NOT NULL,
  last_login_at timestamptz,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),
  -- One external identity ever, across ALL tenants (PoC decision). RLS filters
  -- READ visibility but NOT unique-index enforcement, so this index enforces
  -- uniqueness globally even against rows the inserting tenant cannot see. It is
  -- also the index that backs the by-sub resolver lookup (point lookup, <=1 row).
  UNIQUE (provider, provider_sub),
  -- One linked identity per user per provider (tenant-scoped => RLS-friendly).
  -- Expresses the PoC "one Google account per user" intent; relaxable.
  UNIQUE (tenant_id, user_id, provider),
  -- Same-tenant integrity: the identity's tenant MUST equal the user's home
  -- tenant (mirrors memberships/refresh_tokens). A link can never point at a user
  -- in another tenant. Also gives the inline tenants FK below a composite anchor.
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- No bare (tenant_id) index: UNIQUE(tenant_id, user_id, provider) is tenant-
-- leading and serves every tenant-scoped scan, so a single-column index would
-- only add write cost (same reasoning as refresh_tokens, 000012).

CREATE TRIGGER trg_oauth_identities_updated
  BEFORE UPDATE ON oauth_identities
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE oauth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_identities FORCE  ROW LEVEL SECURITY;

CREATE POLICY oauth_identities_tenant_isolation ON oauth_identities
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


-- ── By-sub resolver (the OIDC chicken-and-egg lookup, model.md §4.6) ──────────
-- Subsequent OIDC logins know only (provider, sub); the tenant is UNKNOWN, so RLS
-- cannot be armed yet, and a plain SELECT under FORCE RLS with no app.tenant_id
-- returns zero rows. This SECURITY DEFINER function runs as its OWNER (the
-- migrate/admin role, POSTGRES_USER — a superuser in this deployment), which
-- bypasses FORCE RLS, and returns ONLY the minimal (tenant_id, user_id) tuple for
-- an EXACT (provider, sub) match — never a scan, never any other column, never any
-- other table. The global UNIQUE(provider, provider_sub) guarantees <=1 row.
--
-- This mirrors the api-key slug resolution (model.md §4.5, pkg/auth/
-- authenticator.go) and 000016's SECURITY DEFINER precedent: the control-plane
-- stays on its single NOSUPERUSER logalot_app pool, calls this to learn the
-- AUTHORITATIVE tenant, then `SET LOCAL app.tenant_id = <resolved tenant>` and
-- does the state cross-check (R3) + last_login_at update under normal RLS.
--
-- DEPENDENCY (explicit): the bypass works because the function OWNER is a
-- superuser (POSTGRES_USER). If that role is ever de-superuser'd WITHOUT
-- BYPASSRLS, switch to the documented fallback — a dedicated BYPASSRLS role (like
-- logalot_evaluator/logalot_retention) granted SELECT on this table only, used by
-- control-plane via a separate small pool for this one lookup.
CREATE OR REPLACE FUNCTION app.resolve_oauth_identity_by_sub(
  p_provider     oauth_provider,
  p_provider_sub text
)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT oi.tenant_id, oi.user_id
  FROM   oauth_identities oi
  WHERE  oi.provider = p_provider
    AND  oi.provider_sub = p_provider_sub
$$;

COMMENT ON FUNCTION app.resolve_oauth_identity_by_sub(oauth_provider, text) IS
  'Resolves (provider, sub) -> (tenant_id, user_id) for OIDC subsequent-login '
  'BEFORE any tenant context exists. SECURITY DEFINER so it bypasses FORCE RLS '
  '(owner is superuser); returns ONLY the tenant/user tuple, never log or other '
  'content. EXECUTE granted to logalot_app only (PUBLIC revoked).';

-- A SECURITY DEFINER function is EXECUTE-to-PUBLIC by default — that would let ANY
-- role bypass RLS through it. Lock it down to the application role only.
REVOKE EXECUTE ON FUNCTION app.resolve_oauth_identity_by_sub(oauth_provider, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.resolve_oauth_identity_by_sub(oauth_provider, text) TO logalot_app;

-- Table DML for logalot_app is covered by the ALTER DEFAULT PRIVILEGES in 000011
-- (objects created by the migrate role are auto-granted), exactly like 000012+.

COMMENT ON TABLE oauth_identities IS
  'Links an existing logalot user to an external OIDC identity (Google v1, '
  'ADR-0007). Invite-only: never creates a user. Identity pinned to '
  '(provider, provider_sub), GLOBALLY unique (one Google account => one user '
  'ever). Tenant-owned (RLS); first-link tenant scoping is load-bearing '
  '(threat model §0).';
