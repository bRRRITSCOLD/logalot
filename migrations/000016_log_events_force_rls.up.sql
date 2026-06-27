-- 000016 — Harden log_events: FORCE ROW LEVEL SECURITY (#42).
--
-- Defense-in-depth rationale (mirrors the pattern in 000004/000005):
--
--   `ENABLE ROW LEVEL SECURITY` (already in 000010) makes RLS active for
--   non-owner roles. `FORCE ROW LEVEL SECURITY` additionally applies the
--   policy to the table OWNER (the migrate/admin role). Without FORCE, a
--   session connecting as the owner would see all rows regardless of
--   app.current_tenant_id() — a silent bypass of the tenant backstop.
--
--   Today this is not exploitable because services connect exclusively as
--   the NOSUPERUSER `logalot_app` role (000011). However, the owner-also-
--   bound pattern is documented in 000011 as a load-bearing invariant and
--   ALL other tenant-owned tables (users, memberships, api_keys, etc.)
--   already use FORCE. This migration closes the gap so the log_events
--   security posture matches every other table in the model.
--
-- Idempotent: FORCE on an already-forced table is a no-op in PostgreSQL.

ALTER TABLE log_events FORCE ROW LEVEL SECURITY;
