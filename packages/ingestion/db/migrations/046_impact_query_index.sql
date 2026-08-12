-- C3/W3.1: impact arithmetic bounds occurrences by client event time, which
-- shares a clock domain with session chunk event bounds. The migration runner
-- replays every file with per-statement autocommit, so every statement must be
-- safe to run again and CONCURRENTLY is legal here.
DO $$
DECLARE
  invalid_index record;
BEGIN
  FOR invalid_index IN
    SELECT n.nspname AS schema_name, c.relname AS index_name
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname IN (
         'idx_error_events_group_timestamp',
         'idx_friction_signals_incident_occurred'
       )
       AND NOT i.indisvalid
  LOOP
    EXECUTE format('DROP INDEX %I.%I', invalid_index.schema_name, invalid_index.index_name);
  END LOOP;
END
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_error_events_group_timestamp
  ON error_events (error_group_id, "timestamp")
  WHERE session_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_friction_signals_incident_occurred
  ON friction_signals (incident_id, occurred_at)
  WHERE incident_id IS NOT NULL
    AND superseded_by IS NULL
    AND retracted_at IS NULL
    AND adjudication_status = 'accepted';
