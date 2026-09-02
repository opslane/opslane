-- 073_fix_provenance_scope.sql -- the fix-provenance lookup reads its own arguments.
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

COMMIT;
