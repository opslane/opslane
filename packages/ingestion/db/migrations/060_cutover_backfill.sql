-- Cutover backfill: adopt the pre-rewrite world into the pipeline's tables.
--
-- Before this runs, every issue in the product is an error_groups row keyed on
-- a raw fingerprint, and no observation has an identity. The new pipeline reads
-- issues through issue_episodes, canonical_issue_fingerprints, and
-- error_event_identities. Without this file the settler would mint a second,
-- parallel canonical issue for every problem that already exists, and the daily
-- message would introduce months-old issues to the customer as new.
--
-- canonical_issue_id is a foreign key onto error_groups(id), so adoption is not
-- a copy: an existing group already *is* its canonical issue. This file only
-- builds the rows that point at it.
--
-- Deliberately merges nothing. Each group keeps its own identity, which is the
-- plan's "uncertain clusters stay split" default taken all the way. Where two
-- adopted error issues later turn out to be one problem, settlement records an
-- issue_alias_conflicts row and identity.ConfirmMerge resolves it under audit.
-- That path refuses to merge an issue carrying observations without settled
-- identity, which is why step 2 settles every historical event and not just
-- recent ones. (ConfirmMerge also refuses any group with kind <> 'error', so
-- adopted friction issues cannot be merged by anyone; nothing here changes
-- that.)
--
-- Reapply-safe: run-migrations.sh replays every file on every start, so each
-- statement is guarded and re-running changes nothing.

-- 1. One episode per existing issue, plus a digest receipt for the rounds this
--    statement actually adopts.
--
-- The receipt has to be tied to the episodes inserted *by this run*, which is
-- why it is a data-modifying CTE rather than a second statement. A standalone
-- INSERT over "every sequence-1 episode" would restamp on every service start,
-- and since digest.FreezeCandidates skips any episode that already has a
-- publication row, a genuinely new issue whose first round had not yet been
-- published would be suppressed from the daily message permanently. On reapply
-- the ON CONFLICT below inserts nothing, RETURNING yields nothing, and no
-- receipt is written.
--
-- Terminal issues get a round that is opened and closed at once, so their
-- history exists and their observations have an episode to hang from, while
-- idx_one_open_episode still sees no open round for them. 'resolved', 'merged',
-- and 'archived' are all terminal to the dispatcher; closing only 'resolved'
-- would leave archived issues looking live. A recurrence after cutover opens
-- sequence 2, which is what makes the card read as returned rather than new.
WITH adopted AS (
  INSERT INTO issue_episodes (project_id, canonical_issue_id, sequence, opened_at, closed_at)
  SELECT g.project_id,
         g.id,
         1,
         g.first_seen,
         CASE WHEN g.status IN ('resolved', 'merged', 'archived')
              THEN COALESCE(g.resolved_at, g.updated_at)
         END
    FROM error_groups g
  ON CONFLICT (project_id, canonical_issue_id, sequence) DO NOTHING
  RETURNING project_id, id
)
INSERT INTO issue_publications (project_id, episode_id, channel)
SELECT project_id, id, 'digest' FROM adopted
ON CONFLICT (project_id, episode_id, channel) DO NOTHING;

-- 2. Settle every historical observation onto the issue it already belongs to.
--
-- resolved_fingerprint stays NULL: these events were captured before stack
-- resolution existed and were never source-mapped. Recording a resolved
-- fingerprint we never computed would bind an alias on a guess.
--
-- Status 'settled' keeps the settler's pending sweep away from them. The filter
-- counts affected units over a seven-day window, so adopting full history does
-- not inflate reach; it only lets an issue's real recent activity be seen.
--
-- The join carries project_id on both sides. The two foreign keys are checked
-- independently, so a legacy event pointing at another project's group would
-- otherwise write an identity that straddles two tenants.
INSERT INTO error_event_identities
  (project_id, event_id, status, canonical_issue_id, raw_fingerprint,
   identity_version, episode_id, settled_at)
SELECT e.project_id,
       e.id,
       'settled',
       g.id,
       g.fingerprint,
       2,
       ep.id,
       e.created_at
  FROM error_events e
  JOIN error_groups g
    ON g.id = e.error_group_id
   AND g.project_id = e.project_id
  JOIN issue_episodes ep
    ON ep.project_id = g.project_id
   AND ep.canonical_issue_id = g.id
   AND ep.sequence = 1
 WHERE e.error_group_id IS NOT NULL
ON CONFLICT (project_id, event_id) DO NOTHING;

-- 3. Bind each issue's fingerprint as its own alias.
--
-- confirmed_by = 'exact' because this is not a judgement call: the fingerprint
-- is the key the group was already stored under.
--
-- Merged groups are skipped. Settlement locks the canonical issue and aborts
-- when it finds status 'merged', so binding a merged loser's fingerprint would
-- stall every future observation that matches it. The old world carries no
-- pointer to the winner, so the honest outcome is to leave the fingerprint
-- unbound and let a recurrence open a fresh issue.
--
-- identity_version is pinned at 2 to match identity.IdentityVersion at the time
-- of cutover. Do not edit this literal later: a version change needs its own
-- migration, or already-adopted aliases would silently stop matching.
INSERT INTO canonical_issue_fingerprints
  (project_id, fingerprint, fingerprint_kind, canonical_issue_id, identity_version, confirmed_by)
SELECT g.project_id,
       g.fingerprint,
       CASE WHEN g.kind = 'error' THEN 'raw' ELSE 'friction' END,
       g.id,
       2,
       'exact'
  FROM error_groups g
 WHERE g.status <> 'merged'
ON CONFLICT (project_id, identity_version, fingerprint) DO NOTHING;
