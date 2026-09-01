-- 070_billing_tracked.sql
-- Billing v1 (docs/design/2026-09-01-billing-v1.md): dispatch ledger for
-- billing-related side effects. One row per dispatched unit, keyed by a stable
-- natural ref:
--   'pr:<project_id>:<github_repo>:<pr_number>'  merged-PR usage reported to Autumn
--   'sessions_alert:<org_id>:<YYYY-MM>'          monthly session-ceiling Slack alert
--   'launch:backfill'                            one-shot sentinel (see below)
-- Insert-once semantics make the billing sweeper safe to crash and re-run.
-- For 'pr:' refs a row means Autumn durably accepted (or deduped) the track
-- call; for alert refs it means the alert was dispatched best-effort.
CREATE TABLE IF NOT EXISTS billing_tracked (
  ref        TEXT PRIMARY KEY,
  org_id     UUID REFERENCES orgs(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL CHECK (feature_id <> ''),
  value      NUMERIC(12,4) NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_tracked_org ON billing_tracked(org_id);

-- Repo identity on receipts: PR numbers restart when a project is rebound to
-- a different repository, so the billing ref needs the repo. Nullable --
-- pre-070 receipts have no repo; the backfill settles them anyway.
ALTER TABLE pr_outcomes ADD COLUMN IF NOT EXISTS github_repo TEXT;

-- Launch cutoff: merges that happened before billing existed are settled as
-- already-tracked (value 0) so the first sweep cannot back-bill history into
-- the current Autumn period. One-shot: guarded by the 'launch:backfill'
-- sentinel row (an empty table is NOT a durable "already ran" signal -- zero
-- historical merges would re-arm the backfill on every boot and zero-settle
-- live merges). Advisory lock guards concurrent boots.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('070_billing_tracked'));
INSERT INTO billing_tracked (ref, org_id, feature_id, value)
SELECT DISTINCT ON (po.project_id, lower(coalesce(po.github_repo, p.github_repo, '')), po.pr_number)
       'pr:' || po.project_id || ':' || lower(coalesce(po.github_repo, p.github_repo, '')) || ':' || po.pr_number,
       p.org_id, 'merged_prs', 0
FROM pr_outcomes po
JOIN projects p ON p.id = po.project_id
WHERE po.outcome = 'merged' AND po.fix_job_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM billing_tracked WHERE ref = 'launch:backfill')
ON CONFLICT (ref) DO NOTHING;
INSERT INTO billing_tracked (ref, org_id, feature_id, value)
VALUES ('launch:backfill', NULL, 'sentinel', 0)
ON CONFLICT (ref) DO NOTHING;
COMMIT;
