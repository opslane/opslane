-- Source-map resolution outcome, written by the worker at investigation time.
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS resolution_status TEXT
  CHECK (resolution_status IN
    ('resolved','partial','no_debug_ids','map_not_found','invalid_map','resolution_failed'));

-- The legacy release-keyed source_maps table remains for N-1 compatibility.
-- A later expand/contract migration can drop it after old workers are gone.
