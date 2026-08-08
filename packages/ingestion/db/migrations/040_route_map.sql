-- Code-grounded audience classification for normalized route patterns.
CREATE TABLE IF NOT EXISTS route_map (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pattern    TEXT NOT NULL,
  name       TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT '',
  tier       TEXT NOT NULL CHECK (tier IN ('customer','standard','admin')),
  source     TEXT NOT NULL DEFAULT 'llm',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, pattern)
);

-- At most one active route_map job per project (multi-replica enqueue race guard).
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_map_job_active
  ON error_group_jobs (project_id, job_type)
  WHERE job_type = 'route_map' AND status IN ('pending','claimed');
