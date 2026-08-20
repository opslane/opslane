-- The commit an investigation or fix run actually inspected was only persisted
-- inside the diagnosis JSON, which is null whenever the run fails before the
-- model answers — exactly the runs whose checkout needs auditing. Record it on
-- the job row instead, written right after checkout under the job lease, so a
-- frozen-commit checkout or its default-head fallback is observable even when
-- the run later fails. Overwritten by each reclaimed attempt: the column holds
-- the latest successful checkout, not per-attempt history.
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS investigated_commit text;
