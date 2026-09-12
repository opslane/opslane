-- 066_pr_actionable.sql -- PR review joins the actionable lifecycle.
-- Additive and DB-only: no binary reads the PR statuses out of this lane yet,
-- so this migration is safe to deploy on its own.
--
-- Migration 064 stamps actionable_since when a group ENTERS a status set. This
-- replaces that rule with the action CLASS: the instruction line a reader would
-- see, which digest.digestAction computes in Go. The waiting age resets exactly
-- when the ask changes, and survives when it does not (pr_draft -> pr_created is
-- the same "Review the fix PR." ask). Keep the two implementations in step.
--
-- Transactional for the same reason 064 is: the UPDATE trigger is briefly
-- recreated to widen its column list, and no window may exist with no trigger.
BEGIN;

-- error_groups_action_class mirrors digest.digestAction. NULL means "no human
-- action pending", which is what leaves the lifecycle.
CREATE OR REPLACE FUNCTION error_groups_action_class(
  status TEXT, candidate_diff TEXT, pr_url TEXT
) RETURNS TEXT AS $$
BEGIN
  CASE status
    WHEN 'awaiting_approval' THEN
      IF NULLIF(btrim(COALESCE(candidate_diff,'')),'') IS NOT NULL THEN
        RETURN 'Approve the proposed fix.';
      END IF;
      RETURN 'Review the investigation.';
    WHEN 'pr_created', 'pr_draft' THEN
      IF NULLIF(btrim(COALESCE(pr_url,'')),'') IS NOT NULL THEN
        RETURN 'Review the fix PR.';
      END IF;
      -- Inconsistent state: the digest still renders it and logs a diagnostic.
      RETURN 'Review the issue.';
    WHEN 'needs_human' THEN
      RETURN 'Review the investigation.';
    ELSE
      RETURN NULL;
  END CASE;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- error_groups_hold_pending_action is the one rule that protects a row still
-- waiting on a human from a stale bulk UPDATE. Shipped migration 064 ends with
-- a repair sweep keyed to its two-status list, and the runner has no ledger
-- (scripts/run-migrations.sh replays every file on every boot), so that sweep
-- matches every pr_created/pr_draft row at each ingestion start.
--
-- The rule: within one action class, no legitimate caller ERASES the waiting
-- age of a row that is still waiting, so a statement that does is a stale bulk
-- repair and both columns are restored. Erasure means old_since IS NOT NULL and
-- new_since IS NULL. A row that never had a waiting age has nothing to erase,
-- so an explicit clear on it stands: that is the snooze endpoint's un-snooze
-- ({"until": null} sends snoozed_until=NULL and touches nothing else), and
-- reverting it hid the incident from every digest while the API returned 204.
CREATE OR REPLACE FUNCTION error_groups_hold_pending_action(
  was_class TEXT, is_class TEXT,
  new_since TIMESTAMPTZ, new_snooze TIMESTAMPTZ,
  old_since TIMESTAMPTZ, old_snooze TIMESTAMPTZ,
  OUT held_since TIMESTAMPTZ, OUT held_snooze TIMESTAMPTZ
) AS $$
BEGIN
  held_since := new_since;
  held_snooze := new_snooze;
  IF is_class IS NULL THEN
    RETURN;
  END IF;
  IF was_class IS DISTINCT FROM is_class THEN
    -- The ask changed, so the age restarts and the snooze on the previous ask
    -- is void. 066's lifecycle body has already done that (new_since is then
    -- the fresh stamp), but during each boot replay there is a window between
    -- 064's COMMIT and 066's COMMIT where 064's narrower UPDATE OF list is
    -- live: a bare pr_url or candidate_diff write never reaches the lifecycle
    -- trigger, and only this guard sees the transition. Stamping when nothing
    -- stamped it is what keeps that window from losing the reset.
    IF new_since IS NOT DISTINCT FROM old_since THEN
      held_since := now();
      held_snooze := NULL;
    END IF;
    RETURN;
  END IF;
  IF new_since IS NULL THEN
    IF old_since IS NOT NULL THEN
      -- A stale bulk repair erased a waiting age that is still owed: restore both.
      held_since := old_since;
      held_snooze := COALESCE(new_snooze, old_snooze);
    ELSIF new_snooze IS NOT NULL THEN
      -- A snooze arriving on a row that never got a waiting age. Stamp one, or
      -- the rule above cannot protect this snooze from the next boot's replayed
      -- 064 sweep. A snooze being CLEARED (new_snooze NULL) is left alone:
      -- that is the un-snooze, and it must stand.
      held_since := now();
    END IF;
  END IF;
END $$ LANGUAGE plpgsql;

-- Replaced, not duplicated: the 064 triggers keep calling this one function, so
-- replaying either migration cannot leave two competing lifecycle rules.
CREATE OR REPLACE FUNCTION error_groups_actionable_lifecycle() RETURNS trigger AS $$
DECLARE
  was_class TEXT := NULL;
  is_class TEXT;
