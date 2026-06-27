-- 000014 down — restore the original (tautological) 000009 constraint shape so
-- down/up is symmetric. Validated up -> down -> up against Postgres 16.
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_query_source;

ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_query_source
  CHECK (saved_query_id IS NOT NULL OR query <> '{}'::jsonb OR query = '{}'::jsonb);
