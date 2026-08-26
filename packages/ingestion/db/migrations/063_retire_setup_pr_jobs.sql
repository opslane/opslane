-- Onboarding v2 retired the setup_pr job type. Settle rows the retired path
-- would otherwise strand: pending rows and claimed rows whose lease expired.
-- An actively leased row is left alone because an old worker may still be
-- performing GitHub side effects; it can finish or age out safely.
UPDATE error_group_jobs
   SET status = 'dead_letter',
       last_error = COALESCE(last_error, 'setup_pr retired by onboarding v2')
 WHERE job_type = 'setup_pr'
   AND (status = 'pending'
        OR (status = 'claimed' AND lease_expires_at < now()));
