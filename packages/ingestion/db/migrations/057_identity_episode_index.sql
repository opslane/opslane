-- The filter sweep, evidence freezing, and replay all read observations by
-- (project_id, episode_id), but every existing index on error_event_identities
-- keys on event_id or canonical_issue_id. Without this, each per-episode facts
-- query scans the project's identity rows on every sweep tick.
CREATE INDEX IF NOT EXISTS idx_event_identities_episode
  ON error_event_identities (project_id, episode_id)
  WHERE episode_id IS NOT NULL;
