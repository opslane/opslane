-- Agent-reported progress for the live approve-page checklist. Server facts
-- (first event, GitHub, Slack, source maps) decide completion; this table
-- only holds what the agent says, including failure notes for those steps.
CREATE TABLE IF NOT EXISTS agent_session_steps (
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  step       TEXT NOT NULL CHECK (step IN ('install_sdk','first_event','github','slack','sourcemaps','mcp')),
  status     TEXT NOT NULL CHECK (status IN ('pending','running','done','skipped','failed')),
  note       TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, step)
);
