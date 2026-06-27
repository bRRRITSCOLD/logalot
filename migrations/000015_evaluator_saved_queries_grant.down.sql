-- Revoke SELECT on saved_queries from logalot_evaluator (reverse of 000015 up),
-- and restore the prior table comment that 000015 replaced.
REVOKE SELECT ON saved_queries FROM logalot_evaluator;

COMMENT ON TABLE saved_queries IS
  'Tenant-owned reusable query definitions (Workspace context). Referenced by '
  'dashboards and alert_rules by id.';
