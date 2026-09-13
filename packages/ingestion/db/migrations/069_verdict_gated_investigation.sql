-- 069_verdict_gated_investigation.sql
BEGIN;
-- The runner replays every file on every boot with no ledger and no global
-- lock; concurrent ingestion boots must not double-insert backfill jobs.
SELECT pg_advisory_xact_lock(hashtext('069_verdict_gated_investigation'));
-- Decision 2026-09-01: every promoted friction incident is investigated.
-- Backfill: incidents the old severity gate parked as awaiting_approval
-- WITHOUT ever being investigated (no root cause, no diff) go back to the
-- queue with one investigation job. Idempotent under the replay-every-boot
-- runner: once investigated, root_cause is set and the predicate is false;
-- while still queued, the re-run is a no-op UPDATE and the job guard holds.
UPDATE error_groups
SET status = 'queued', updated_at = now()
WHERE kind = 'friction' AND status = 'awaiting_approval'
  AND root_cause IS NULL
  AND NULLIF(btrim(COALESCE(candidate_diff, '')), '') IS NULL;

INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status, triggered_by)
SELECT eg.id, eg.project_id, 'investigate', 'pending', 'auto'
FROM error_groups eg
WHERE eg.kind = 'friction' AND eg.status = 'queued'
  AND eg.root_cause IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM error_group_jobs j
    WHERE j.error_group_id = eg.id AND j.project_id = eg.project_id
      AND j.job_type = 'investigate'
      AND j.status IN ('pending','claimed','completed'));

-- Task 3's storage: reason for a non-ok frames-verification terminal.
-- (Migration 068's CHECK constrains `verification` non-null ONLY for state
-- 'ok', so the reason needs its own column.)
ALTER TABLE session_narratives ADD COLUMN IF NOT EXISTS verification_reason TEXT;
COMMIT;
