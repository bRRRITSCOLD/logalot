-- 000007 — SavedQuery aggregate (Workspace context).
--
-- A reusable, tenant-owned query definition: a full-text string + structured
-- filters + a time range. Referenced BY IDENTITY (not hard FK) from dashboards
-- and alert_rules — cross-aggregate references use the id only, and same-tenant
-- integrity is guaranteed by RLS (a foreign-tenant id is simply invisible) plus
-- the repository always scoping by tenant_id from TenantContext.

CREATE TABLE saved_queries (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  description text,
  query_text  text        NOT NULL DEFAULT '',   -- FTS query string (websearch syntax)
  filters     jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- structured label/field filters
  time_range  jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- {relative:"24h"} | {from,to}
  created_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_saved_queries_tenant ON saved_queries (tenant_id);

CREATE TRIGGER trg_saved_queries_updated
  BEFORE UPDATE ON saved_queries
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE saved_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_queries FORCE  ROW LEVEL SECURITY;

CREATE POLICY saved_queries_tenant_isolation ON saved_queries
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
