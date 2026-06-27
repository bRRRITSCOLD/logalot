-- 000010 down
DROP FUNCTION IF EXISTS app.drop_log_events_partitions_older_than(integer);
DROP FUNCTION IF EXISTS app.ensure_log_events_partitions(integer);
DROP FUNCTION IF EXISTS app.create_log_events_partition(date);
-- Dropping the parent cascades to every daily partition and the default partition.
DROP TABLE IF EXISTS log_events CASCADE;
