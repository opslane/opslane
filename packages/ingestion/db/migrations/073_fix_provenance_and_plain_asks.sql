-- 073_fix_provenance_and_plain_asks.sql -- scope the fix-provenance lookup, and
-- collapse the two jargon asks into one plain sentence.
--
-- 072 introduced error_groups_fix_attempted(terminal_fix_job_id, project_id).
-- Inside the body, `project_id` resolves to error_group_jobs.project_id rather
-- than to the argument, so the predicate reads `j.project_id = j.project_id`
-- and is true for every row. The function therefore reported a fix attempt
-- whenever ANY project owned a fix job with that id, and the tenant scope the
-- argument exists to enforce never applied.
--
-- The parameter names are kept exactly as 072 declared them: CREATE OR REPLACE
-- cannot rename a function's parameters, and 072 is already applied in
-- volume-backed databases. The body uses $1 and $2 instead, which name the
-- arguments positionally and cannot be captured by a column of the same name.
--
-- Transactional for the same reason 072 is: nothing may observe a window where
-- the lookup has changed and the trigger bodies that call it have not.
BEGIN;

CREATE OR REPLACE FUNCTION error_groups_fix_attempted(
  terminal_fix_job_id UUID, project_id UUID
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM error_group_jobs j
     WHERE j.id = $1
       AND j.project_id = $2
       AND j.job_type IN ('fix','error_fix')
  );
$$ LANGUAGE sql STABLE;

-- The digest asks for one of three things now. "Review the investigation." and
-- "Review the diagnosis." both named internal machinery, and they split a
-- distinction the reader cannot act on differently: either way the next move is
-- theirs and the issue page holds whatever the system found. Both collapse into
-- "Decide how to handle this.", so whether a fix ran no longer changes the ask.
-- digest.digestAction is the Go twin; change both together.
--
-- The signature and parameter names are 072's, because 064's triggers call this
-- function by name and CREATE OR REPLACE cannot rename parameters. fix_attempted
-- is still accepted and still ignored on purpose: the column it comes from is
-- watched by the lifecycle trigger for other reasons.
--
-- No backfill. Rows that sat in one of the merged classes keep the
-- actionable_since they already have. Their age is older than a reset would
-- make it, which only strengthens the oldest-waiter guarantee, and rewriting
-- every waiting incident's age to make a wording change would restart the
-- clock on incidents nobody's ask actually changed for.
CREATE OR REPLACE FUNCTION error_groups_action_class(
  status TEXT, candidate_diff TEXT, pr_url TEXT, fix_attempted BOOLEAN
) RETURNS TEXT AS $$
BEGIN
  CASE status
    WHEN 'awaiting_approval' THEN
      IF NULLIF(btrim(COALESCE(candidate_diff,'')),'') IS NOT NULL THEN
        RETURN 'Approve the proposed fix.';
      END IF;
      RETURN 'Decide how to handle this.';
    WHEN 'pr_created', 'pr_draft' THEN
      IF NULLIF(btrim(COALESCE(pr_url,'')),'') IS NOT NULL THEN
        RETURN 'Review the fix PR.';
      END IF;
      -- Inconsistent state: the digest still renders it and logs a diagnostic.
      RETURN 'Review the issue.';
    WHEN 'needs_human' THEN
      RETURN 'Decide how to handle this.';
    ELSE
      RETURN NULL;
  END CASE;
END $$ LANGUAGE plpgsql IMMUTABLE;

COMMIT;
