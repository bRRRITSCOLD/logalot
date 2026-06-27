-- 000011 — logalot_app role (the RLS-governed application login).
--
-- Why this is a migration and not ad-hoc SQL: every service (ingest, processor,
-- query, control-plane) connects to Postgres AS THIS ROLE, never as the
-- migrate/admin owner. The whole multi-tenant backstop depends on it:
--
--   * Tenant-owned tables use `FORCE ROW LEVEL SECURITY`, so even the table OWNER
--     is subject to the policy — UNLESS the connecting role is a superuser or has
--     BYPASSRLS, which silently bypass even FORCE (model.md §4.2). Therefore the
--     application role MUST be NOSUPERUSER and MUST NOT have BYPASSRLS.
--   * The migrate/admin role (POSTGRES_USER) stays separate: it OWNS the schema
--     and runs migrations; logalot_app owns NOTHING and is only granted DML +
--     EXECUTE. Keeping ownership out of the app role is what makes FORCE RLS bite.
--
-- Dev credentials (LOCAL DEV ONLY): role `logalot_app` / password `logalot_app`.
-- Rotate for any non-local environment with:  ALTER ROLE logalot_app PASSWORD '…';
-- The matching connection string lives in .env.example as LOGALOT_APP_DATABASE_URL.

-- ── Role ─────────────────────────────────────────────────────────────────────
-- Idempotent create. The attributes below are the security contract; NOSUPERUSER
-- and NOBYPASSRLS are the load-bearing ones for the RLS backstop.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logalot_app') THEN
    CREATE ROLE logalot_app
      LOGIN PASSWORD 'logalot_app'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
END
$$;

-- Belt-and-suspenders: re-assert the security-critical attributes even if the
-- role pre-existed with different ones. RLS is only a backstop if both are false.
ALTER ROLE logalot_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- ── Schema usage ─────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO logalot_app;
GRANT USAGE ON SCHEMA app    TO logalot_app;

-- ── Table DML ────────────────────────────────────────────────────────────────
-- SELECT/INSERT/UPDATE/DELETE on every domain table (DRY: covers tenants, users,
-- memberships, api_keys, retention_policies, saved_queries, dashboards,
-- alert_rules, and the partitioned parent log_events). RLS still constrains every
-- row touched on the tenant-owned tables; this grant only opens the verbs.
-- Access to log_events partitions goes through the parent, so the parent grant
-- governs them — no per-partition grant needed.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO logalot_app;

-- ── Function execution ───────────────────────────────────────────────────────
-- EXECUTE on app.* (current_tenant_id, set_updated_at, and the partition
-- lifecycle helpers). app.current_tenant_id() is invoked by every RLS policy, so
-- the app role must be able to run it.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO logalot_app;

-- ── Future objects (sensible future-proofing, not speculation) ───────────────
-- Later migrations run as the same admin/owner role; these default privileges
-- mean a new domain table or app function is automatically reachable by the app
-- role without amending this migration. Scoped to objects created by the current
-- (migrate) role only.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO logalot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO logalot_app;

COMMENT ON ROLE logalot_app IS
  'Application login for all services. NOSUPERUSER + NOBYPASSRLS so FORCE ROW '
  'LEVEL SECURITY governs it. Owns nothing; granted DML + EXECUTE only.';
