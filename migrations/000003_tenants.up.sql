-- 000003 — Tenant aggregate root (Identity & Access context).
--
-- `tenants` is the tenant REGISTRY, not a tenant-owned table, so it carries no
-- RLS policy. It is managed by the control-plane under role checks:
--   * platform_operator: full lifecycle (provision/suspend).
--   * tenant_admin/member: read only their own row (id = app.current_tenant_id()),
--     enforced in the repository, not RLS, to keep provisioning (which runs with
--     no tenant context yet) possible.
--
-- public_id is the short slug embedded in API keys (lgk_<public_id>_<secret>,
-- ADR-0007) and in cold-tier S3 prefixes is the uuid id, not this slug.

CREATE TABLE tenants (
  id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id  text          NOT NULL UNIQUE,
  name       text          NOT NULL,
  status     tenant_status NOT NULL DEFAULT 'active',
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  -- DNS-ish slug: lowercase alnum + hyphens, 3..40 chars, no leading/trailing hyphen.
  CONSTRAINT tenants_public_id_format
    CHECK (public_id ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);

CREATE TRIGGER trg_tenants_updated
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
