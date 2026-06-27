-- 000004 — User aggregate + Membership (RBAC) within the Identity & Access context.
--
-- A user belongs to a home tenant (v1: one tenant per user). Memberships carry
-- the per-tenant RBAC role and are kept as a separate table so the model can grow
-- to multi-tenant users (bridge promotion, ADR-0002) without reshaping users.
--
-- RLS: every row of both tables is scoped by tenant_id = app.current_tenant_id().
-- FORCE ROW LEVEL SECURITY ensures even the table owner (which migrations and the
-- app may connect as) is subject to the policy. The application role MUST NOT have
-- BYPASSRLS and MUST NOT be a superuser.

CREATE TABLE users (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email                text        NOT NULL,
  password_hash        text        NOT NULL,
  display_name         text,
  status               text        NOT NULL DEFAULT 'active',
  -- Cross-tenant, platform-scope role. Held here (not in memberships) because it
  -- is NOT a tenant grant: a platform_operator never gets tenant log content.
  is_platform_operator boolean     NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  -- Composite-unique target so memberships can FK (tenant_id, user_id) and thus
  -- guarantee a membership's tenant matches the user's home tenant.
  UNIQUE (tenant_id, id)
);

CREATE INDEX idx_users_tenant ON users (tenant_id);

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;

CREATE POLICY users_tenant_isolation ON users
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


CREATE TABLE memberships (
  tenant_id  uuid            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid            NOT NULL,
  role       membership_role NOT NULL DEFAULT 'member',
  created_at timestamptz     NOT NULL DEFAULT now(),
  updated_at timestamptz     NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  -- Same-tenant integrity: the membership's tenant must equal the user's tenant.
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER trg_memberships_updated
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE  ROW LEVEL SECURITY;

CREATE POLICY memberships_tenant_isolation ON memberships
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
