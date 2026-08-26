-- Onboarding v2: one stored completion fact. Set only by POST /onboarding/complete.
-- Backfill marks every org that already had a project at cutover as onboarded so
-- existing users never see the new wizard; a projectless org still needs it.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

-- One-shot guard (applied_data_migrations pattern from 038/045): migrations
-- replay on every boot, and an unguarded backfill would re-stamp any org that
-- created its first project through the v2 wizard but has not completed yet --
-- a deploy mid-wizard would silently finish their onboarding and make a
-- support reset of onboarded_at impossible.
UPDATE orgs o
   SET onboarded_at = now()
 WHERE o.onboarded_at IS NULL
   AND EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.id)
   AND NOT EXISTS (SELECT 1 FROM applied_data_migrations WHERE name = '062_onboarding_backfill');

INSERT INTO applied_data_migrations (name) VALUES ('062_onboarding_backfill')
ON CONFLICT (name) DO NOTHING;
