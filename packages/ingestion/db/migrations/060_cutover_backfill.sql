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
-- adopted issues later turn out to be one problem, settlement records an
-- issue_alias_conflicts row and identity.ConfirmMerge resolves it under audit.
-- That path refuses to merge an issue carrying observations without settled
-- identity, which is why step 3 settles every historical event and not just
-- recent ones.
--
-- Reapply-safe: run-migrations.sh replays every file on every start, so each
-- statement is guarded and re-running changes nothing.

-- 1. One episode per existing issue.
--
-- Resolved groups get an episode that is opened and immediately closed, so
-- their history exists and their observations have an episode to hang from,
-- while idx_one_open_episode still sees no open round for them. A recurrence
-- after cutover opens sequence 2, which is what makes the card read as returned
-- rather than new.
INSERT INTO issue_episodes (project_id, canonical_issue_id, sequence, opened_at, closed_at)
SELECT g.project_id,
       g.id,
       1,
       g.first_seen,
       CASE WHEN g.status = 'resolved'
            THEN COALESCE(g.resolved_at, g.updated_at)
       END
  FROM error_groups g
ON CONFLICT (project_id, canonical_issue_id, sequence) DO NOTHING;

-- 2. Bind each issue's fingerprint as its own alias.
--
-- confirmed_by = 'exact' because this is not a judgement call: the fingerprint
-- is the key the group was already stored under. identity_version must track
-- identity.IdentityVersion in packages/ingestion/identity/canonical.go; bump
-- both together or settled observations stop matching their aliases.
INSERT INTO canonical_issue_fingerprints
  (project_id, fingerprint, fingerprint_kind, canonical_issue_id, identity_version, confirmed_by)
SELECT g.project_id,
       g.fingerprint,
       CASE WHEN g.kind = 'error' THEN 'raw' ELSE 'friction' END,
       g.id,
       2,
       'exact'
  FROM error_groups g
ON CONFLICT (project_id, identity_version, fingerprint) DO NOTHING;

-- 3. Settle every historical observation onto the issue it already belongs to.
--
-- resolved_fingerprint stays NULL: these events were captured before stack
-- resolution existed and were never source-mapped. Recording a resolved
-- fingerprint we never computed would bind an alias on a guess.
--
-- Status 'settled' keeps the settler's pending sweep away from them. The filter
-- counts affected units over a seven-day window, so adopting full history does
-- not inflate reach; it only lets an issue's real recent activity be seen.
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
  JOIN issue_episodes ep
    ON ep.project_id = g.project_id
   AND ep.canonical_issue_id = g.id
   AND ep.sequence = 1
 WHERE e.error_group_id IS NOT NULL
ON CONFLICT (project_id, event_id) DO NOTHING;

-- 4. Receipts, so adopted issues are not introduced as new.
--
-- The digest publishes an episode once per channel. Marking every adopted
-- episode as already published on the digest channel means the first daily
-- message after cutover reports new and returned work only. When an adopted
-- issue recurs after being resolved, sequence 2 opens with no receipt and the
-- customer hears about it again, correctly labelled as returned.
INSERT INTO issue_publications (project_id, episode_id, channel)
SELECT ep.project_id, ep.id, 'digest'
  FROM issue_episodes ep
 WHERE ep.sequence = 1
ON CONFLICT (project_id, episode_id, channel) DO NOTHING;
