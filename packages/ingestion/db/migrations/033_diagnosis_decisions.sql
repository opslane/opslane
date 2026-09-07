-- 033_diagnosis_decisions.sql, the append-only record of what Opslane concluded.
-- Status on error_groups is mutable; measurements need the decision made at
-- the time of an investigation, even after archive, unarchive, or correction.
CREATE TABLE IF NOT EXISTS diagnosis_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_group_id  UUID NOT NULL REFERENCES error_groups(id),
  project_id      UUID NOT NULL REFERENCES projects(id),
  job_id          UUID REFERENCES error_group_jobs(id),
  outcome         TEXT NOT NULL CHECK (outcome IN ('code_fix', 'not_actionable', 'needs_more_context')),
  decision_reason TEXT NOT NULL,
  cause_location  TEXT,
  diagnosis       JSONB,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create-if-not-superseded, per 072's precedent: 037 retires this index in
-- favor of one decision row per attempt, and the boot replay runs this file
-- again on every deploy. Once a retried job has written its second decision —
-- exactly what 037 legalizes — an unguarded CREATE UNIQUE INDEX can never
-- succeed again, and the replay (and with it every deploy) fails here. 037
-- leaves idx_diagnosis_decisions_job behind as its marker: when that index
-- exists, the unique index must stay retired and the replay is a no-op. A
-- fresh database carries neither index at this point, so it still gets 033's
-- version first and 037 retires it moments later in the same run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'idx_diagnosis_decisions_job'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_diagnosis_decisions_job
      ON diagnosis_decisions(job_id) WHERE job_id IS NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_diagnosis_decisions_group
  ON diagnosis_decisions(error_group_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnosis_decisions_project
  ON diagnosis_decisions(project_id, decided_at DESC);
