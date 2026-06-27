-- 000013 — alert-evaluator scheduling + idempotent notification dispatch.
--
-- The AlertRule table itself already exists (000009, Alerting context). This
-- migration adds the pieces the alert-evaluator WORKER (ADR-0001, services/
-- alert-evaluator) needs to schedule rules across all tenants and dispatch
-- exactly one notification per state transition — without ever leaking one
-- tenant's log content to another.
--
-- Two load-bearing decisions live here:
--
--   1. THE BYPASSRLS SCHEDULER ROLE (model.md §4.5). The evaluator must find due
--      rules across ALL tenants, which FORCE ROW LEVEL SECURITY would hide. It
--      therefore connects a SEPARATE role, `logalot_evaluator`, that has
--      BYPASSRLS — but is granted access ONLY to the scheduling metadata tables
--      (`alert_rules`, `alert_notifications`). It is deliberately granted NOTHING
--      on `log_events`, so even with BYPASSRLS it physically cannot read log
--      content (permission denied before RLS is even consulted). Log COUNT reads
--      re-enter per-tenant RLS context via the ordinary NOSUPERUSER `logalot_app`
--      role (000011) under `SET LOCAL app.tenant_id`. This grant boundary is the
--      tenant-isolation backstop and is asserted by an integration test.
--
--   2. EXACTLY-ONCE NOTIFICATION PER TRANSITION. A monotonic `transition_seq` on
--      alert_rules is bumped on every state change; `alert_notifications` records
--      one outbox row per transition with UNIQUE (rule_id, transition_seq). The
--      evaluator performs the state change as a compare-and-swap
--      (UPDATE ... WHERE state = <expected>) and inserts the outbox row in the
--      SAME transaction, so two racing evaluators can never emit two
--      notifications for one transition, and a rule that stays `firing` across
--      many evaluations never re-notifies (no duplicate spam). The clear
--      (firing -> ok) is itself a transition, so it emits exactly one "resolved"
--      notification.

-- ── alert_rules: scheduling/idempotency columns ──────────────────────────────
ALTER TABLE alert_rules
  -- Monotonic transition counter; the second half of the notification idempotency
  -- key. Bumped by the evaluator's compare-and-swap on every state change.
  ADD COLUMN IF NOT EXISTS transition_seq  bigint      NOT NULL DEFAULT 0,
  -- Observability: when the most recent transition notification was dispatched.
  -- NOT the idempotency mechanism (that is transition_seq + the outbox unique key).
  ADD COLUMN IF NOT EXISTS last_notified_at timestamptz;

-- ── alert_notifications: the transactional outbox / idempotency ledger ────────
-- One row per state transition. Written in the SAME transaction as the alert_rules
-- state CAS, so it exists iff the transition happened. dispatched_at is stamped
-- after the Notifier delivers; a crash between commit and dispatch leaves
-- dispatched_at NULL, and the unique (rule_id, transition_seq) makes any redelivery
-- sweep idempotent.
CREATE TABLE alert_notifications (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id        uuid        NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  -- The transition this notification corresponds to (alert_rules.transition_seq
  -- AFTER the bump). UNIQUE per rule => exactly one notification per transition.
  transition_seq bigint      NOT NULL,
  to_state       alert_state NOT NULL,
  observed_count numeric     NOT NULL,
  threshold      numeric     NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz,
  UNIQUE (rule_id, transition_seq)
);

CREATE INDEX idx_alert_notifications_rule ON alert_notifications (tenant_id, rule_id);
-- Redelivery sweep target: outbox rows not yet dispatched.
CREATE INDEX idx_alert_notifications_pending ON alert_notifications (occurred_at)
  WHERE dispatched_at IS NULL;

ALTER TABLE alert_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_notifications FORCE  ROW LEVEL SECURITY;

CREATE POLICY alert_notifications_tenant_isolation ON alert_notifications
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- logalot_app (the RLS-governed app role) auto-receives DML on alert_notifications
-- via the ALTER DEFAULT PRIVILEGES set in 000011 (this migration runs as the same
-- owner). The control-plane and any tenant-scoped reader thus see only their own
-- notification rows. No explicit grant needed here for logalot_app.

-- ── logalot_evaluator: the BYPASSRLS scheduler login ─────────────────────────
-- Idempotent create. BYPASSRLS is the load-bearing attribute (it must see all
-- tenants' rule rows to schedule them). It is NOT a superuser and owns nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logalot_evaluator') THEN
    CREATE ROLE logalot_evaluator
      LOGIN PASSWORD 'logalot_evaluator'
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
END
$$;

-- Belt-and-suspenders: re-assert the attributes even if the role pre-existed.
ALTER ROLE logalot_evaluator NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO logalot_evaluator;
GRANT USAGE ON SCHEMA app    TO logalot_evaluator;

-- Scheduling metadata ONLY. SELECT to find/read rules; UPDATE to write back
-- state/transition_seq/last_evaluated_at/last_notified_at. NO INSERT/DELETE on
-- alert_rules (rule lifecycle is the control-plane's job as logalot_app).
GRANT SELECT, UPDATE ON alert_rules TO logalot_evaluator;

-- The notification outbox: the evaluator inserts a row per transition and stamps
-- dispatched_at after delivery; SELECT lets a redelivery sweep find pending rows.
GRANT SELECT, INSERT, UPDATE ON alert_notifications TO logalot_evaluator;

-- app.current_tenant_id() and friends are not needed by the evaluator's metadata
-- path (it BYPASSes RLS); EXECUTE is intentionally NOT granted here. The scheduler
-- never arms tenant context — that happens on the SEPARATE logalot_app connection.

-- CRITICAL NON-GRANT: logalot_evaluator is given NOTHING on log_events (nor any
-- other tenant-owned content table). With no table privilege, a SELECT on
-- log_events fails with "permission denied" regardless of BYPASSRLS — so the
-- scheduler role structurally cannot read tenant log content. Log reads happen
-- only via logalot_app under SET LOCAL app.tenant_id (RLS-governed).

COMMENT ON ROLE logalot_evaluator IS
  'alert-evaluator scheduler login. BYPASSRLS so it can list due rules across all '
  'tenants, but granted ONLY alert_rules + alert_notifications — never log_events. '
  'Log content is read by logalot_app under per-tenant RLS, never by this role.';

COMMENT ON TABLE alert_notifications IS
  'Transactional outbox / idempotency ledger: one row per alert state transition, '
  'UNIQUE (rule_id, transition_seq) => exactly one notification per transition.';
