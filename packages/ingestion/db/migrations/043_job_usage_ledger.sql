-- The worker computes token usage and cost per phase of every job but only
-- emitted them as Langfuse span attributes; Langfuse is optional, so spend
-- was unjoinable to outcomes. job_usage is the insert-only ledger of that
-- spend: one row per (job, execution, phase, model). Best-effort writes;
-- see docs/adr/0001-postgres-usage-ledger.md.

CREATE TABLE IF NOT EXISTS job_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES error_group_jobs(id),
  execution INTEGER NOT NULL CHECK (execution >= 0),
  phase TEXT NOT NULL CHECK (phase <> ''),
  model TEXT NOT NULL CHECK (model <> ''),
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens BIGINT NOT NULL CHECK (cache_write_tokens >= 0),
  cost_usd NUMERIC(12, 4) NOT NULL CHECK (cost_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, execution, phase, model)
);

-- The 7d spend aggregate scans by time.
CREATE INDEX IF NOT EXISTS idx_job_usage_created_at ON job_usage (created_at);

-- Insert-only, database-enforced. A ledger row records what a run spent at
-- the time; mutating it would rewrite history for spend that already happened.
CREATE OR REPLACE FUNCTION reject_job_usage_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'job_usage is insert-only: % rejected', TG_OP
    USING ERRCODE = '2F004';
END;
$$ LANGUAGE plpgsql;

-- One transaction per swap. run-migrations.sh invokes `psql -f`, which
-- autocommits each statement, and the compose migrate service re-runs every
-- file on every boot -- so a bare DROP-then-CREATE would leave a window on
-- each boot where the table this migration exists to protect was fully
-- mutable. Same idiom as 034_diagnosis_decisions_immutable.sql.
BEGIN;
DROP TRIGGER IF EXISTS job_usage_immutable_row ON job_usage;
CREATE TRIGGER job_usage_immutable_row
  BEFORE UPDATE OR DELETE ON job_usage
  FOR EACH ROW EXECUTE FUNCTION reject_job_usage_mutation();
COMMIT;

-- TRUNCATE does not fire row-level triggers, so it needs a statement trigger.
BEGIN;
DROP TRIGGER IF EXISTS job_usage_immutable_truncate ON job_usage;
CREATE TRIGGER job_usage_immutable_truncate
  BEFORE TRUNCATE ON job_usage
  FOR EACH STATEMENT EXECUTE FUNCTION reject_job_usage_mutation();
COMMIT;

-- Retention contract: job_usage rows are permanent. The FK above (no ON
-- DELETE) plus the triggers mean a job that acquired usage cannot be deleted
-- without operator intervention; even ON DELETE CASCADE would be blocked by
-- the row trigger. See ADR-0001.

-- The investigate job that created a fix job. Nullable: pre-existing rows and
-- non-fix jobs have none. Unbackfillable, which is why it lands with the
-- ledger rather than later (ADR-0001, "Attribution boundary").
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS source_job_id UUID REFERENCES error_group_jobs(id);

-- Postgres does not index FK columns automatically; without this, any DELETE
-- on error_group_jobs seq-scans the queue table per row for the self-FK
-- check, and attribution joins do the same. Partial: most jobs have no source.
CREATE INDEX IF NOT EXISTS idx_error_group_jobs_source_job_id
  ON error_group_jobs (source_job_id) WHERE source_job_id IS NOT NULL;
