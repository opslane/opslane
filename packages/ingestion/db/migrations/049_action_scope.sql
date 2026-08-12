-- 049: per-project action scope. An enabled scope with an empty allowlist
-- fails closed: no environment may trigger automatic error investigation.
-- Session-analysis automation is outside the scope (see
-- docs/contracts/action-scope.md).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS action_scope_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_project_id_id
  ON environments(project_id, id);

CREATE TABLE IF NOT EXISTS project_action_environments (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment_id),
  FOREIGN KEY (project_id, environment_id)
    REFERENCES environments(project_id, id) ON DELETE CASCADE
);

-- The scope gate's activation/requeue check probes error_group_jobs by group
-- (EXISTS ... WHERE error_group_id = ... AND project_id = ...); no index on
-- error_group_id existed before, so give the hot ingest path a real one.
-- Concurrent build per the 044 precedent; the DO block clears an invalid
-- leftover from an interrupted build.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_error_group_jobs_group'
      AND NOT i.indisvalid
  ) THEN
    DROP INDEX public.idx_error_group_jobs_group;
  END IF;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_error_group_jobs_group
  ON error_group_jobs(error_group_id, project_id);
