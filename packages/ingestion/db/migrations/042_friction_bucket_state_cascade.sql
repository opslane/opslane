-- 042_friction_bucket_state_cascade.sql — tenant deletion cleans up derived
-- friction state instead of being blocked by it.
-- Append-only after 041. IDEMPOTENCY IS MANDATORY: run-migrations.sh
-- re-applies every file on every start, so each constraint is dropped before
-- it is re-added.
--
-- 041 gave both tables plain REFERENCES, matching the dominant convention for
-- projects and environments elsewhere in this schema. That convention is right
-- for records a delete should refuse to silently discard — friction_signals,
-- error_groups, the adjudication generations. It is wrong for these two.
--
-- friction_bucket_state is a re-adjudication watermark and
-- friction_generation_evidence is a record of which signals one model call was
-- shown. Both are derived state: worthless once their project or environment
-- is gone, and reconstructible from the signals if they ever were not. Blocking
-- a tenant delete on them buys nothing and costs a foreign-key error, which is
-- exactly what the keyless E2E smoke hit on friction_bucket_state_environment_id_fkey.
--
-- Deliberately unchanged: friction_adjudication_generations still references
-- projects and environments without a cascade. A generation is an audit record
-- of a paid model call and a verdict, so a delete that would destroy one should
-- fail loudly rather than cascade. Callers that legitimately tear a tenant down
-- delete generations explicitly first.

ALTER TABLE friction_bucket_state
  DROP CONSTRAINT IF EXISTS friction_bucket_state_project_id_fkey;
ALTER TABLE friction_bucket_state
  ADD CONSTRAINT friction_bucket_state_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE friction_bucket_state
  DROP CONSTRAINT IF EXISTS friction_bucket_state_environment_id_fkey;
ALTER TABLE friction_bucket_state
  ADD CONSTRAINT friction_bucket_state_environment_id_fkey
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE;

ALTER TABLE friction_generation_evidence
  DROP CONSTRAINT IF EXISTS friction_generation_evidence_project_id_fkey;
ALTER TABLE friction_generation_evidence
  ADD CONSTRAINT friction_generation_evidence_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
