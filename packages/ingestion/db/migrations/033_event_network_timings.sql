SET lock_timeout = '3s';

-- Written by ingestion, read by nothing. The worker slice that renders these
-- into the investigation prompt lands separately.
ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS network_timings JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE error_events DROP CONSTRAINT IF EXISTS error_events_network_timings_array;
ALTER TABLE error_events ADD CONSTRAINT error_events_network_timings_array
  CHECK (jsonb_typeof(network_timings) = 'array') NOT VALID;

ALTER TABLE error_events VALIDATE CONSTRAINT error_events_network_timings_array;
