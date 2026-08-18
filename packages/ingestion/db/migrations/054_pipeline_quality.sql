-- 054_pipeline_quality.sql -- asynchronous identity, filtering, inquiry, and publication.
-- Inert until the runtime paths land. IDEMPOTENCY IS MANDATORY.

CREATE TABLE IF NOT EXISTS error_capture_buckets (
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raw_fingerprint  TEXT NOT NULL,
  identity_version INTEGER NOT NULL,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, identity_version, raw_fingerprint)
);

CREATE TABLE IF NOT EXISTS error_event_resolutions (
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id         UUID NOT NULL REFERENCES error_events(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('resolved','no_map','failed','pending')),
  envelope         JSONB,
  resolver_version INTEGER NOT NULL,
  resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, event_id)
);

CREATE TABLE IF NOT EXISTS sourcemap_position_cache (
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  debug_id          TEXT NOT NULL,
  map_content_sha   TEXT NOT NULL,
  resolver_version  INTEGER NOT NULL,
  generated_line    INTEGER NOT NULL,
  generated_column  INTEGER NOT NULL,
  original_file     TEXT,
  original_function TEXT,
  original_line     INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, debug_id, map_content_sha, resolver_version,
               generated_line, generated_column)
);

CREATE TABLE IF NOT EXISTS issue_episodes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_issue_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  sequence           INTEGER NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ,
  UNIQUE (project_id, canonical_issue_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_episode
  ON issue_episodes (canonical_issue_id) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS error_event_identities (
  project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id             UUID NOT NULL REFERENCES error_events(id) ON DELETE CASCADE,
  -- 'settling' is the claim marker. A crash leaves it here, which is why the
  -- later identity loop includes a reset sweep.
  status               TEXT NOT NULL CHECK (status IN ('pending','settling','settled','conflict')),
  claimed_at           TIMESTAMPTZ,
  canonical_issue_id   UUID REFERENCES error_groups(id) ON DELETE SET NULL,
  raw_fingerprint      TEXT NOT NULL,
  resolved_fingerprint TEXT,
  identity_version     INTEGER NOT NULL,
  episode_id           UUID REFERENCES issue_episodes(id) ON DELETE SET NULL,
  settled_at           TIMESTAMPTZ,
  PRIMARY KEY (project_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_pending
  ON error_event_identities (project_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_identities_settling
  ON error_event_identities (claimed_at) WHERE status = 'settling';

CREATE TABLE IF NOT EXISTS canonical_issue_fingerprints (
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint        TEXT NOT NULL,
  fingerprint_kind   TEXT NOT NULL CHECK (fingerprint_kind IN ('raw','resolved','friction')),
  canonical_issue_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  identity_version   INTEGER NOT NULL,
  confirmed_by       TEXT NOT NULL CHECK (confirmed_by IN ('exact','model','human')),
  bound_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, identity_version, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_alias_by_issue
  ON canonical_issue_fingerprints (canonical_issue_id);

CREATE TABLE IF NOT EXISTS issue_merges (
  id            BIGSERIAL PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  winner_id     UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  loser_id      UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  confirmed_by  TEXT NOT NULL CHECK (confirmed_by IN ('model','human')),
  actor         TEXT,
  aliases_moved INTEGER NOT NULL,
  events_moved  INTEGER NOT NULL,
  merged_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (winner_id <> loser_id),
  UNIQUE (project_id, loser_id)
);

CREATE TABLE IF NOT EXISTS issue_alias_conflicts (
  id             BIGSERIAL PRIMARY KEY,
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id       UUID NOT NULL REFERENCES error_events(id) ON DELETE CASCADE,
  left_issue_id  UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  right_issue_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','resolved','dismissed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (left_issue_id < right_issue_id),
  UNIQUE (project_id, event_id, left_issue_id, right_issue_id)
);
CREATE INDEX IF NOT EXISTS idx_conflicts_open
  ON issue_alias_conflicts (project_id, status) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS issue_decisions (
  id           BIGSERIAL PRIMARY KEY,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id   UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  decision     TEXT NOT NULL CHECK (decision IN ('open_inquiry','watch','inactive')),
  reason       TEXT NOT NULL,
  users_7d     INTEGER NOT NULL,
  anon_7d      INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decisions_latest
  ON issue_decisions (project_id, episode_id, decided_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS issue_inquiry_decisions (
  id                 BIGSERIAL PRIMARY KEY,
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id         UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  decision           TEXT NOT NULL CHECK (decision IN ('investigate','wait_for_more_evidence','do_not_pursue')),
  reason             TEXT NOT NULL,
  brief              TEXT,
  related_issues     UUID[] NOT NULL DEFAULT '{}',
  evaluated_units    INTEGER NOT NULL,
  evidence_signature TEXT NOT NULL,
  -- The route/action understanding version this review read; NULL means no
  -- product understanding existed yet for the issue's surface.
  product_understanding_version INTEGER,
  model              TEXT NOT NULL,
  prompt_version     INTEGER NOT NULL,
  decided_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inquiry_latest
  ON issue_inquiry_decisions (project_id, episode_id, decided_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS issue_evidence_anchors (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id  UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('threshold','first','recent')),
  event_id    UUID NOT NULL REFERENCES error_events(id) ON DELETE CASCADE,
  frozen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, episode_id, anchor_kind)
);

CREATE TABLE IF NOT EXISTS issue_publications (
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id   UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL CHECK (channel IN ('immediate','post_triage','digest')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, episode_id, channel)
);

CREATE TABLE IF NOT EXISTS digest_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  window_from TIMESTAMPTZ NOT NULL,
  window_to   TIMESTAMPTZ NOT NULL,
  -- The project-local calendar date of the daily boundary. No default: the
  -- freezer must stamp it explicitly, because the server's clock date and the
  -- project's local date disagree across the UTC boundary.
  run_date    DATE NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('frozen','written','validated','delivered','failed')),
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_run_per_window
  ON digest_runs (project_id, window_to);
-- One run per project and local date regardless of status: a failed run is
-- retried by reclaiming the same frozen row, never by inserting a second run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_run_per_local_date
  ON digest_runs (project_id, run_date);

CREATE TABLE IF NOT EXISTS digest_run_items (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id     UUID NOT NULL REFERENCES digest_runs(id) ON DELETE CASCADE,
  episode_id UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  outcome    TEXT CHECK (outcome IS NULL OR outcome IN ('included','deferred')),
  reason     TEXT,
  PRIMARY KEY (run_id, episode_id)
);

ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES issue_episodes(id) ON DELETE CASCADE;
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS input_version INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_job_per_episode_type
  ON error_group_jobs (project_id, episode_id, job_type)
  WHERE status IN ('pending','claimed');

-- One inquiry and one investigation job per work round and input version.
-- Retries reclaim the same row; only a new input version may enqueue again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_job_per_episode_type_version
  ON error_group_jobs (project_id, episode_id, job_type, input_version)
  WHERE episode_id IS NOT NULL AND input_version IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_inquiry_per_evidence
  ON issue_inquiry_decisions (project_id, episode_id, prompt_version, evidence_signature);

-- route_map already has purpose, source (DEFAULT 'llm'), created_at, and
-- updated_at from migration 040; only the structured-understanding columns
-- below are new.
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS actions TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS client_refs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS server_refs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS observed_requests TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS commit_sha TEXT;
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS prompt_version INTEGER;
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS model TEXT;

-- error_group_id is already nullable (001_baseline: friction jobs), and
-- project-scoped jobs (route_map, session_analysis, setup_pr) legitimately
-- carry no group, episode, or run. No scope CHECK belongs here.
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES digest_runs(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_write_job_per_run
  ON error_group_jobs (project_id, run_id, job_type)
  WHERE run_id IS NOT NULL AND status IN ('pending','claimed');

ALTER TABLE diagnosis_decisions
  ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES issue_episodes(id) ON DELETE SET NULL;

-- Compact facts derived from scrubbed recordings. Failures stay exact enough
-- to investigate; successful writes are rolled up. Query strings, hosts,
-- bodies, input values, and DOM text do not belong in either table. Retention
-- deletes the owning session and cascades these facts with it.
CREATE TABLE IF NOT EXISTS session_request_failures (
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id_hash  TEXT NOT NULL,
  page_route       TEXT NOT NULL,
  method           TEXT NOT NULL,
  endpoint_pattern TEXT NOT NULL,
  status           INTEGER NOT NULL,
  action_kind      TEXT CHECK (action_kind IS NULL OR action_kind IN ('click','form_submit')),
  action_selector  TEXT,
  action_link      TEXT NOT NULL CHECK (action_link IN ('direct','none')),
  occurred_at      TIMESTAMPTZ NOT NULL,
  rule_version     INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id, request_id_hash, rule_version)
);

CREATE TABLE IF NOT EXISTS session_write_rollups (
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  page_route       TEXT NOT NULL,
  method           TEXT NOT NULL,
  endpoint_pattern TEXT NOT NULL,
  status_class     INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL,
  rule_version     INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id, page_route, method,
               endpoint_pattern, status_class, rule_version)
);

-- outcome predates this migration. Preserve legacy values for existing rows and
-- old binaries while admitting the rewritten pipeline's terminal outcomes.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'diagnosis_decisions'::regclass
      AND conname = 'diagnosis_decisions_outcome_check'
      AND convalidated
      AND pg_get_constraintdef(oid) =
        'CHECK ((outcome = ANY (ARRAY[''code_fix''::text, ''not_actionable''::text, ''needs_more_context''::text, ''incomplete''::text, ''verified_fix''::text, ''needs_human''::text, ''unable_to_establish_cause''::text])))'
  ) THEN
    ALTER TABLE diagnosis_decisions DROP CONSTRAINT IF EXISTS diagnosis_decisions_outcome_check;
    ALTER TABLE diagnosis_decisions ADD CONSTRAINT diagnosis_decisions_outcome_check
      CHECK (outcome IN ('code_fix','not_actionable','needs_more_context','incomplete',
                         'verified_fix','needs_human','unable_to_establish_cause'));
  END IF;
END $$;
