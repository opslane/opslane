-- Daily digest v1 (docs/superpowers/specs/2026-08-07-daily-digest-design.md).
-- digest.daily becomes a legal event type; existing destinations are
-- backfilled ONCE (product decision: the digest is automatic; the unsubscribe
-- toggle ships in the same release). Migrations replay on every boot, so the
-- backfill is guarded by a one-shot marker -- without it, a replay would
-- silently re-subscribe anyone who unsubscribed.

ALTER TABLE notification_destinations
  DROP CONSTRAINT IF EXISTS notification_destinations_event_types_check;
ALTER TABLE notification_destinations
  ADD CONSTRAINT notification_destinations_event_types_check
  CHECK (cardinality(event_types) >= 1
         AND event_types <@ ARRAY['issue.created','digest.daily']);

ALTER TABLE notification_destinations
  ALTER COLUMN event_types SET DEFAULT '{issue.created,digest.daily}';

-- One-shot guard reuses the existing applied_data_migrations marker table
-- (028_project_api_keys.sql:28); no new table is needed.
UPDATE notification_destinations
SET event_types = event_types || '{digest.daily}'
WHERE NOT ('digest.daily' = ANY(event_types))
  AND NOT EXISTS (SELECT 1 FROM applied_data_migrations WHERE name = '038_digest_backfill');

INSERT INTO applied_data_migrations (name) VALUES ('038_digest_backfill')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE outbound_events
  DROP CONSTRAINT IF EXISTS outbound_events_event_type_check;
ALTER TABLE outbound_events
  ADD CONSTRAINT outbound_events_event_type_check
  CHECK (event_type IN ('issue.created','digest.daily'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS digest_timezone TEXT NOT NULL DEFAULT 'UTC';
