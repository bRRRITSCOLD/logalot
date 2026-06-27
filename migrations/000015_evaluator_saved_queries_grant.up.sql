-- 000015 — Grant logalot_evaluator SELECT on saved_queries.
--
-- Context (ADR-0001 + issue #18):
--
--   The alert-evaluator worker resolves saved_query_id-only alert rules by reading
--   the saved_queries table to populate the rule's RuleQuery. Migration 000013
--   deliberately granted logalot_evaluator NOTHING on saved_queries (only
--   alert_rules + alert_notifications) because that grant did not exist yet.
--
-- Security reasoning for this grant:
--
--   * A saved_query row contains ONLY metadata (name, description, query_text,
--     filters, time_range) — the DEFINITION of a query, not log content itself.
--     Granting an evaluator metadata role SELECT on query definitions is the same
--     class of grant as reading the alert_rules.query jsonb column (which was
--     already allowed). The actual log COUNT still runs through the NOSUPERUSER
--     logalot_app role under per-tenant RLS (LogCounter port, model.md §4.5) —
--     logalot_evaluator NEVER touches log_events.
--
--   * logalot_evaluator has BYPASSRLS, so it reads ALL tenants' saved_queries.
--     The adapter is required to filter by both saved_query_id AND tenant_id
--     (from the alert rule's own tenant_id) so a saved query from tenant B cannot
--     be injected into tenant A's alert rule. This is enforced in the adapter query:
--       SELECT ... FROM saved_queries WHERE id = $1 AND tenant_id = $2
--
--   * Only SELECT is granted (not INSERT/UPDATE/DELETE). The evaluator's role in
--     the saved_queries lifecycle is strictly: read the query definition. Writes
--     (CRUD) remain the control-plane's domain over logalot_app under RLS.
--
--   * log_events remains ungrantable to logalot_evaluator — that non-grant in
--     000013 is preserved and unchanged by this migration.

GRANT SELECT ON saved_queries TO logalot_evaluator;

COMMENT ON TABLE saved_queries IS
  'Tenant-owned reusable query definitions (Workspace context). Referenced by '
  'dashboards and alert_rules by id. SELECT granted to logalot_evaluator '
  '(000015) for saved_query_id resolution in the alert-evaluator pipeline — '
  'the definition is query metadata, not log content.';
