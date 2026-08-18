-- Resolution closes the issue's work round.
--
-- The architecture ties "investigate once" and "publish once" to the round
-- (issue_episodes): an unresolved issue stays in one open round, resolution
-- closes it, and a genuinely later recurrence opens round two and reads as
-- returned. Issues are resolved from two runtimes (the Go manual endpoint and
-- the worker's background auto-resolvers), so the close lives here as a
-- trigger: one writer for the transition, impossible for a future resolution
-- path to forget. The audited merge keeps its own explicit close for loser
-- episodes (status 'merged', which this trigger deliberately ignores), and
-- the reopen transition (resolved -> new) does not fire it.

CREATE OR REPLACE FUNCTION close_open_issue_episodes_on_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE issue_episodes
       SET closed_at = COALESCE(NEW.resolved_at, now())
     WHERE project_id = NEW.project_id
       AND canonical_issue_id = NEW.id
       AND closed_at IS NULL;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS error_groups_close_episodes_on_resolution ON error_groups;
CREATE TRIGGER error_groups_close_episodes_on_resolution
AFTER UPDATE OF status ON error_groups
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'resolved')
EXECUTE FUNCTION close_open_issue_episodes_on_resolution();

-- Repair rounds left open by resolutions that happened before this trigger
-- existed. Idempotent: an already-consistent database updates zero rows.
UPDATE issue_episodes ep
   SET closed_at = COALESCE(g.resolved_at, now())
  FROM error_groups g
 WHERE g.project_id = ep.project_id
   AND g.id = ep.canonical_issue_id
   AND g.status = 'resolved'
   AND ep.closed_at IS NULL;
