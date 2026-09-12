-- Known problems: durable tickets, atomic observations, and publication generations.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('074_friction_tickets'));
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS friction_tickets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id         UUID NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,           -- immutable
  control                TEXT NOT NULL,           -- immutable
  what_happened          TEXT NOT NULL,           -- immutable
  steps                  TEXT,                    -- presentation, regenerated
  kind                   TEXT NOT NULL CHECK (kind IN ('defect','ux_insight')),  -- internal only
  screens_confirmed      TEXT[] NOT NULL DEFAULT '{}',
  screens_proposed       TEXT[] NOT NULL DEFAULT '{}',
  status                 TEXT NOT NULL DEFAULT 'tracking' CHECK (status IN ('tracking','published','unpublished','merged','archived')),
  embedding              vector(1536),
  embedding_model        TEXT,
  matched_count          INT NOT NULL DEFAULT 0,
  next_arrival_number    BIGINT NOT NULL DEFAULT 0,
  arrival_boundary       BIGINT NOT NULL DEFAULT 0,
  evidence_version       INT NOT NULL DEFAULT 0,
  live_generation        INT NOT NULL DEFAULT 0,
  fold_retries           INT NOT NULL DEFAULT 0,
  fixed_at               TIMESTAMPTZ,
  cohort_cutoff          TIMESTAMPTZ,            -- recordings at or before this never count; set to fixed_at on merge, kept on regression
  reconcile_needed       BOOLEAN NOT NULL DEFAULT false,
  reinvestigate_needed   BOOLEAN NOT NULL DEFAULT false,
  merged_into            UUID REFERENCES friction_tickets(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_friction_tickets_env_status ON friction_tickets (project_id, environment_id, status);
CREATE INDEX IF NOT EXISTS idx_friction_tickets_screens ON friction_tickets USING GIN (screens_confirmed);

-- Atomic evidence: one row per narrator observation, immutable once written.
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS observation_id TEXT;
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS evidence_lines JSONB;
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS narrative_id TEXT;  -- derived, never null for atomic rows (Task 2)
CREATE UNIQUE INDEX IF NOT EXISTS idx_friction_signals_atomic ON friction_signals (session_id, narrative_id, observation_id) WHERE observation_id IS NOT NULL;

-- Source-decision ledger: exactly one decision per atomic observation. Serializes ticket creation.
CREATE TABLE IF NOT EXISTS friction_observation_decisions (
  signal_id      UUID PRIMARY KEY REFERENCES friction_signals(id) ON DELETE CASCADE,
  project_id     UUID NOT NULL,
  environment_id UUID NOT NULL,
  session_id     TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('reserved','matched','created','not_a_problem')),
  ticket_id      UUID REFERENCES friction_tickets(id),
  CONSTRAINT friction_decision_ticket_required CHECK (decision NOT IN ('matched','created') OR ticket_id IS NOT NULL),
  decided_by     TEXT NOT NULL CHECK (decided_by IN ('cheap','strong','fold')),
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friction_ticket_matches (          -- counting unit
  ticket_id      UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id     UUID NOT NULL,
  environment_id UUID NOT NULL,
  end_user_id    UUID,
  arrival_number BIGINT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('cheap','strong','backfill','fold')),
  occurred_at    TIMESTAMPTZ NOT NULL,
  matched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, session_id),
  UNIQUE (ticket_id, arrival_number)
);
CREATE TABLE IF NOT EXISTS friction_ticket_match_observations ( -- evidence unit
  ticket_id      UUID NOT NULL,
  session_id     TEXT NOT NULL,
  signal_id      UUID NOT NULL REFERENCES friction_signals(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, session_id, signal_id),
  FOREIGN KEY (ticket_id, session_id) REFERENCES friction_ticket_matches(ticket_id, session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS friction_session_processed (
  project_id   UUID NOT NULL,
  session_id   TEXT NOT NULL,
  narrative_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, session_id, narrative_id)
);

CREATE TABLE IF NOT EXISTS friction_confirm_batches (          -- immutable batch identity
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id                  UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  job_id                     UUID NOT NULL,
  manifest                   JSONB NOT NULL,
  arrival_boundary_at_select BIGINT NOT NULL,
  live_generation_at_select  INT NOT NULL,
  status_at_select           TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','finalized','discarded')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at               TIMESTAMPTZ
);
ALTER TABLE friction_confirm_batches ADD COLUMN IF NOT EXISTS evidence_version_at_select INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS friction_confirmation_budget (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  budget_day DATE NOT NULL,
  used INT NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY(project_id,budget_day)
);
CREATE TABLE IF NOT EXISTS friction_check_attempts (           -- staging and forensic history
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       UUID NOT NULL REFERENCES friction_confirm_batches(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL,
  session_id     TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('confirmed','refuted','inconclusive','unavailable')),
  evidence_lines JSONB NOT NULL DEFAULT '[]',
  signal_ids     JSONB NOT NULL DEFAULT '[]',
  note           TEXT NOT NULL DEFAULT '',
  cost_to_user   TEXT CHECK (cost_to_user IN ('none','annoyance','lost_time','abandoned_task')),
  frames_ok      BOOLEAN NOT NULL DEFAULT false,
  frame_manifest JSONB NOT NULL DEFAULT '[]',
  model          TEXT NOT NULL,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, session_id),
  FOREIGN KEY (ticket_id, session_id) REFERENCES friction_ticket_matches(ticket_id, session_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS friction_checks (                    -- authoritative, finalized; at most one per (ticket, session)
  ticket_id      UUID NOT NULL,
  session_id     TEXT NOT NULL,
  attempt_id     UUID NOT NULL REFERENCES friction_check_attempts(id),
  outcome        TEXT NOT NULL CHECK (outcome IN ('confirmed','refuted','inconclusive')),
  finalized_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, session_id),
  FOREIGN KEY (ticket_id, session_id) REFERENCES friction_ticket_matches(ticket_id, session_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS friction_unavailable_retries (       -- retry state, separate from evidence
  ticket_id      UUID NOT NULL,
  session_id     TEXT NOT NULL,
  attempts       INT NOT NULL DEFAULT 0,
  retry_at       TIMESTAMPTZ,
  permanent      BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (ticket_id, session_id),
  FOREIGN KEY (ticket_id, session_id) REFERENCES friction_ticket_matches(ticket_id, session_id) ON DELETE CASCADE
);

-- Generation-specific incident evidence membership; history preserved across generations.
CREATE TABLE IF NOT EXISTS friction_incident_evidence (
  error_group_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL,
  generation     INT NOT NULL,
  signal_id      UUID NOT NULL REFERENCES friction_signals(id) ON DELETE CASCADE,
  PRIMARY KEY (error_group_id, signal_id)
);
CREATE TABLE IF NOT EXISTS friction_fix_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  error_group_id UUID NOT NULL REFERENCES error_groups(id),
  generation     INT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','pr_open','failed','merged','closed','superseded')),
  pr_url         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_attempts_outstanding ON friction_fix_attempts (ticket_id, generation) WHERE status IN ('active','pr_open');

ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS ticket_id UUID;   -- 069 may have created it without the FK
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'error_groups'::regclass AND conname = 'error_groups_ticket_id_fkey') THEN
    ALTER TABLE error_groups ADD CONSTRAINT error_groups_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES friction_tickets(id);
  END IF;
END $$;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS publication_generation INT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS fix_substate TEXT CHECK (fix_substate IN ('none','fixing','pr_open','resolved'));
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS investigation_status TEXT CHECK (investigation_status IN ('pending','done','failed'));
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS evidence_version_used INT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS explained_signal_ids JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS idx_error_groups_ticket_generation ON error_groups (ticket_id, publication_generation) WHERE ticket_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_error_groups_live_ticket ON error_groups (ticket_id) WHERE ticket_id IS NOT NULL AND status <> 'archived';

ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES friction_tickets(id) ON DELETE CASCADE;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS batch_id UUID;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS publication_generation INT;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS fix_attempt_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_friction_confirm_pending ON error_group_jobs (ticket_id) WHERE job_type = 'friction_confirm' AND status IN ('pending','claimed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_friction_match_pending ON error_group_jobs (session_id) WHERE job_type = 'friction_match' AND status IN ('pending','claimed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_friction_reconcile_pending ON error_group_jobs (ticket_id) WHERE job_type = 'friction_reconcile' AND status IN ('pending','claimed');

-- Same-transaction reconcile after a recording is purged (rulebook: Recording deleted; invariant 9).
-- Callers own the environment publication lock before ticket locks.
-- Callers MUST invoke this AFTER the session delete has executed in the same transaction, so the counts below exclude the purged recording.
CREATE OR REPLACE FUNCTION friction_reconcile_after_delete(p_ticket UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t friction_tickets%ROWTYPE; g error_groups%ROWTYPE; confirmed INT; counted INT; users INT; identity BOOLEAN;
BEGIN
  SELECT * INTO t FROM friction_tickets WHERE id = p_ticket FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE friction_tickets SET matched_count = (SELECT count(*) FROM friction_ticket_matches WHERE ticket_id = p_ticket), evidence_version = evidence_version + 1, reconcile_needed = true, steps = NULL, updated_at = now() WHERE id = p_ticket;
  UPDATE error_groups SET representative_signal_id=NULL,representative_session_id=NULL WHERE ticket_id=p_ticket;
  UPDATE digest_card_copy SET invalidated_at=now() WHERE error_group_id IN(SELECT id FROM error_groups WHERE ticket_id=p_ticket) AND invalidated_at IS NULL;
  IF t.status <> 'published' THEN RETURN; END IF;
  SELECT * INTO g FROM error_groups WHERE ticket_id = p_ticket AND status <> 'archived';
  IF NOT FOUND OR g.fix_substate = 'resolved' THEN RETURN; END IF;
  SELECT count(*) FILTER (WHERE c.outcome = 'confirmed'), count(*),
         count(DISTINCT m.end_user_id) FILTER (WHERE c.outcome = 'confirmed' AND m.end_user_id IS NOT NULL),
         bool_or(c.outcome = 'confirmed' AND m.end_user_id IS NOT NULL)
    INTO confirmed, counted, users, identity
    FROM friction_checks c JOIN friction_ticket_matches m USING (ticket_id, session_id)
   WHERE c.ticket_id = p_ticket AND (t.cohort_cutoff IS NULL OR m.occurred_at > t.cohort_cutoff);
  IF confirmed < 3 OR (identity AND users < 2) OR (counted >= 10 AND confirmed::float / counted < 0.25) THEN
    UPDATE error_groups SET status_before_archive = status, status = 'archived', archived_at = now(), updated_at = now() WHERE id = g.id;
    UPDATE friction_tickets SET status = 'unpublished', updated_at = now() WHERE id = p_ticket;
    UPDATE error_group_jobs SET status = 'failed', last_error = 'unpublished', lease_expires_at=NULL, updated_at=now() WHERE error_group_id = g.id AND status IN ('pending','claimed') AND job_type IN ('investigate','fix');
    UPDATE friction_fix_attempts SET status = 'superseded', updated_at = now() WHERE error_group_id = g.id AND status IN ('active','pr_open');
  END IF;
END $$;
-- Internal identity/consolidation seam. Call before any row locks; registration
-- retries intentionally do not change identity. Match, purge and publication use
-- the same environment lock, so even a recording's first match sees this identity.
CREATE OR REPLACE FUNCTION friction_set_session_identity(p_project UUID, p_session TEXT, p_user UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE env UUID; affected UUID[]; ticket UUID;
BEGIN
  SELECT environment_id INTO env FROM sessions WHERE id=p_session AND project_id=p_project;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found in project'; END IF;
  IF p_user IS NOT NULL AND NOT EXISTS(SELECT 1 FROM end_users WHERE id=p_user AND project_id=p_project) THEN
    RAISE EXCEPTION 'Identity outside project';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('friction_publish|'||env));
  SELECT array_agg(id ORDER BY id) INTO affected FROM (
    SELECT t.id FROM friction_tickets t WHERE t.project_id=p_project AND EXISTS(
      SELECT 1 FROM friction_ticket_matches m WHERE m.ticket_id=t.id AND m.session_id=p_session)
    ORDER BY t.id FOR UPDATE
  ) locked;
  UPDATE sessions SET end_user_id=p_user WHERE id=p_session AND project_id=p_project AND end_user_id IS DISTINCT FROM p_user;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE friction_ticket_matches SET end_user_id=p_user WHERE session_id=p_session AND project_id=p_project;
  FOREACH ticket IN ARRAY coalesce(affected,'{}'::UUID[]) LOOP
    PERFORM friction_reconcile_after_delete(ticket);
  END LOOP;
END $$;

-- The old UX-only autonomy setting now applies to every verified ticket.
-- Keep the original constraint name so migration 004's guarded replay cannot
-- reinstall its retired value before this migration runs again.
UPDATE projects SET friction_autonomy = 'auto_fix' WHERE friction_autonomy = 'auto_fix_ux';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_friction_autonomy_check;
ALTER TABLE projects ADD CONSTRAINT projects_friction_autonomy_check
  CHECK (friction_autonomy IN ('ask_first','auto_fix'));

-- Ticket investigation and delivery history survive publication changes.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS investigation_execution BIGINT NOT NULL DEFAULT 0;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS investigation_result_execution BIGINT NOT NULL DEFAULT 0;
ALTER TABLE friction_fix_attempts ADD COLUMN IF NOT EXISTS pr_number INT;
ALTER TABLE friction_fix_attempts ADD COLUMN IF NOT EXISTS github_repo TEXT;
ALTER TABLE friction_fix_attempts ADD COLUMN IF NOT EXISTS requested_by TEXT NOT NULL DEFAULT 'human' CHECK (requested_by IN ('human','auto'));
CREATE INDEX IF NOT EXISTS idx_friction_fix_attempt_pr ON friction_fix_attempts(github_repo,pr_number) WHERE pr_number IS NOT NULL;
CREATE TABLE IF NOT EXISTS friction_investigation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  error_group_id UUID NOT NULL REFERENCES error_groups(id),
  generation INT NOT NULL,
  execution BIGINT NOT NULL,
  evidence_version INT NOT NULL,
  job_id UUID NOT NULL REFERENCES error_group_jobs(id),
  result JSONB NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(error_group_id,execution)
);
CREATE TABLE IF NOT EXISTS friction_pr_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  error_group_id UUID NOT NULL REFERENCES error_groups(id),
  fix_attempt_id UUID NOT NULL REFERENCES friction_fix_attempts(id),
  generation INT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('opened','closed','merged','orphan')),
  delivery_id TEXT NOT NULL UNIQUE,
  pr_url TEXT,
  pr_number INT,
  github_repo TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE friction_fix_attempts ADD COLUMN IF NOT EXISTS delivery_reserved_at TIMESTAMPTZ;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS investigation_execution BIGINT;
CREATE TABLE IF NOT EXISTS friction_gate_decisions (            -- audit of every one-fix question at the publish gate
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  batch_id      UUID,
  candidate_id  UUID NOT NULL REFERENCES friction_tickets(id) ON DELETE CASCADE,
  similarity    DOUBLE PRECISION NOT NULL,
  one_fix       BOOLEAN NOT NULL,
  reason        TEXT NOT NULL,
  model         TEXT NOT NULL,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_friction_gate_decisions_ticket ON friction_gate_decisions (ticket_id, decided_at);
CREATE TABLE IF NOT EXISTS friction_fix_failures (
  job_id UUID PRIMARY KEY REFERENCES error_group_jobs(id),
  fix_attempt_id UUID NOT NULL REFERENCES friction_fix_attempts(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS investigation_evidence_version INT;
ALTER TABLE digest_card_copy ADD COLUMN IF NOT EXISTS steps TEXT;

-- Ticket-generation incidents own their publication clock (activateGeneration
-- stamps actionable_since; a person may still un-snooze). The legacy lifecycle
-- in 064/066/072 must neither classify them nor let its replayed sweeps rewrite
-- their stamps. Shipped migrations are immutable, so two things happen here:
--
-- 1. The final lifecycle function bodies are restated with a ticket early
--    return. The boot replay runs every file in order, so these definitions
--    are the ones installed once the replay finishes.
-- 2. A separate trigger, named to fire after the legacy pair, puts a ticket
--    row's stamps back whenever a write has the shape of a replayed sweep.
--    066's replay redefines the legacy functions without the early return
--    before 074 restores them, so a guard that lives only in those functions
--    is absent exactly while 066's own sweeps run. This trigger is never
--    replaced by an earlier file, so it holds across the whole replay.
--
-- The sweeps have fixed shapes: 064/066 stamp actionable_since where it is
-- NULL without touching anything else, and reset both stamps to NULL for rows
-- outside the legacy statuses. A write that changes anything else, or that
-- clears only the snooze, goes through untouched.
CREATE OR REPLACE FUNCTION error_groups_actionable_lifecycle() RETURNS trigger AS $$
DECLARE
  was_class TEXT := NULL;
  is_class TEXT;
BEGIN
  IF NEW.ticket_id IS NOT NULL THEN RETURN NEW; END IF;
  -- OLD is unassigned for INSERT triggers.
  IF TG_OP = 'UPDATE' THEN
    was_class := error_groups_action_class(OLD.status::text, OLD.candidate_diff, OLD.pr_url,
      error_groups_fix_attempted(OLD.terminal_fix_job_id, OLD.project_id));
  END IF;
  is_class := error_groups_action_class(NEW.status::text, NEW.candidate_diff, NEW.pr_url,
    error_groups_fix_attempted(NEW.terminal_fix_job_id, NEW.project_id));

  IF is_class IS NULL THEN
    NEW.actionable_since := NULL;
    NEW.snoozed_until := NULL;
  ELSIF was_class IS DISTINCT FROM is_class THEN
    NEW.actionable_since := now();
    NEW.snoozed_until := NULL;
  ELSE
    SELECT * INTO NEW.actionable_since, NEW.snoozed_until
      FROM error_groups_hold_pending_action(was_class, is_class,
        NEW.actionable_since, NEW.snoozed_until, OLD.actionable_since, OLD.snoozed_until);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION error_groups_pending_action_guard() RETURNS trigger AS $$
DECLARE
  was_class TEXT;
  is_class TEXT;
BEGIN
  IF NEW.ticket_id IS NOT NULL THEN RETURN NEW; END IF;
  was_class := error_groups_action_class(OLD.status::text, OLD.candidate_diff, OLD.pr_url,
    error_groups_fix_attempted(OLD.terminal_fix_job_id, OLD.project_id));
  is_class := error_groups_action_class(NEW.status::text, NEW.candidate_diff, NEW.pr_url,
    error_groups_fix_attempted(NEW.terminal_fix_job_id, NEW.project_id));
  SELECT * INTO NEW.actionable_since, NEW.snoozed_until
    FROM error_groups_hold_pending_action(was_class, is_class,
      NEW.actionable_since, NEW.snoozed_until, OLD.actionable_since, OLD.snoozed_until);
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION error_groups_ticket_stamps_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.actionable_since IS NULL AND NEW.snoozed_until IS NULL AND OLD.actionable_since IS NOT NULL THEN
    NEW.actionable_since := OLD.actionable_since;
    NEW.snoozed_until := OLD.snoozed_until;
  ELSIF OLD.actionable_since IS NULL AND NEW.actionable_since IS NOT NULL
     AND NEW.status = OLD.status
     AND NEW.snoozed_until IS NOT DISTINCT FROM OLD.snoozed_until THEN
    NEW.actionable_since := NULL;
    NEW.updated_at := OLD.updated_at;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- BEFORE row triggers fire in name order; this one sorts after
-- error_groups_actionable_lifecycle_upd and error_groups_pending_action_guard_upd.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='error_groups'::regclass AND tgname='error_groups_ticket_stamps_guard_upd') THEN
    CREATE TRIGGER error_groups_ticket_stamps_guard_upd
      BEFORE UPDATE OF status, actionable_since, snoozed_until ON error_groups
      FOR EACH ROW WHEN (NEW.ticket_id IS NOT NULL)
      EXECUTE FUNCTION error_groups_ticket_stamps_guard();
  END IF;
END $$;

COMMIT;
