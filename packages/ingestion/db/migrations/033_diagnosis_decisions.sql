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

CREATE UNIQUE INDEX IF NOT EXISTS uq_diagnosis_decisions_job
  ON diagnosis_decisions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_diagnosis_decisions_group
  ON diagnosis_decisions(error_group_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnosis_decisions_project
  ON diagnosis_decisions(project_id, decided_at DESC);
