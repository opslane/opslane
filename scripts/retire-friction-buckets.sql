-- Apply migration 074 and stop EVERY old worker before running this script.
-- Safe to rerun. Existing fixing/PR rows retain their lifecycle and history.
BEGIN;

WITH retired AS (
  UPDATE error_groups
     SET status_before_archive = status,
         status = 'archived', archived_at = now(), updated_at = now()
   WHERE kind = 'friction' AND ticket_id IS NULL
     AND status IN ('candidate','queued','analyzing','awaiting_approval',
                    'insight','needs_human','investigated')
  RETURNING id
), failed_jobs AS (
  UPDATE error_group_jobs
     SET status = 'failed', last_error = 'retired_friction_bucket',
         lease_expires_at = NULL, updated_at = now()
   WHERE error_group_id IN (SELECT id FROM retired)
     AND job_type IN ('investigate','fix') AND status IN ('pending','claimed')
  RETURNING id
)
-- This cache has no delivered_at. Delivered digest payloads are immutable and
-- stored separately; invalidating cached copy changes only future rendering.
UPDATE digest_card_copy
   SET invalidated_at = now()
 WHERE error_group_id IN (SELECT id FROM retired) AND invalidated_at IS NULL;

COMMIT;
