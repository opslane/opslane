-- 072_action_class_fix_provenance.sql -- the ask depends on whether a fix ran.
--
-- Migration 066 classified an incident's ask from status, diff and PR URL
-- alone, so an incident that reached a verdict and one whose fix run failed
-- both asked the reader to "Review the investigation." Only one of them has an
-- investigation of a fix run to review. digest.digestAction now splits those
-- two, and this file is its SQL twin: it governs when the waiting age resets,
-- so the two must agree or a reset fires on a change the reader never saw.
--
-- A fix ran only when the incident's terminal fix job really is a fix job. The
-- worker's dead-lettered-investigation reconciliation stores an INVESTIGATION
-- job id in terminal_fix_job_id, so the id alone proves nothing; a missing job
-- or a NULL id is false.
--
-- Transactional for the same reason 064 and 066 are: the lifecycle function and
-- its UPDATE trigger are briefly replaced together, and no window may exist
-- where one has been changed and the other has not.
BEGIN;

-- The four-argument classifier. Kept pure and IMMUTABLE: the caller looks the
-- job up and passes the answer in, so this stays an indexable expression and
-- the lookup happens once per trigger call instead of once per row scanned.
--
-- 066's three-argument function is deliberately left in place. The runner
-- replays every file on every boot and 066 recreates it each time; this file
-- runs after and owns the trigger bodies below, so the old one is unreferenced.
CREATE OR REPLACE FUNCTION error_groups_action_class(
  status TEXT, candidate_diff TEXT, pr_url TEXT, fix_attempted BOOLEAN
) RETURNS TEXT AS $$
BEGIN
  CASE status
    WHEN 'awaiting_approval' THEN
      IF NULLIF(btrim(COALESCE(candidate_diff,'')),'') IS NOT NULL THEN
        RETURN 'Approve the proposed fix.';
      END IF;
      IF COALESCE(fix_attempted,false) THEN
        RETURN 'Review the investigation.';
      END IF;
      RETURN 'Review the diagnosis.';
    WHEN 'pr_created', 'pr_draft' THEN
      IF NULLIF(btrim(COALESCE(pr_url,'')),'') IS NOT NULL THEN
        RETURN 'Review the fix PR.';
      END IF;
      -- Inconsistent state: the digest still renders it and logs a diagnostic.
      RETURN 'Review the issue.';
    WHEN 'needs_human' THEN
      IF NULLIF(btrim(COALESCE(candidate_diff,'')),'') IS NOT NULL
         OR COALESCE(fix_attempted,false) THEN
        RETURN 'Review the investigation.';
      END IF;
      RETURN 'Review the diagnosis.';
    ELSE
      RETURN NULL;
  END CASE;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- error_groups_fix_attempted answers "did a fix job really run for this
-- incident". STABLE, not IMMUTABLE: it reads another table.
CREATE OR REPLACE FUNCTION error_groups_fix_attempted(
  terminal_fix_job_id UUID, project_id UUID
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM error_group_jobs j
     WHERE j.id = terminal_fix_job_id
       AND j.project_id = project_id
       AND j.job_type IN ('fix','error_fix')
  );
$$ LANGUAGE sql STABLE;

-- Replaced, not duplicated: 064's triggers keep calling this one function.
CREATE OR REPLACE FUNCTION error_groups_actionable_lifecycle() RETURNS trigger AS $$
DECLARE
  was_class TEXT := NULL;
  is_class TEXT;
BEGIN
  -- OLD is unassigned for INSERT triggers.
  IF TG_OP = 'UPDATE' THEN
    was_class := error_groups_action_class(OLD.status::text, OLD.candidate_diff, OLD.pr_url,
      error_groups_fix_attempted(OLD.terminal_fix_job_id, OLD.project_id));
  END IF;
  is_class := error_groups_action_class(NEW.status::text, NEW.candidate_diff, NEW.pr_url,
    error_groups_fix_attempted(NEW.terminal_fix_job_id, NEW.project_id));

  IF is_class IS NULL THEN
    NEW.actionable_since := NULL;
    NEW.snoozed_until := NULL;
  ELSIF was_class IS DISTINCT FROM is_class THEN
    -- The ask changed: the waiting age restarts and any snooze on the previous
    -- ask is void (a user who snoozed "approve the fix" never saw "review the PR").
    NEW.actionable_since := now();
    NEW.snoozed_until := NULL;
  ELSE
    -- Same ask. Preserve both, INCLUDING an explicitly supplied actionable_since:
    -- 066's backfill and any operator repair depend on that.
    SELECT * INTO NEW.actionable_since, NEW.snoozed_until
      FROM error_groups_hold_pending_action(was_class, is_class,
        NEW.actionable_since, NEW.snoozed_until, OLD.actionable_since, OLD.snoozed_until);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- The UPDATE trigger must fire on every input the class reads, and the class
-- now reads the terminal fix job too: a fix job id arriving alone changes the
-- ask, and without this column in the list nothing would reset the waiting age.
-- Guarded so a replay leaves the trigger object (and its OID) alone.
--
-- 066's own guard asks only whether candidate_diff and pr_url are watched, so
-- it finds this widened list acceptable and does not fight it on the next boot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
     WHERE tg.tgrelid='error_groups'::regclass
       AND tg.tgname='error_groups_actionable_lifecycle_upd'
       AND (SELECT count(*) FROM unnest(tg.tgattr::int[]) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid=tg.tgrelid AND a.attnum=k.attnum
            WHERE a.attname IN ('candidate_diff','pr_url','terminal_fix_job_id')) = 3
  ) THEN
    DROP TRIGGER IF EXISTS error_groups_actionable_lifecycle_upd ON error_groups;
    CREATE TRIGGER error_groups_actionable_lifecycle_upd
      BEFORE UPDATE OF status, candidate_diff, pr_url, terminal_fix_job_id,
                       actionable_since, snoozed_until
      ON error_groups
      FOR EACH ROW EXECUTE FUNCTION error_groups_actionable_lifecycle();
  END IF;
END $$;

-- The stale-sweep guard classifies with the same rule. Its watched-column list
-- is deliberately NOT widened: 066 recreates that trigger whenever the list is
-- not exactly its own five columns, so widening here would make every boot drop
-- and recreate it twice, taking an ACCESS EXCLUSIVE lock on a hot table each
-- time. A bare terminal_fix_job_id write reaches the lifecycle trigger above,
-- which is the one that owns the reset.
CREATE OR REPLACE FUNCTION error_groups_pending_action_guard() RETURNS trigger AS $$
DECLARE
  was_class TEXT := error_groups_action_class(OLD.status::text, OLD.candidate_diff, OLD.pr_url,
    error_groups_fix_attempted(OLD.terminal_fix_job_id, OLD.project_id));
  is_class TEXT := error_groups_action_class(NEW.status::text, NEW.candidate_diff, NEW.pr_url,
    error_groups_fix_attempted(NEW.terminal_fix_job_id, NEW.project_id));
BEGIN
  SELECT * INTO NEW.actionable_since, NEW.snoozed_until
    FROM error_groups_hold_pending_action(was_class, is_class,
      NEW.actionable_since, NEW.snoozed_until, OLD.actionable_since, OLD.snoozed_until);
  -- 064's replayed sweep matches every pr_created/pr_draft row on every boot.
  -- Once this guard has put the row back the way it was, the statement has
  -- nothing left to write, and a BEFORE UPDATE row trigger returning NULL
  -- cancels it — otherwise each boot leaves one dead tuple per PR incident
  -- forever. The whole row is compared, so an update that changed any other
  -- column (or that the guard did not fully revert) still applies.
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

COMMIT;
