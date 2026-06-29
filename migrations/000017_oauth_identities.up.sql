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
-- MULTI-TENANT MEMBERSHIP: a single Google account can link to one user PER
-- TENANT. The tenant is ALWAYS known before the lookup — it rides in the single-
-- use server-side `state` issued by the tenant-scoped login page, the SAME tenant-
-- scoping discipline the password path uses via tenantSlug. So EVERY access path
-- arms RLS with state.tenant_id first and then runs an ordinary tenant-scoped
-- query. There is no chicken-and-egg and therefore NO RLS bypass:
--   1. First link:  SET LOCAL app.tenant_id = <state tenant>; match the user via
--      users (UNIQUE(tenant_id, email)); INSERT this row under RLS. The
--      UNIQUE(tenant_id, provider, provider_sub) rejects a second link of the same
--      Google account WITHIN that tenant; linking the same account in a DIFFERENT
--      tenant is allowed (multi-tenant membership).
--   2. Subsequent login:  SET LOCAL app.tenant_id = <state tenant>; SELECT by
--      (provider, provider_sub) WITHIN that tenant. The "linked tenant == state
--      tenant" cross-check (threat model R3) is now STRUCTURAL: the row is only
--      visible if it exists in the armed tenant. A Google account linked only to
--      tenant A is simply not found when arriving via tenant B's page, so the flow
--      falls through to the first-link email match (and 401 if no user exists in B).

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
  -- One link per Google account PER TENANT (tenant-scoped => RLS-friendly). This
  -- is also the index that backs the by-sub login lookup within the armed tenant.
  -- Allows the same Google account to be a member of multiple tenants (one row
  -- per tenant) — multi-tenant membership.
  UNIQUE (tenant_id, provider, provider_sub),
  -- One linked identity per user per provider: a given user links at most one
  -- Google account. Tenant-scoped => RLS-friendly.
  UNIQUE (tenant_id, user_id, provider),
  -- Same-tenant integrity: the identity's tenant MUST equal the user's home
  -- tenant (mirrors memberships/refresh_tokens). A link can never point at a user
  -- in another tenant. Also gives the inline tenants FK below a composite anchor.
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- No bare (tenant_id) index: both UNIQUE constraints are tenant-leading and serve
-- every tenant-scoped scan (including the by-sub login lookup), so a single-column
-- index would only add write cost (same reasoning as refresh_tokens, 000012).

CREATE TRIGGER trg_oauth_identities_updated
  BEFORE UPDATE ON oauth_identities
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE oauth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_identities FORCE  ROW LEVEL SECURITY;

CREATE POLICY oauth_identities_tenant_isolation ON oauth_identities
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- NO SECURITY DEFINER resolver and NO BYPASSRLS role: the tenant is always known
-- from `state` before any oauth lookup, so every read/write runs under normal RLS
-- (SET LOCAL app.tenant_id, then a tenant-scoped SELECT/INSERT). Table DML for
-- logalot_app is covered by the ALTER DEFAULT PRIVILEGES in 000011 (objects
-- created by the migrate role are auto-granted), exactly like 000012+.

COMMENT ON TABLE oauth_identities IS
  'Links an existing logalot user to an external OIDC identity (Google v1, '
  'ADR-0007). Invite-only: never creates a user. Identity pinned to '
  '(provider, provider_sub), unique PER TENANT — one Google account may link to '
  'one user per tenant (multi-tenant membership). Tenant-owned (RLS); the tenant '
  'is always known from state, so every access path is a normal RLS-scoped query '
  '(no bypass). First-link tenant scoping is load-bearing (threat model §0).';
