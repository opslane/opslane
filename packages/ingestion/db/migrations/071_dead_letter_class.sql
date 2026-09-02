-- 071_dead_letter_class.sql
BEGIN;
-- Replayed on every ingestion boot with no ledger; every statement below is
-- idempotent and the lock keeps concurrent boots from racing the backfill.
SELECT pg_advisory_xact_lock(hashtext('071_dead_letter_class'));

-- Why a job dead-lettered decides when the worker re-runs it: limit, agent,
-- and config after the next deploy; transient on a 1h/4h/16h backoff.
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS dead_letter_class TEXT;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS requeues INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMPTZ;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'error_group_jobs_dead_letter_class_check'
  ) THEN
    ALTER TABLE error_group_jobs ADD CONSTRAINT error_group_jobs_dead_letter_class_check
      CHECK (
        dead_letter_class IS NULL
        OR dead_letter_class IN ('limit', 'agent', 'config', 'transient')
      );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_error_group_jobs_dead_letter_requeue
  ON error_group_jobs (dead_letter_class, requeues, dead_lettered_at)
  WHERE status = 'dead_letter';

-- An abandoned investigation is a system failure, not a needs_human card.
-- Repair the incidents the old reconciler stranded and hand their existing
-- job rows to the worker's deploy-triggered requeue policy. needs_human_at is
-- deliberately retained for audit.
WITH stranded AS (
  SELECT g.id AS group_id, g.project_id, j.id AS job_id
    FROM error_groups g
    JOIN error_group_jobs j
      ON j.id = g.terminal_fix_job_id
     AND j.project_id = g.project_id
   WHERE g.status = 'needs_human'
     AND g.reason_code = 'worker_runtime_error'
     AND j.job_type = 'investigate'
     AND j.status = 'dead_letter'
     AND j.dead_letter_class IS NULL
), groups AS (
  UPDATE error_groups g
     SET status = 'analyzing',
         reason_code = NULL,
         reason_message = NULL,
         remediation = NULL,
         terminal_fix_job_id = NULL,
         updated_at = now()
    FROM stranded s
   WHERE g.id = s.group_id AND g.project_id = s.project_id
  RETURNING s.job_id
)
UPDATE error_group_jobs j
   SET dead_letter_class = 'config',
       requeues = 0,
       dead_lettered_at = COALESCE(j.dead_lettered_at, j.updated_at)
  FROM groups
 WHERE j.id = groups.job_id;

COMMIT;
