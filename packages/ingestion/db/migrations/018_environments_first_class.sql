-- 018_environments_first_class.sql — environment-scoped read rollups.
-- Append-only after 017. IDEMPOTENCY IS MANDATORY: run-migrations.sh
-- re-applies every file on every start.

-- Error-kind groups aggregate occurrences by environment. Friction-kind groups
-- remain represented directly by error_groups.environment_id and never get rows
-- in this table.
CREATE TABLE IF NOT EXISTS error_group_environments (
  error_group_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  environment_id UUID NOT NULL REFERENCES environments(id),
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  occurrence_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (error_group_id, environment_id)
);

CREATE INDEX IF NOT EXISTS idx_ege_env_last_seen
  ON error_group_environments (environment_id, last_seen DESC, error_group_id);

CREATE INDEX IF NOT EXISTS idx_error_groups_project_last_seen
  ON error_groups (project_id, last_seen DESC);

-- Friction-kind incidents are stored directly on error_groups and form the
-- second ordered arm of the environment-filtered incident query.
CREATE INDEX IF NOT EXISTS idx_error_groups_project_env_last_seen
  ON error_groups (project_id, environment_id, last_seen DESC, id)
  WHERE kind = 'friction';

CREATE INDEX IF NOT EXISTS idx_sessions_project_env_started
  ON sessions (project_id, environment_id, started_at DESC, id DESC);

-- Enforce hygiene for new/updated values without rejecting legacy rows during
-- rollout. Existing installations can validate after inventory/remediation.
DO $$
BEGIN
  ALTER TABLE environments ADD CONSTRAINT chk_environment_name_format
    CHECK (name ~ '^[A-Za-z0-9._-]{1,64}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS rollup_backfill_state (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO rollup_backfill_state (id, status)
VALUES (true, 'pending')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS rollup_backfill_ledger (
  batch_start UUID NOT NULL,
  batch_end UUID NOT NULL,
  pass INT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_start, pass)
);

-- Phase 3 provisioning columns ship with the schema so later rollout stages do
-- not require another migration.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS idempotency_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_idem
  ON projects (org_id, idempotency_token)
  WHERE idempotency_token IS NOT NULL;
