-- 000010 — Hot log store: log_events (Log Storage & Retention shared kernel).
--
-- THE load-bearing data object (ADR-0003). A declaratively RANGE-partitioned
-- table on `ts` (daily partitions). Every tenant-scoped query is tenant_id +
-- time-range bound, which prunes to a handful of partitions and keeps per-query
-- cost independent of total cluster volume (NFR-1, NFR-3).
--
-- Why partition by TIME ONLY (not by tenant too):
--   * Retention = DROP old daily partitions in O(1), no DELETE churn (ADR-0003).
--   * Hundreds of tenants -> tenant subpartitioning would explode partition count.
--   * Tenant isolation is provided by (a) tenant_id as the leading PK column,
--     (b) RLS, (c) the mandatory tenant_id predicate from TenantContext.
--   Bridge tenants (ADR-0002) can later be split to their own partition set
--   behind the same LogStore port without changing this schema for everyone.
--
-- Indexes are created on the PARENT so PostgreSQL auto-creates them on every
-- partition (existing and future). RLS policies on the parent govern all access
-- through the parent table — and ALL reads/writes go through the parent, never a
-- partition directly (the LogStore adapter contract).

CREATE TABLE log_events (
  tenant_id uuid        NOT NULL,
  ts        timestamptz NOT NULL,
  id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  service   text        NOT NULL,
  level     log_level   NOT NULL,
  message   text        NOT NULL,
  labels    jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- structured fields/labels
  trace_id  text,
  span_id   text,
  raw       jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- original normalized envelope
  -- Full-text vector, maintained automatically. The 2-arg to_tsvector(regconfig,
  -- text) form is IMMUTABLE, so it is valid in a STORED generated column.
  search    tsvector GENERATED ALWAYS AS (
              to_tsvector('english', coalesce(message, '') || ' ' || coalesce(service, ''))
            ) STORED,
  -- tenant_id leads the PK (tenant prefix, ADR-0003); ts is required because it
  -- is the partition key; id breaks ties and powers keyset pagination on (ts,id).
  PRIMARY KEY (tenant_id, ts, id)
) PARTITION BY RANGE (ts);

-- Note: there is intentionally NO foreign key from log_events.tenant_id to
-- tenants(id). The hot path writes at >=50k/s and tenant validity is already
-- guaranteed upstream by auth (ADR-0007) before any event is enqueued; an FK
-- check per insert would be pure write overhead.

-- ── Indexes (propagate to all partitions) ────────────────────────────────────
-- BRIN on ts: logs are append-time-ordered so ts is highly physically correlated;
-- BRIN is tiny and ideal for time-range scans within a partition.
CREATE INDEX idx_log_events_ts_brin ON log_events USING brin (ts) WITH (pages_per_range = 32);
-- GIN on the FTS vector (full-text search).
CREATE INDEX idx_log_events_search  ON log_events USING gin (search);
-- GIN on labels with jsonb_path_ops (smaller/faster for @> containment filters).
CREATE INDEX idx_log_events_labels  ON log_events USING gin (labels jsonb_path_ops);
-- Common structured filters, time-ordered for keyset within the filter.
CREATE INDEX idx_log_events_svc_ts  ON log_events (tenant_id, service, ts DESC);
CREATE INDEX idx_log_events_lvl_ts  ON log_events (tenant_id, level,   ts DESC);
-- Keyset pagination (tenant_id, ts DESC, id DESC) is served by a backward scan
-- of the primary key index; no extra index needed.

-- ── Row-Level Security (fail-closed tenant backstop, ADR-0002) ───────────────
ALTER TABLE log_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY log_events_tenant_isolation ON log_events
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ── Default partition ────────────────────────────────────────────────────────
-- Catches any row whose ts falls outside every daily partition. In steady state
-- it stays EMPTY because partitions are created ahead of time. Caveat: while the
-- default holds rows, a new partition overlapping them cannot be attached — the
-- ensure-ahead job (below) keeps it empty so this never bites.
CREATE TABLE log_events_default PARTITION OF log_events DEFAULT;

-- ── Partition lifecycle functions ────────────────────────────────────────────

-- Create one daily partition log_events_YYYYMMDD for [p_day, p_day+1). Idempotent.
CREATE OR REPLACE FUNCTION app.create_log_events_partition(p_day date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_name  text := format('log_events_%s', to_char(p_day, 'YYYYMMDD'));
BEGIN
  IF to_regclass(format('public.%I', v_name)) IS NOT NULL THEN
    RETURN;  -- already exists
  END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF log_events FOR VALUES FROM (%L) TO (%L)',
    v_name, p_day::timestamptz, (p_day + 1)::timestamptz
  );
END;
$$;

-- Ensure partitions exist for today .. today+p_days_ahead. Run on a schedule
-- (cron/pg_cron) ahead of ingest so rows never land in the default partition.
CREATE OR REPLACE FUNCTION app.ensure_log_events_partitions(p_days_ahead integer DEFAULT 7)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  d date;
BEGIN
  FOR d IN
    SELECT generate_series(current_date, current_date + p_days_ahead, interval '1 day')::date
  LOOP
    PERFORM app.create_log_events_partition(d);
  END LOOP;
END;
$$;

-- Retention: drop daily partitions strictly older than p_retention_days (default
-- 30, the global hot horizon). Only ever matches log_events_YYYYMMDD partitions,
-- NEVER the default partition. Returns the number dropped. O(1) per partition.
CREATE OR REPLACE FUNCTION app.drop_log_events_partitions_older_than(p_retention_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_cutoff  date := current_date - p_retention_days;
  v_dropped integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'log_events'
      AND c.relname ~ '^log_events_[0-9]{8}$'
      AND to_date(right(c.relname, 8), 'YYYYMMDD') < v_cutoff
  LOOP
    EXECUTE format('DROP TABLE %I', r.relname);
    v_dropped := v_dropped + 1;
  END LOOP;
  RETURN v_dropped;
END;
$$;

-- Bootstrap an initial partition window so the vertical slice works immediately
-- after `migrate up` (today + 7 days). Production keeps this current via the
-- scheduled ensure job (see docs/data/migration-plan.md).
SELECT app.ensure_log_events_partitions(7);
