-- 000016 — retention-worker role and SECURITY DEFINER hot-drop function.
--
-- The retention worker (services/retention-worker) needs two privileges that
-- neither logalot_app nor logalot_evaluator provides:
--
--   1. BYPASSRLS on `retention_policies` — the worker must read every tenant's
--      policy to drive per-tenant cold-prefix expiry, which FORCE ROW LEVEL
--      SECURITY would block under logalot_app (no tenant context is set for a
--      cross-tenant sweep).
--
--   2. DROP TABLE on log_events partitions — to call
--      app.drop_log_events_partitions_older_than. The function itself is
--      redefined here as SECURITY DEFINER so it runs as its owner (the
--      migrate/admin role, who owns the partitions), and only logalot_retention
--      is granted EXECUTE. This keeps DDL privilege contained: the retention
--      worker calls the function, the function drops only log_events_YYYYMMDD
--      partitions (regex-gated, never the default partition).
--
-- ── Redefine app.drop_log_events_partitions_older_than as SECURITY DEFINER ──
--
-- Same logic as 000010, plus:
--   * SECURITY DEFINER → runs as the function owner (admin), who CAN DROP TABLE.
--   * SET search_path = pg_catalog, public, app → pg_catalog FIRST so the catalog
--     relations + builtins this function reads (pg_inherits, pg_class, to_date,
--     format, right) can never be shadowed by a same-named object a caller
--     created in `public`. `public` stays IN the path (second) so the unqualified
--     DROP TABLE log_events_YYYYMMDD still resolves the partition tables.
--
-- Only log_events_YYYYMMDD partitions are dropped (regex '^log_events_[0-9]{8}$');
-- the default partition is never touched.

CREATE OR REPLACE FUNCTION app.drop_log_events_partitions_older_than(
  p_retention_days integer DEFAULT 30
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  v_cutoff  date    := current_date - p_retention_days;
  v_dropped integer := 0;
  r         record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM   pg_inherits  i
    JOIN   pg_class     c ON c.oid = i.inhrelid
    JOIN   pg_class     p ON p.oid = i.inhparent
    WHERE  p.relname = 'log_events'
      AND  c.relname ~ '^log_events_[0-9]{8}$'
      AND  to_date(right(c.relname, 8), 'YYYYMMDD') < v_cutoff
  LOOP
    EXECUTE format('DROP TABLE %I', r.relname);
    v_dropped := v_dropped + 1;
  END LOOP;
  RETURN v_dropped;
END;
$$;

COMMENT ON FUNCTION app.drop_log_events_partitions_older_than(integer) IS
  'Drops daily log_events_YYYYMMDD partitions strictly older than p_retention_days. '
  'SECURITY DEFINER so logalot_retention can invoke it without owning the partitions. '
  'Only matches the date-partition regex; the default partition is never touched.';

-- ── logalot_retention: the retention-worker scheduler login ──────────────────
-- BYPASSRLS so the worker can read retention_policies across all tenants.
-- NOT a superuser; it owns nothing; DDL is gated to the one SECURITY DEFINER
-- function above.
--
-- Dev credentials (LOCAL DEV ONLY): role `logalot_retention` / password
-- `logalot_retention`. Rotate for any non-local environment with:
--   ALTER ROLE logalot_retention PASSWORD '…';
-- The matching connection string is LOGALOT_RETENTION_DATABASE_URL (mirrors the
-- rotation note on logalot_app in migration 000011).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logalot_retention') THEN
    CREATE ROLE logalot_retention
      LOGIN PASSWORD 'logalot_retention'
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
END
$$;

-- Belt-and-suspenders: re-assert attributes even if the role pre-existed.
ALTER ROLE logalot_retention NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public     TO logalot_retention;
GRANT USAGE ON SCHEMA app        TO logalot_retention;
GRANT USAGE ON SCHEMA pg_catalog TO logalot_retention;

-- Least privilege: the worker reads ONLY retention_policies (RetentionStore.
-- ListAll selects tenant_id + hot_days + cold_days from it; tenant_id is the
-- policy's own PK, so no separate `tenants` read is needed). No grant on
-- log_events or any tenant content table.
GRANT SELECT ON retention_policies TO logalot_retention;

-- The single DDL capability: call the SECURITY DEFINER drop function.
GRANT EXECUTE ON FUNCTION app.drop_log_events_partitions_older_than(integer)
  TO logalot_retention;

-- app.current_tenant_id() is NOT needed by the retention worker (it bypasses
-- RLS for its cross-tenant reads). Intentionally not granted.

COMMENT ON ROLE logalot_retention IS
  'retention-worker login. BYPASSRLS to sweep retention_policies across all '
  'tenants. Granted EXECUTE on app.drop_log_events_partitions_older_than only; '
  'no log_events access, no other DDL.';
