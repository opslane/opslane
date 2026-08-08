-- Priority score v1 (spec: docs/superpowers/specs/2026-08-07-issue-prioritization-design.md).
-- Project-wide score recomputed by the priority sweeper; NULL means "never scored".
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS priority_score REAL;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS priority_scored_at TIMESTAMPTZ;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS priority_inputs JSONB;

-- The incidents feed orders by COALESCE(priority_score, 0) DESC before last_seen.
-- The expression must match ListErrorGroups' ORDER BY exactly or the planner
-- falls back to sorting every open group in the project on an endpoint every
-- dashboard tab polls; idx_error_groups_project_last_seen no longer serves it.
CREATE INDEX IF NOT EXISTS idx_error_groups_project_priority
  ON error_groups (project_id, (COALESCE(priority_score, 0)) DESC, last_seen DESC, id DESC);

-- Reach windows scan events per group by server arrival time.
CREATE INDEX IF NOT EXISTS idx_error_events_group_created
  ON error_events (error_group_id, created_at);

-- Friction reach: live accepted signals for a promoted incident, by arrival time.
CREATE INDEX IF NOT EXISTS idx_friction_signals_incident_reach
  ON friction_signals (incident_id, created_at)
  WHERE incident_id IS NOT NULL AND superseded_by IS NULL
    AND retracted_at IS NULL AND adjudication_status = 'accepted';
