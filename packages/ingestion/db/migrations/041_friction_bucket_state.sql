-- 041_friction_bucket_state.sql — bucket evidence accumulation.
-- Append-only after 040. IDEMPOTENCY IS MANDATORY: the runner re-applies
-- every file on every start.
--
-- Before this migration, threshold counting read only 'pending' signals, so a
-- verdict permanently removed its own evidence and the bucket refilled from
-- zero. Counting all non-unchecked evidence instead needs two things: a
-- watermark, so an unchanged bucket is not re-judged on every session, and
-- membership, so a generation records exactly which signals it was shown.

CREATE TABLE IF NOT EXISTS friction_bucket_state (
  project_id         UUID NOT NULL REFERENCES projects(id),
  environment_id     UUID NOT NULL REFERENCES environments(id),
  fingerprint        TEXT NOT NULL,
  rule_version       INTEGER NOT NULL,
  -- Prompt version is part of the key: a new prompt must be able to re-judge
  -- a bucket that an older prompt already judged.
  prompt_version     INTEGER NOT NULL,
  -- Distinct identified users present the last time this bucket was judged.
  evaluated_users    INTEGER NOT NULL DEFAULT 0,
  -- Readers treat state older than the evidence window as absent, so a bucket
  -- whose evidence decayed cannot be frozen behind a stale high-water mark.
  evaluated_at       TIMESTAMPTZ,
  last_generation_id UUID REFERENCES friction_adjudication_generations(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment_id, fingerprint, rule_version, prompt_version)
);

-- Which signals a generation was actually shown. A signal may be evidence for
-- several generations; friction_signals.generation_id keeps pointing at the
-- generation that produced that signal's own verdict.
CREATE TABLE IF NOT EXISTS friction_generation_evidence (
  generation_id UUID NOT NULL REFERENCES friction_adjudication_generations(id) ON DELETE CASCADE,
  signal_id     UUID NOT NULL REFERENCES friction_signals(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (generation_id, signal_id)
);

-- signal_id leads: the ON DELETE CASCADE from friction_signals probes this
-- table per deleted signal row, and session retention deletes signals in bulk.
-- A project_id-leading index cannot serve that probe. Dropping the earlier
-- project-leading form matters because IF NOT EXISTS would otherwise keep the
-- old definition alive on any database that already applied this file.
DROP INDEX IF EXISTS idx_friction_generation_evidence_signal;
CREATE INDEX IF NOT EXISTS idx_friction_generation_evidence_by_signal
  ON friction_generation_evidence(signal_id, project_id);

-- Both release paths (budget-exhausted claims, non-terminal job failures)
-- DELETE from friction_adjudication_generations at runtime; the SET NULL
-- trigger and the FK integrity probe below each scan their referencing table
-- without these indexes.
CREATE INDEX IF NOT EXISTS idx_friction_bucket_state_last_generation
  ON friction_bucket_state(last_generation_id)
  WHERE last_generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_friction_signals_generation
  ON friction_signals(generation_id)
  WHERE generation_id IS NOT NULL;

-- Evidence counting reads active signals of one rule version regardless of
-- verdict status, which the pre-041 indexes do not serve. INCLUDE carries the
-- payload both the count and list queries need.
CREATE INDEX IF NOT EXISTS idx_friction_signals_bucket_evidence
  ON friction_signals(project_id, environment_id, fingerprint, rule_version, occurred_at)
  INCLUDE (end_user_id, occurrence_count, adjudication_status)
  WHERE retracted_at IS NULL AND superseded_by IS NULL AND end_user_id IS NOT NULL;
