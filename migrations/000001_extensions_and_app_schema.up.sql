-- 000001 — extensions, app schema, shared helpers.
--
-- This migration installs the primitives every later migration depends on:
--   * pgcrypto         -> gen_random_uuid() for surrogate keys, digest() for the
--                         dev API-key seed (SHA-256 of the key secret).
--   * schema `app`     -> namespace for platform helper functions so they never
--                         collide with tenant/domain objects in `public`.
--   * app.current_tenant_id() -> the single source of truth that EVERY row-level
--                         security policy reads. It returns the per-transaction
--                         GUC `app.tenant_id`, which the backend sets once per
--                         request via `SET LOCAL app.tenant_id = '<uuid>'`.
--
-- TENANT-CONTEXT CONVENTION (relied on by ingest/processor/query/control-plane):
--   Before issuing any tenant-scoped statement the adapter MUST run, inside the
--   same transaction:
--       SET LOCAL app.tenant_id = '<tenant uuid from TenantContext>';
--   If the GUC is unset or blank, app.current_tenant_id() returns NULL and every
--   policy predicate `tenant_id = app.current_tenant_id()` evaluates to NULL ->
--   FALSE, so the query sees/writes ZERO rows. This is the fail-closed backstop
--   from ADR-0002 §3.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

-- Tenant-context accessor. STABLE so the planner evaluates it once per query
-- (good for partition pruning) rather than per row.
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_tenant_id() IS
  'Returns the per-transaction tenant context (GUC app.tenant_id) or NULL when '
  'unset. Read by every RLS policy; NULL => fail-closed (zero rows).';

-- Generic updated_at maintenance trigger, reused by every mutable table (DRY).
CREATE OR REPLACE FUNCTION app.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
