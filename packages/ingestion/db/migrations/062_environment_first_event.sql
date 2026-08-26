-- Track when an environment first received an SDK event. NULL means "never".
-- The ingest path claims this once per environment to drive the
-- sdk_first_event_received usage event.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS first_event_at TIMESTAMPTZ;

-- Backfill from durable group evidence rather than retention-limited raw
-- events. Replaying the migration is safe and converges on the earliest known
-- evidence across both group types.
UPDATE environments e
SET first_event_at = evidence.earliest
FROM (
  SELECT ege.environment_id, MIN(g.created_at) AS earliest
  FROM error_group_environments ege
  JOIN error_groups g ON g.id = ege.error_group_id
  GROUP BY ege.environment_id
) AS evidence
WHERE e.id = evidence.environment_id
  AND e.first_event_at IS NULL;

UPDATE environments e
SET first_event_at = fg.earliest
FROM (
  SELECT environment_id, MIN(first_seen_at) AS earliest
  FROM friction_groups
  GROUP BY environment_id
) AS fg
WHERE e.id = fg.environment_id
  AND (e.first_event_at IS NULL OR fg.earliest < e.first_event_at);
