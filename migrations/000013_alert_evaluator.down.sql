-- 000013 down — reverse the alert-evaluator scheduling additions.
-- Validated up -> down -> up against Postgres 16.

-- Drop the scheduler role's privileges first so DROP ROLE succeeds. DROP OWNED BY
-- removes every grant made TO the role (schema usage + table grants); the role
-- owns no objects, so nothing tenant-facing is dropped by this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logalot_evaluator') THEN
    EXECUTE 'DROP OWNED BY logalot_evaluator';
  END IF;
END
$$;
DROP ROLE IF EXISTS logalot_evaluator;

DROP TABLE IF EXISTS alert_notifications;

ALTER TABLE alert_rules
  DROP COLUMN IF EXISTS transition_seq,
  DROP COLUMN IF EXISTS last_notified_at;
