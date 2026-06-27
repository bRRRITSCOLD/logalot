-- 000008 — Dashboard aggregate (Workspace context).
--
-- A dashboard OWNS its panels, so the panel layout lives inline as JSONB rather
-- than in a child table — panels have no identity or lifecycle outside their
-- dashboard (proper aggregate boundary). Panels may reference saved_queries by
-- id inside the JSONB; that is a cross-aggregate reference by identity (no FK).
--
-- layout shape (illustrative):
--   { "panels": [ { "id":"p1", "type":"timeseries", "title":"5xx rate",
--                   "savedQueryId":"<uuid>", "viz":{...}, "grid":{x,y,w,h} } ] }

CREATE TABLE dashboards (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  description text,
  layout      jsonb       NOT NULL DEFAULT '{"panels":[]}'::jsonb,
  created_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_dashboards_tenant ON dashboards (tenant_id);

CREATE TRIGGER trg_dashboards_updated
  BEFORE UPDATE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards FORCE  ROW LEVEL SECURITY;

CREATE POLICY dashboards_tenant_isolation ON dashboards
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
