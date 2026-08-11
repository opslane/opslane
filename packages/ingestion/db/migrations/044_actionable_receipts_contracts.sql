-- 044_actionable_receipts_contracts.sql (C0). No writers exist yet.
-- The runner has no ledger and autocommits per statement: each statement is
-- guarded so any prefix of this file can re-run safely, forever.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'diagnosis_decisions'::regclass
      AND conname = 'diagnosis_decisions_outcome_check'
      AND convalidated
      AND pg_get_constraintdef(oid) =
        'CHECK ((outcome = ANY (ARRAY[''code_fix''::text, ''not_actionable''::text, ''needs_more_context''::text, ''incomplete''::text])))'
  ) THEN
    ALTER TABLE diagnosis_decisions DROP CONSTRAINT IF EXISTS diagnosis_decisions_outcome_check;
    ALTER TABLE diagnosis_decisions ADD CONSTRAINT diagnosis_decisions_outcome_check
      CHECK (outcome IN ('code_fix','not_actionable','needs_more_context','incomplete'));
  END IF;
END $$;

ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS policy_eligible BOOLEAN;
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS policy_basis JSONB;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'error_group_jobs'::regclass
      AND conname = 'error_group_jobs_triggered_by_check'
      AND convalidated
      AND pg_get_constraintdef(oid) =
        'CHECK ((triggered_by = ANY (ARRAY[''auto''::text, ''human''::text, ''reinvestigate_report_only''::text])))'
  ) THEN
    ALTER TABLE error_group_jobs DROP CONSTRAINT IF EXISTS error_group_jobs_triggered_by_check;
    ALTER TABLE error_group_jobs ADD CONSTRAINT error_group_jobs_triggered_by_check
      CHECK (triggered_by IN ('auto','human','reinvestigate_report_only'));
  END IF;
END $$;

ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS terminal_fix_job_id UUID
  REFERENCES error_group_jobs(id) ON DELETE SET NULL;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS impact_class TEXT
  CHECK (impact_class IN ('blocked','degraded','invisible'));
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS impact_visits BIGINT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS impact_visits_recovered BIGINT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS impact_computed_at TIMESTAMPTZ;

-- Tenant integrity: composite FKs need composite unique targets. Concurrent
-- builds are legal because the migration runner autocommits each statement.
-- Recover invalid indexes left by an interrupted concurrent build before the
-- guarded CREATE statements inspect their names.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'ux_error_groups_id_project'
      AND NOT i.indisvalid
  ) THEN
    DROP INDEX public.ux_error_groups_id_project;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'ux_error_group_jobs_id_project'
      AND NOT i.indisvalid
  ) THEN
    DROP INDEX public.ux_error_group_jobs_id_project;
  END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_error_groups_id_project
  ON error_groups(id, project_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_error_group_jobs_id_project
  ON error_group_jobs(id, project_id);

CREATE TABLE IF NOT EXISTS digest_readiness (
  incident_id UUID PRIMARY KEY,
  project_id  UUID NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('eligible','ineligible','pending')),
  reason      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, project_id)
    REFERENCES error_groups(id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_digest_readiness_project
  ON digest_readiness(project_id, status);

CREATE TABLE IF NOT EXISTS fix_run_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  run_id        UUID NOT NULL,
  entry_seq     INT NOT NULL,
  command       TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  workdir_dirty BOOLEAN NOT NULL,
  discovered    INT,
  passed        INT,
  failed        INT,
  skipped       INT,
  truncated     BOOLEAN NOT NULL DEFAULT false,
  timed_out     BOOLEAN NOT NULL DEFAULT false,
  not_run       JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(not_run) = 'array'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, entry_seq),
  FOREIGN KEY (job_id, project_id)
    REFERENCES error_group_jobs(id, project_id) ON DELETE RESTRICT
);
-- RESTRICT, not CASCADE: the ledger is the audit record of what verification
-- executed; a tenant-delete flow must remove ledger rows explicitly.
CREATE INDEX IF NOT EXISTS idx_fix_run_ledger_job
  ON fix_run_ledger(job_id, created_at);
