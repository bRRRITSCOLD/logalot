-- 000016 rollback — drop logalot_retention role and revert the function to
-- its original non-SECURITY-DEFINER form (matching 000010's definition).

-- Revert app.drop_log_events_partitions_older_than to non-SECURITY-DEFINER.
CREATE OR REPLACE FUNCTION app.drop_log_events_partitions_older_than(
  p_retention_days integer DEFAULT 30
)
RETURNS integer
LANGUAGE plpgsql
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

-- Revoke grants and drop the role.
REVOKE EXECUTE ON FUNCTION app.drop_log_events_partitions_older_than(integer)
  FROM logalot_retention;
REVOKE SELECT ON retention_policies FROM logalot_retention;
REVOKE SELECT ON tenants            FROM logalot_retention;
REVOKE USAGE  ON SCHEMA public      FROM logalot_retention;
REVOKE USAGE  ON SCHEMA app         FROM logalot_retention;
REVOKE USAGE  ON SCHEMA pg_catalog  FROM logalot_retention;
DROP ROLE IF EXISTS logalot_retention;
