-- 000009 — AlertRule aggregate (Alerting context). Rule CRUD lives in the
-- control-plane; evaluation runs in alert-evaluator (ADR-0001).
--
-- A rule evaluates a query over a rolling window and fires when the match count
-- crosses a threshold. It either references a SavedQuery (by identity) or carries
-- an inline `query`. Current alert state is embedded on the aggregate root
-- (state + last_triggered_at): the rule IS the alert; a separate state table is
-- YAGNI for v1 (add an alert_events history table only when audit/history is
-- actually required).

CREATE TABLE alert_rules (
  id                uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid             NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text             NOT NULL,
  -- Cross-aggregate reference by identity (no FK; same-tenant guaranteed by RLS).
  saved_query_id    uuid,
  query             jsonb            NOT NULL DEFAULT '{}'::jsonb,  -- inline query if no saved_query_id
  comparator        alert_comparator NOT NULL DEFAULT 'gt',
  threshold         numeric          NOT NULL,
  window_seconds    integer          NOT NULL DEFAULT 300
                       CHECK (window_seconds BETWEEN 30 AND 86400),
  severity          text             NOT NULL DEFAULT 'warning',
  enabled           boolean          NOT NULL DEFAULT true,
  notify_channels   jsonb            NOT NULL DEFAULT '[]'::jsonb,  -- [{type:"webhook",url}|{type:"email",to}]
  state             alert_state      NOT NULL DEFAULT 'ok',
  last_evaluated_at timestamptz,
  last_triggered_at timestamptz,
  created_by        uuid             REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz      NOT NULL DEFAULT now(),
  updated_at        timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  -- A rule references at most one query source; either may be empty (defaulted).
  CONSTRAINT alert_rules_query_source
    CHECK (saved_query_id IS NOT NULL OR query <> '{}'::jsonb OR query = '{}'::jsonb)
);

CREATE INDEX idx_alert_rules_tenant ON alert_rules (tenant_id);
-- Evaluator scan: enabled rules due for re-evaluation, oldest first.
CREATE INDEX idx_alert_rules_eval ON alert_rules (last_evaluated_at NULLS FIRST)
  WHERE enabled;

CREATE TRIGGER trg_alert_rules_updated
  BEFORE UPDATE ON alert_rules
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules FORCE  ROW LEVEL SECURITY;

CREATE POLICY alert_rules_tenant_isolation ON alert_rules
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
