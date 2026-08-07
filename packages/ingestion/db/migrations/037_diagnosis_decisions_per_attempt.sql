-- Two corrections to the diagnosis_decisions schema, found in review.

-- 1. A retried investigation could never record what it concluded.
--
-- requeueStaleJobs updates error_group_jobs in place (`SET attempts = attempts + 1`),
-- so a retried job keeps its id. Combined with `uq_diagnosis_decisions_job` and
-- the `ON CONFLICT (job_id) DO NOTHING` in insertDiagnosisDecision, the second
-- attempt's decision was silently dropped.
--
-- The failure that makes this worth a migration: attempt 1 concludes
-- not_actionable and the row is written. The lease is lost and the job requeues.
-- Attempt 2 concludes code_fix at high confidence and creates a fix job — but
-- the fix job's authorization gate loads the newest decision, which is still
-- attempt 1's not_actionable, and refuses. Migration 034 made the table
-- insert-only, so there was no operational way out of it either.
--
-- The table is documented as an append-only record, and one row per attempt is
-- what that means. loadDiagnosisDecision already reads the newest
-- (ORDER BY decided_at DESC, id DESC), so appending is enough; nothing needs to
-- find "the" decision for a job. Dropping the constraint is therefore the whole
-- fix, and it restores the forensic history the unique index was discarding.
--
-- Duplicate rows for a single attempt are not a risk this index was buying:
-- every insert runs inside the same transaction as the status update it
-- accompanies, so a partial replay cannot commit one without the other.
DROP INDEX IF EXISTS uq_diagnosis_decisions_job;

-- Keep a non-unique index so lookups by job stay cheap.
CREATE INDEX IF NOT EXISTS idx_diagnosis_decisions_job
  ON diagnosis_decisions(job_id) WHERE job_id IS NOT NULL;

-- 2. Drop the column left behind by a migration that was removed before release.
--
-- 032_diagnosis_fix_surface.sql added projects.fix_surface_globs for a "fix
-- surface" concept that this branch removed, and the migration file was deleted
-- rather than superseded. Deleting the file is safe for a fresh database and for
-- main, which never saw it — but any development or CI database that ran the
-- intermediate commit keeps the column forever, since no migration drops it.
-- That leaves those databases permanently different from a fresh one in a way
-- the fresh-database migration test cannot detect.
--
-- Nothing reads this column: `fix_surface` appears nowhere in the Go, TypeScript,
-- SQL, or Vue sources.
ALTER TABLE projects DROP COLUMN IF EXISTS fix_surface_globs;
