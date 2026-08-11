-- C1/W1.3: persisted degenerate investigation verdicts become digest-ineligible.
-- Content-driven, anchored (7 rows in prod on 2026-08-10; 0 in fresh databases).
-- One-shot via applied_data_migrations: boot re-runs must not undo later
-- re-investigation results.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM applied_data_migrations WHERE name = '045_quarantine_degenerate_verdicts') THEN
    INSERT INTO digest_readiness (incident_id, project_id, status, reason)
    SELECT g.id, g.project_id, 'ineligible', 'quarantined_degenerate'
    FROM error_groups g
    WHERE g.root_cause ~* '^\s*(placeholder|tbd|to be determined)\M'
    ON CONFLICT (incident_id) DO UPDATE
      SET status = 'ineligible', reason = 'quarantined_degenerate', updated_at = now();
    INSERT INTO applied_data_migrations (name) VALUES ('045_quarantine_degenerate_verdicts');
  END IF;
END
$$;
