-- Narrative detection layer: per-session LLM narratives replace mechanical
-- friction detectors. See docs/design/2026-08-31-session-narratives.md.

CREATE TABLE IF NOT EXISTS session_narratives (
  session_id      text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id),
  environment_id  uuid NOT NULL REFERENCES environments(id),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','narrating','ok','skipped_cap','skipped_budget','parse_failed','render_aborted','failed')),
  narrative       jsonb,
  timeline        jsonb,
  raw_response    text,
  prompt_version  integer NOT NULL,
  model           text,
  input_tokens    integer,
  output_tokens   integer,
  budget_reserved_on        date,
  verify_budget_reserved_on date,
  verification_state text NOT NULL DEFAULT 'none'
                  CHECK (verification_state IN ('none','pending','verifying','ok','failed','unsupported','skipped_budget')),
  verification    jsonb,
  verification_prompt_version integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT narrative_iff_ok CHECK ((status = 'ok') = (narrative IS NOT NULL)),
  CONSTRAINT raw_only_parse_failed CHECK (raw_response IS NULL OR status = 'parse_failed'),
  CONSTRAINT verification_iff_ok CHECK ((verification_state = 'ok') = (verification IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_session_narratives_project_status
  ON session_narratives (project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS narrative_call_budget (
  project_id uuid NOT NULL REFERENCES projects(id),
  day        date NOT NULL,
  stage      text NOT NULL CHECK (stage IN ('narrate','verify')),
  used       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, stage)
);

ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS observation_text TEXT;

ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS severity TEXT
  CHECK (severity IN ('low','medium','high'));

ALTER TABLE friction_signals DROP CONSTRAINT IF EXISTS friction_signals_signal_type_check;
ALTER TABLE friction_signals ADD CONSTRAINT friction_signals_signal_type_check
  CHECK (signal_type IN (
    'rage_click','dead_click','form_abandon',
    'unclickable_affordance','no_feedback_after_action','dead_end_state',
    'validation_confusion','slow_response','repetitive_workflow',
    'discoverability_gap','hard_blocker','other'
  ));
