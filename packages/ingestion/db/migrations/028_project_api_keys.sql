-- Project-scoped API keys with permission stored as data.
CREATE TABLE IF NOT EXISTS project_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id TEXT NOT NULL UNIQUE CHECK (key_id ~ '^[a-z2-7]{26}$'),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('ingest', 'sourcemaps')),
  token_prefix TEXT NOT NULL CHECK (
    (scope = 'ingest' AND token_prefix = 'opslane_pk') OR
    (scope = 'sourcemaps' AND token_prefix = 'opslane_sk')
  ),
  secret_hash TEXT NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  label TEXT NOT NULL
    CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 100),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (revoked_at IS NOT NULL OR revoked_by_user_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_project_api_keys_project_created
  ON project_api_keys(project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_project_api_keys_project_active_scope
  ON project_api_keys(project_id, scope)
  WHERE revoked_at IS NULL;

ALTER TABLE projects ALTER COLUMN allow_payload_environment SET DEFAULT true;

-- The backfill below must run ONCE, not on every boot. scripts/run-migrations.sh
-- has no ledger and replays every file on every start, and the flag stays
-- operator-settable (PATCH /api/v1/projects/{id}, dashboard Settings toggle).
-- Unguarded, this UPDATE would silently re-enable payload-environment overrides
-- on every restart for any project whose owner deliberately turned them off.
CREATE TABLE IF NOT EXISTS applied_data_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM applied_data_migrations
    WHERE name = '028_allow_payload_environment_backfill'
  ) THEN
    UPDATE projects SET allow_payload_environment = true
      WHERE allow_payload_environment IS DISTINCT FROM true;
    INSERT INTO applied_data_migrations (name)
      VALUES ('028_allow_payload_environment_backfill');
  END IF;
END $$;
