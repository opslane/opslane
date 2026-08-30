-- Exact-message cross-issue counts use a digest to keep unbounded messages
-- out of B-tree entries. Equality is checked alongside the digest by readers.
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
       AND c.relname = 'idx_error_events_message_digest'
       AND NOT i.indisvalid
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', invalid_index.schema_name, invalid_index.index_name);
  END LOOP;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_error_events_message_digest
  ON error_events (project_id, environment_id, platform, digest(error_message, 'sha256'));
