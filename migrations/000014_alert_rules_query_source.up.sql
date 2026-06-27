-- 000014 — fix the tautological alert_rules query-source CHECK (#16 review I2).
--
-- 000009 shipped `CHECK (saved_query_id IS NOT NULL OR query <> '{}' OR query =
-- '{}')` — the trailing `OR query = '{}'` makes it always true, so it enforces
-- nothing. A rule with no saved query AND an empty inline query passes, and the
-- evaluator's COUNT then matches EVERY event in the window (no filter) → spurious
-- firing. Replace it with a meaningful constraint: a rule must reference a saved
-- query OR carry a non-empty inline query.
--
-- This is the storage-layer backstop; the control-plane additionally rejects an
-- empty effective query at the API, and the evaluator defensively skips any rule
-- whose inline query is empty (saved-query resolution is deferred).

ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_query_source;

ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_query_source
  CHECK (saved_query_id IS NOT NULL OR query <> '{}'::jsonb);