BEGIN
  -- OLD is unassigned for INSERT triggers.
  IF TG_OP = 'UPDATE' THEN
    was_class := error_groups_action_class(OLD.status::text, OLD.candidate_diff, OLD.pr_url);
  END IF;
  is_class := error_groups_action_class(NEW.status::text, NEW.candidate_diff, NEW.pr_url);

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
    -- the backfill below and any operator repair depend on that.
    SELECT * INTO NEW.actionable_since, NEW.snoozed_until
      FROM error_groups_hold_pending_action(was_class, is_class,
        NEW.actionable_since, NEW.snoozed_until, OLD.actionable_since, OLD.snoozed_until);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- The UPDATE trigger must fire on every input the class reads. 064 watches only
-- status/actionable_since/snoozed_until, so a diff or PR URL arriving alone
-- would silently skip its reset. Guarded: a replay finds the widened list and
-- leaves the trigger object (and its OID) alone.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
     WHERE tg.tgrelid='error_groups'::regclass
       AND tg.tgname='error_groups_actionable_lifecycle_upd'
       AND (SELECT count(*) FROM unnest(tg.tgattr::int[]) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid=tg.tgrelid AND a.attnum=k.attnum
            WHERE a.attname IN ('candidate_diff','pr_url')) = 2
  ) THEN
    DROP TRIGGER IF EXISTS error_groups_actionable_lifecycle_upd ON error_groups;
    CREATE TRIGGER error_groups_actionable_lifecycle_upd
      BEFORE UPDATE OF status, candidate_diff, pr_url, actionable_since, snoozed_until
      ON error_groups
      FOR EACH ROW EXECUTE FUNCTION error_groups_actionable_lifecycle();
  END IF;
END $$;

-- The lifecycle function above is only the authority while IT is the installed
-- body. Every boot replays 064 first, which restores 064's own two-status body
-- and then runs its repair sweep in the same file — so the rule has to survive
-- under a foreign function too. This guard is a separate trigger 064 never
-- drops (it drops only its own two names), and its name sorts AFTER
-- error_groups_actionable_lifecycle_upd, so Postgres fires it last and it
-- repairs whatever body ran before it. Under 066's own body it is a no-op:
-- the lifecycle function has already held the columns, so new_since is not NULL.
CREATE OR REPLACE FUNCTION error_groups_pending_action_guard() RETURNS trigger AS $$
DECLARE
  was_class TEXT := error_groups_action_class(OLD.status::text, OLD.candidate_diff, OLD.pr_url);
  is_class TEXT := error_groups_action_class(NEW.status::text, NEW.candidate_diff, NEW.pr_url);
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

-- Guarded exactly like the lifecycle trigger above, and for the same reason:
-- the runner replays every file on every ingestion boot, so an unconditional
-- DROP/CREATE would take an ACCESS EXCLUSIVE lock on the hot error_groups table
-- at each start — blocking writes, or failing on lock_timeout, while the other
-- tasks serve traffic. Recreate only when the watched-column list differs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
     WHERE tg.tgrelid='error_groups'::regclass
       AND tg.tgname='error_groups_pending_action_guard_upd'
       AND (SELECT count(*) FROM unnest(tg.tgattr::int[]) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid=tg.tgrelid AND a.attnum=k.attnum
            WHERE a.attname IN ('status','candidate_diff','pr_url',
                                'actionable_since','snoozed_until')) = 5
       AND array_length(tg.tgattr::int[],1) = 5
  ) THEN
    DROP TRIGGER IF EXISTS error_groups_pending_action_guard_upd ON error_groups;
    CREATE TRIGGER error_groups_pending_action_guard_upd
      BEFORE UPDATE OF status, candidate_diff, pr_url, actionable_since, snoozed_until
      ON error_groups
      FOR EACH ROW EXECUTE FUNCTION error_groups_pending_action_guard();
  END IF;
END $$;

-- Backfill the PR statuses the 064 trigger never stamped. updated_at, not now():
-- a month-old PR must not present as a fresh ask on the day this lands.
UPDATE error_groups
   SET actionable_since = COALESCE(updated_at, now())
 WHERE status IN ('pr_created','pr_draft')
   AND actionable_since IS NULL;

-- Repair rows that left the extended set while no rule covered them. The status
-- list is spelled out rather than calling error_groups_action_class: the call
-- is unindexable and forces a per-row plpgsql invocation that detoasts
-- candidate_diff, inside the transaction that also holds this file's trigger
-- lock. The list is exactly the set for which that function returns non-NULL
-- and must be kept in step with it.
UPDATE error_groups
   SET actionable_since = NULL, snoozed_until = NULL
 WHERE status NOT IN ('awaiting_approval','needs_human','pr_created','pr_draft')
   AND (actionable_since IS NOT NULL OR snoozed_until IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_error_groups_actionable_cards
  ON error_groups (project_id, actionable_since)
  WHERE status IN ('awaiting_approval','needs_human','pr_created','pr_draft');

COMMIT;
