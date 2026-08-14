-- Per-destination delivery timing for the existing issue.created subscription.
ALTER TABLE notification_destinations
  ADD COLUMN IF NOT EXISTS delivery_policy TEXT NOT NULL DEFAULT 'immediate';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'notification_destinations'::regclass
      AND conname = 'notification_destinations_delivery_policy_check'
  ) THEN
    ALTER TABLE notification_destinations
      ADD CONSTRAINT notification_destinations_delivery_policy_check
      CHECK (delivery_policy IN ('immediate', 'post_triage'));
  END IF;
END $$;

-- issue.triaged is an internal outbox event. It deliberately does not appear
-- in notification_destinations_event_types_check because it is not a separate
-- user-selectable subscription.
ALTER TABLE outbound_events
  DROP CONSTRAINT IF EXISTS outbound_events_event_type_check;
ALTER TABLE outbound_events
  ADD CONSTRAINT outbound_events_event_type_check
  CHECK (event_type IN ('issue.created', 'issue.triaged', 'digest.daily'));
