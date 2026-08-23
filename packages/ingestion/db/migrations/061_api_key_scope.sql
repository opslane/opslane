-- Add the secret programmatic API-key scope and optional expiry.
--
-- Migration 028 created these checks without explicit names. PostgreSQL names
-- them project_api_keys_scope_check and project_api_keys_check. Drop both the
-- deployed and replacement names before adding named constraints so replaying
-- all migrations remains safe.
ALTER TABLE project_api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE project_api_keys
  DROP CONSTRAINT IF EXISTS project_api_keys_scope_check;
ALTER TABLE project_api_keys
  ADD CONSTRAINT project_api_keys_scope_check
  CHECK (scope IN ('ingest', 'sourcemaps', 'api'));

ALTER TABLE project_api_keys
  DROP CONSTRAINT IF EXISTS project_api_keys_check;
ALTER TABLE project_api_keys
  DROP CONSTRAINT IF EXISTS project_api_keys_token_prefix_check;
ALTER TABLE project_api_keys
  ADD CONSTRAINT project_api_keys_token_prefix_check
  CHECK (
    (scope = 'ingest' AND token_prefix = 'opslane_pk') OR
    (scope = 'sourcemaps' AND token_prefix = 'opslane_sk') OR
    (scope = 'api' AND token_prefix = 'opslane_ak')
  );
