-- 000016 down — Revert log_events to owner-exempt RLS (reverse of FORCE).
-- NOTE: this weakens the tenant backstop for sessions connecting as the table
-- owner. Only run this in a development environment; never in production.
ALTER TABLE log_events NO FORCE ROW LEVEL SECURITY;
