SET lock_timeout = '3s';

ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS debug_meta JSONB NOT NULL DEFAULT '{"images":[]}'::jsonb;
ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS commit_sha TEXT;

ALTER TABLE error_events DROP CONSTRAINT IF EXISTS error_events_debug_meta_object;
ALTER TABLE error_events ADD CONSTRAINT error_events_debug_meta_object
  CHECK (jsonb_typeof(debug_meta) = 'object') NOT VALID;
ALTER TABLE error_events DROP CONSTRAINT IF EXISTS error_events_commit_sha_hex;
ALTER TABLE error_events ADD CONSTRAINT error_events_commit_sha_hex
  CHECK (commit_sha IS NULL OR commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') NOT VALID;

ALTER TABLE error_events VALIDATE CONSTRAINT error_events_debug_meta_object;
ALTER TABLE error_events VALIDATE CONSTRAINT error_events_commit_sha_hex;
