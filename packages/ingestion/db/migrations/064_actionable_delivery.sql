-- 064_actionable_delivery.sql -- repeat actionable delivery and its audit ledger.
-- Additive and safe for old binaries, which ignore these columns and table.

-- Transactional: the runner applies files statement-by-statement, and the
-- DROP TRIGGER/CREATE TRIGGER pair must never leave a window with no
-- lifecycle trigger on a live database. Nothing here needs CONCURRENTLY.
BEGIN;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS actionable_since TIMESTAMPTZ;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION error_groups_actionable_lifecycle() RETURNS trigger AS $$
DECLARE
  was_actionable BOOLEAN := false;
  is_actionable BOOLEAN;
BEGIN
  -- OLD is unassigned for INSERT triggers.
  IF TG_OP = 'UPDATE' THEN
    was_actionable := OLD.status IN ('awaiting_approval', 'needs_human');
  END IF;
  is_actionable := NEW.status IN ('awaiting_approval', 'needs_human');

  IF is_actionable AND NOT was_actionable THEN
    NEW.actionable_since := now();
    NEW.snoozed_until := NULL;
  ELSIF is_actionable AND was_actionable THEN
    IF NEW.actionable_since IS NULL THEN
      NEW.actionable_since := COALESCE(OLD.actionable_since, now());
    END IF;
  ELSIF NOT is_actionable THEN
    NEW.actionable_since := NULL;
    NEW.snoozed_until := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS error_groups_actionable_lifecycle_ins ON error_groups;
CREATE TRIGGER error_groups_actionable_lifecycle_ins
  BEFORE INSERT ON error_groups
  FOR EACH ROW EXECUTE FUNCTION error_groups_actionable_lifecycle();

DROP TRIGGER IF EXISTS error_groups_actionable_lifecycle_upd ON error_groups;
CREATE TRIGGER error_groups_actionable_lifecycle_upd
  BEFORE UPDATE OF status, actionable_since, snoozed_until ON error_groups
  FOR EACH ROW EXECUTE FUNCTION error_groups_actionable_lifecycle();

-- Backfill the best available start of the current actionable period.
UPDATE error_groups
   SET actionable_since = CASE
         WHEN status = 'needs_human' THEN COALESCE(needs_human_at, updated_at)
         ELSE updated_at
       END
 WHERE status IN ('awaiting_approval', 'needs_human')
   AND actionable_since IS NULL;

-- Project scope is derived from digest_runs; duplicating it here would make
-- the audit ledger capable of storing an inconsistent project identifier.
CREATE TABLE IF NOT EXISTS digest_run_candidate_evaluations (
  digest_run_id       UUID NOT NULL REFERENCES digest_runs(id) ON DELETE CASCADE,
  error_group_id      UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  outcome             TEXT NOT NULL CHECK (outcome IN ('included', 'excluded')),
  primary_reason_code TEXT NOT NULL,
  details             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_run_id, error_group_id)
);

CREATE INDEX IF NOT EXISTS idx_drce_group
  ON digest_run_candidate_evaluations (error_group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_groups_actionable
  ON error_groups (project_id, actionable_since)
  WHERE status IN ('awaiting_approval', 'needs_human');

-- Repair for any pre-trigger drift: a row that left the actionable statuses
-- while no lifecycle trigger existed keeps stale stamps the stamping backfill
-- above cannot fix.
UPDATE error_groups
   SET actionable_since = NULL, snoozed_until = NULL
 WHERE status NOT IN ('awaiting_approval','needs_human')
   AND (actionable_since IS NOT NULL OR snoozed_until IS NOT NULL);

COMMIT;
