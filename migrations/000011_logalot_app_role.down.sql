-- 000011 down — remove the logalot_app role and everything granted to it.
--
-- A role cannot be dropped while it still holds privileges or has default-
-- privilege entries pointing at it, so revoke those first, then DROP OWNED (which
-- clears any remaining grants in this database), then drop the role itself.
-- Guarded so the down is safe to run even if the role is already gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logalot_app') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
            'REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM logalot_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA app '
            'REVOKE EXECUTE ON FUNCTIONS FROM logalot_app';
    EXECUTE 'DROP OWNED BY logalot_app';
    EXECUTE 'DROP ROLE logalot_app';
  END IF;
END
$$;
