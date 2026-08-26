-- Onboarding v2: one stored completion fact. Set only by POST /onboarding/complete.
-- Backfill marks every org that already has a project as onboarded so existing
-- users never see the new wizard; a projectless org still needs it.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

UPDATE orgs o
   SET onboarded_at = now()
 WHERE o.onboarded_at IS NULL
   AND EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.id);
