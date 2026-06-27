-- 000006 — RetentionPolicy aggregate (Identity & Access context, ADR-0005).
--
-- One policy per tenant (PK = tenant_id). hot_days drives query hot/cold routing
-- and any per-tenant hot pruning; cold_days drives cold-tier prefix expiry.
--
-- IMPORTANT (pooled hot store): the hot table is partitioned by TIME ONLY, so a
-- daily partition holds every tenant's rows for that day. The shared partition
-- DROP therefore happens at the GLOBAL hot horizon (default 30d). A tenant that
-- wants a SHORTER hot window has its excess rows removed by a tenant-scoped
-- DELETE (optional, off the hot path) and otherwise relies on the cold tier.
-- True per-tenant retention (cold_days) is enforced cheaply by S3 prefix delete.

CREATE TABLE retention_policies (
  tenant_id  uuid        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  hot_days   integer     NOT NULL DEFAULT 30  CHECK (hot_days  BETWEEN 1 AND 90),
  cold_days  integer     NOT NULL DEFAULT 365 CHECK (cold_days >= hot_days),
  updated_by uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_retention_policies_updated
  BEFORE UPDATE ON retention_policies
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies FORCE  ROW LEVEL SECURITY;

CREATE POLICY retention_policies_tenant_isolation ON retention_policies
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
