-- 059_daily_digest_pipeline.sql -- immutable facts for the model-authored digest.

ALTER TABLE digest_run_items
  ADD COLUMN IF NOT EXISTS candidate_snapshot JSONB;

ALTER TABLE digest_runs
  ADD COLUMN IF NOT EXISTS writer_payload JSONB;
ALTER TABLE digest_runs
  ADD COLUMN IF NOT EXISTS rendered_payload JSONB;

CREATE INDEX IF NOT EXISTS idx_digest_runs_resume
  ON digest_runs (project_id, run_date, status);
