-- Typed per-session facts written solely by the worker analyzer.
-- Idempotent: migrations are re-run on every boot.

CREATE TABLE IF NOT EXISTS session_analysis (
  session_id          TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id          UUID NOT NULL,
  environment_id      UUID,
  session_started_at  TIMESTAMPTZ NOT NULL,
  coverage            TEXT NOT NULL CHECK (coverage IN ('complete','partial','no_replay')),
  activity_class      TEXT NOT NULL CHECK (activity_class IN
                        ('active','light_touch','zero_interaction','idle_tab','unknown')),
  entry_path          TEXT,
  click_count         INTEGER NOT NULL DEFAULT 0,
  input_event_count   INTEGER NOT NULL DEFAULT 0,
  page_event_count    INTEGER NOT NULL DEFAULT 0,
  failed_request_4xx_count          INTEGER NOT NULL DEFAULT 0,
  failed_request_5xx_count          INTEGER NOT NULL DEFAULT 0,
  unattributed_failed_request_count INTEGER NOT NULL DEFAULT 0,
  successful_write_count            INTEGER NOT NULL DEFAULT 0,
  failed_write_count                INTEGER NOT NULL DEFAULT 0,
  rule_version        INTEGER NOT NULL,
  analyzed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_analysis_rollup
  ON session_analysis (project_id, session_started_at);

ALTER TABLE friction_signals
  ADD COLUMN IF NOT EXISTS occurred_ats JSONB;

CREATE TABLE IF NOT EXISTS adjudication_call_budget (
  project_id UUID NOT NULL,
  day        DATE NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);
