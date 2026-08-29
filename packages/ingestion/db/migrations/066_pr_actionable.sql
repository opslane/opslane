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
-- The rule: within one action class, no legitimate caller erases the waiting
-- age of a row that is still waiting, so a statement that does is a stale bulk
-- repair and both columns are restored. Clearing ONLY snoozed_until stays
-- legitimate — that is how the snooze endpoint un-snoozes an incident.
CREATE OR REPLACE FUNCTION error_groups_hold_pending_action(
  was_class TEXT, is_class TEXT,
  new_since TIMESTAMPTZ, new_snooze TIMESTAMPTZ,
  old_since TIMESTAMPTZ, old_snooze TIMESTAMPTZ,
  OUT held_since TIMESTAMPTZ, OUT held_snooze TIMESTAMPTZ
) AS $$
BEGIN
  held_since := new_since;
  held_snooze := new_snooze;
  IF is_class IS NULL OR was_class IS DISTINCT FROM is_class THEN
    RETURN;
  END IF;
  IF new_since IS NULL THEN
    held_since := COALESCE(old_since, now());
    held_snooze := COALESCE(new_snooze, old_snooze);
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
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS error_groups_pending_action_guard_upd ON error_groups;
CREATE TRIGGER error_groups_pending_action_guard_upd
  BEFORE UPDATE OF status, candidate_diff, pr_url, actionable_since, snoozed_until
  ON error_groups
  FOR EACH ROW EXECUTE FUNCTION error_groups_pending_action_guard();

-- Backfill the PR statuses the 064 trigger never stamped. updated_at, not now():
-- a month-old PR must not present as a fresh ask on the day this lands.
UPDATE error_groups
   SET actionable_since = COALESCE(updated_at, now())
 WHERE status IN ('pr_created','pr_draft')
   AND actionable_since IS NULL;

-- Repair rows that left the extended set while no rule covered them.
UPDATE error_groups
   SET actionable_since = NULL, snoozed_until = NULL
 WHERE error_groups_action_class(status::text, candidate_diff, pr_url) IS NULL
   AND (actionable_since IS NOT NULL OR snoozed_until IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_error_groups_actionable_cards
  ON error_groups (project_id, actionable_since)
  WHERE status IN ('awaiting_approval','needs_human','pr_created','pr_draft');

COMMIT;
