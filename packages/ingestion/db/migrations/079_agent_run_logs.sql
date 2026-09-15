-- Agent run logs: one started row before a run's first model request and one
-- finished row after it. Payloads (input bundle, transcript) live in object
-- storage under object_prefix; these rows are the index. Insert-only except
-- DELETE, which retention needs. See
-- docs/superpowers/specs/2026-09-15-agent-run-logs-design.md.

CREATE TABLE IF NOT EXISTS agent_run_started (
  run_id           UUID PRIMARY KEY,
  job_id           UUID NOT NULL,
  job_type         TEXT NOT NULL CHECK (job_type <> ''),
  project_id       UUID NOT NULL,
  phase            TEXT NOT NULL CHECK (phase <> ''),
  entry_point      TEXT NOT NULL CHECK (entry_point <> ''),
  attempts         INTEGER NOT NULL CHECK (attempts >= 0),
  lease_generation BIGINT NOT NULL,
  error_group_id   UUID,
  ticket_id        UUID,
  episode_id       UUID,
  batch_id         UUID,
  session_id       TEXT,
  commit_sha       TEXT,
  object_prefix    TEXT NOT NULL CHECK (object_prefix LIKE 'agent-runs/%/'),
  models           TEXT[] NOT NULL DEFAULT '{}',
  worker_build_sha TEXT NOT NULL CHECK (worker_build_sha <> ''),
  bundle_written   BOOLEAN NOT NULL,
  bundle_bytes     INTEGER NOT NULL CHECK (bundle_bytes >= 0),
  recorded_at      TIMESTAMPTZ NOT NULL
);

-- Retention deletes by project and day; analysis joins by job.
CREATE INDEX IF NOT EXISTS idx_agent_run_started_project_recorded
  ON agent_run_started (project_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_agent_run_started_job ON agent_run_started (job_id);

CREATE TABLE IF NOT EXISTS agent_run_finished (
  run_id             UUID PRIMARY KEY REFERENCES agent_run_started(run_id) ON DELETE CASCADE,
  stop               TEXT NOT NULL CHECK (stop IN (
                       'completed', 'terminal_tool', 'invalid_output', 'turns_exhausted', 'budget', 'truncated',
                       'no_tool_call', 'no_evidence', 'api_error', 'machine_lost', 'aborted', 'threw')),
  error_class        TEXT,
  error_detail       TEXT CHECK (error_detail IS NULL OR length(error_detail) <= 500),
  model_requests     INTEGER NOT NULL CHECK (model_requests >= 0),
  turns              INTEGER NOT NULL CHECK (turns >= 0),
  usage              JSONB NOT NULL,
  cost_usd           NUMERIC(12, 6) NOT NULL CHECK (cost_usd >= 0),
  transcript_written BOOLEAN NOT NULL,
  transcript_bytes   INTEGER NOT NULL CHECK (transcript_bytes >= 0),
  finished_at        TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION reject_agent_run_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '2F004';
END;
$$ LANGUAGE plpgsql;

-- One transaction per swap: run-migrations.sh replays every file on every
-- boot with autocommit, so a bare DROP-then-CREATE would leave a window with
-- no trigger (same idiom as 043, minus DELETE).
BEGIN;
DROP TRIGGER IF EXISTS agent_run_started_no_update ON agent_run_started;
CREATE TRIGGER agent_run_started_no_update
  BEFORE UPDATE ON agent_run_started
  FOR EACH ROW EXECUTE FUNCTION reject_agent_run_update();
COMMIT;

BEGIN;
DROP TRIGGER IF EXISTS agent_run_started_no_truncate ON agent_run_started;
CREATE TRIGGER agent_run_started_no_truncate
  BEFORE TRUNCATE ON agent_run_started
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_run_update();
COMMIT;

BEGIN;
DROP TRIGGER IF EXISTS agent_run_finished_no_update ON agent_run_finished;
CREATE TRIGGER agent_run_finished_no_update
  BEFORE UPDATE ON agent_run_finished
  FOR EACH ROW EXECUTE FUNCTION reject_agent_run_update();
COMMIT;

BEGIN;
DROP TRIGGER IF EXISTS agent_run_finished_no_truncate ON agent_run_finished;
CREATE TRIGGER agent_run_finished_no_truncate
  BEFORE TRUNCATE ON agent_run_finished
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_run_update();
COMMIT;

-- A started row with no finished row is 'running' while its job still holds
-- the recorded lease (claimed, same generation, not expired), and 'unfinished'
-- after: the process died or the finished insert failed.
CREATE OR REPLACE VIEW agent_runs_v AS
SELECT s.run_id, s.job_id, s.job_type, s.project_id, s.phase, s.entry_point, s.attempts, s.lease_generation,
       s.error_group_id, s.ticket_id, s.episode_id, s.batch_id, s.session_id, s.commit_sha, s.object_prefix,
       s.models, s.worker_build_sha, s.bundle_written, s.bundle_bytes, s.recorded_at,
       CASE
         WHEN f.run_id IS NOT NULL THEN f.stop
         WHEN j.status = 'claimed' AND j.lease_generation = s.lease_generation AND j.lease_expires_at > now() THEN 'running'
         ELSE 'unfinished'
       END AS stop,
       f.error_class, f.error_detail, f.model_requests, f.turns, f.usage, f.cost_usd,
       f.transcript_written, f.transcript_bytes, f.finished_at
  FROM agent_run_started s
  LEFT JOIN agent_run_finished f ON f.run_id = s.run_id
  LEFT JOIN error_group_jobs j ON j.id = s.job_id;
