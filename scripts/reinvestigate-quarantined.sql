-- C1/W1.4: report-only re-investigation of quarantined incidents.
-- Idempotent over success; re-runnable to retry failed/dead-letter attempts.
--
-- The status reset below is load-bearing: quarantined incidents sit in
-- terminal-looking statuses ('insight', 'awaiting_approval'), and the worker's
-- crash-recovery adoption guard (processInvestigateJob) completes any
-- investigate job whose group is not in a claimable status without running an
-- investigation. Without the reset every job here terminates as a silent no-op
-- (observed on the 2026-08-11 prod-copy rehearsal, 8/8 jobs). root_cause is
-- deliberately left in place as forensic data (matching migration 045); the
-- re-investigation's own persistence overwrites or nulls it.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('reinvestigate-quarantined'));
WITH enqueued AS (
  INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
  SELECT r.incident_id, r.project_id, 'investigate', 'reinvestigate_report_only'
  FROM digest_readiness r
  JOIN error_groups g ON g.id = r.incident_id
  WHERE r.reason = 'quarantined_degenerate'
    -- Human-terminal incidents stay where the human put them: a quarantined
    -- readiness row alone must not drag a resolved/merged/archived incident
    -- back to 'queued'.
    AND g.status NOT IN ('resolved', 'merged', 'archived')
    AND NOT EXISTS (
      SELECT 1 FROM error_group_jobs j
      WHERE j.error_group_id = r.incident_id
        AND j.triggered_by = 'reinvestigate_report_only'
        AND j.status IN ('pending', 'claimed', 'completed')
    )
  RETURNING error_group_id
)
UPDATE error_groups g
SET status = 'queued',
    reason_code = NULL,
    reason_message = NULL,
    remediation = NULL,
    updated_at = now()
FROM enqueued e
WHERE g.id = e.error_group_id;
COMMIT;
