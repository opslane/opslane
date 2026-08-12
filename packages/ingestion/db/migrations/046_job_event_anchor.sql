-- 046: jobs anchor their evidence to the triggering event.
-- ON DELETE SET NULL lets retention remove old events without breaking job
-- history; workers fall back to sample_event_id for historical jobs.
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES error_events(id) ON DELETE SET NULL;

-- error_group_jobs is the live queue table, so build concurrently (044
-- precedent: the runner autocommits per statement, making CONCURRENTLY legal).
-- The DO block drops an invalid leftover from an interrupted build so
-- IF NOT EXISTS cannot silently keep a broken index.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_error_group_jobs_event'
      AND NOT i.indisvalid
  ) THEN
    DROP INDEX public.idx_error_group_jobs_event;
  END IF;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_error_group_jobs_event
  ON error_group_jobs(event_id) WHERE event_id IS NOT NULL;
