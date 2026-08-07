# Session tags: the v1 session-analysis layer

Status: draft for review
Date: 2026-08-07
Evidence: every design decision here was validated against 34 production
sessions (491 chunks, five cohorts) pulled read-only from the production
instance on 2026-08-07, with the taggers run as real code and the
adjudicator run as real model calls over real evidence windows. Visual
walkthrough: the "Session labels" artifact from the same session.

## Problem

Always-on recording stores every session, but the analysis layer only
speaks about ~4% of them: sessions with an error event or a friction
signal. The friction pipeline's three detectors have a measured 6%
acceptance rate after LLM adjudication (form_abandon: 2 accepted of 975
adjudicated), and its outputs are point events with no way to state a
fact about a whole session ("this was an idle embedded panel", "this
session completed a checkout"). The daily digest (CEO plan #4) has no
substrate to read, and investigation has no session-level context.

Production facts that constrain any design (measured 2026-08-07):

- 127,776 sessions in 14 days; one active project.
- 36% of sessions have zero replay chunks. 27% of error-linked sessions
  (775 of 2,833) have no replay. No analysis can see these; they must be
  a visible bucket, and the SDK coverage gap is a separate fix.
- 88% of sessions enter at `/issue-context` (embedded Jira panel);
  idle-panel traffic drowns every metric unless labeled.
- 5.9% of sessions have an identified user. v1 counts sessions, not
  users. The priority score's "affected users" input is weak until
  identification improves.
- Telemetry coverage: request start/end pairs in 94% of sampled
  sessions, form_submit in 26%, clicks in 47%.

## Decision summary

Three tiers, each validated on the production sample:

1. **Rules label every session** at close — free, deterministic,
   session-level tags in one new table. Eight taggers (below).
2. **The LLM adjudicates only rule-flagged sessions**, one small call
   per flagged session, reading the real ±15s event window around the
   flagged clicks. Measured on prod: 34 sessions → 12 flagged →
   2 confirmed / 3 uncertain / 7 rejected, every verdict citing window
   events. Uncertain does not surface.
3. **The LLM never browses.** Unflagged sessions are never model-read.
   Digest is a template over tag counts (no LLM, per CEO plan #4).
   Deep e2e session reads happen only inside investigations, as today.

This matches PostHog (on-demand, pre-filtered, condensed events) and
LogRocket Galileo (deterministic detection + anonymized-count severity
model; LLM only narrates severe issues).

## The `session_tags` table

```sql
CREATE TABLE session_tags (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL,
  tag          TEXT NOT NULL,          -- open vocabulary, no CHECK enum
  value        INTEGER,                -- optional count (struggled-with-form → 8)
  source       TEXT NOT NULL DEFAULT 'rule',   -- 'rule' | 'model' (model unused in v1)
  evidence     JSONB,                  -- what fired the rule, human-readable
  rule_version INTEGER NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX idx_session_tags_rollup ON session_tags (project_id, tag, created_at);
```

Two deliberate choices:

- **Open vocabulary.** `tag` is TEXT with no CHECK constraint. The
  triple-hardcoded `signal_type` enum (SQL CHECK + two TS unions) is the
  reason adding a fourth signal type today requires a migration; tags
  must not repeat that.
- **Tags are rebuilt, not versioned.** Re-analysis DELETEs and
  re-INSERTs a session's tags in one transaction. Tags are derived data
  with no foreign keys into them; rebuilding sidesteps the
  superseded_by machinery entirely. `rule_version` is recorded for
  audit only. (`friction_signals` cannot take this shortcut — incidents
  reference signals — so it keeps its versioning, repaired below.)

## The eight v1 taggers

All run inside the existing `session_analysis` job after
`analyzeSession`, on data already decoded. All were run against the
production sample; verdicts and counts below are measured.

| tag | rule | sample result |
| --- | --- | --- |
| activity class (one of `idle-tab`, `zero-interaction`, `light-touch`, `active`) | `idle-tab`: span ≥ 10 min, 0 clicks + 0 inputs. `zero-interaction`: 0 + 0, shorter. `light-touch`: 1–2 interactions. `active`: ≥ 3 interactions. | 22 active / 10 zero-interaction / 2 idle-tab (with the ≥1 floor; the ≥3 floor is a deliberate tightening so digest "active" means engagement) |
| `entry:<path>` | first page event's pathname, normalized: strip query/hash, template numeric and uuid segments to `:id`, strip `_ctx_*` Forge blobs | 34/34; without `_ctx` stripping, 429 prod sessions produce garbage rows |
| `failed-requests` (value = n) | request_end status ≥ 400 whose request_start URL is first-party; third-party (observed page origins define first-party) excluded; ends with no matching start count as unattributed | 3 sessions — after the split removed 8 false ones (dead Defender SDK, CDN beacons) |
| `task-completed` (value = n) | first-party POST/PUT/PATCH → 2xx | 9 sessions, incl. checkout POST → 201 |
| `form-submit-failed` | first-party write → ≥ 400 | 0 in sample |
| `struggled-with-form` (value = n) | dead/rage click signals after suppressions (below), rolled up per session | 12 flagged → adjudicated 2 / 3 / 7 |
| `bounced` | span < 60s, ≤ 2 page events, ≤ 1 click, no successful write | 4 |
| `marathon-session` | event span > 2h | 1 (6.4h) |
| `no-replay` | chunk_count = 0 at close (written by the closer, not the analyzer — there is nothing to analyze) | 36% of prod |

Detector suppressions (these fix the measured 94% false-positive rate at
the source):

1. Clicks on `cursor: text` targets never count as rage/dead clicks
   (focus / select-all clicking; two prod rage_clicks were this).
2. A dead-click candidate answered by an option-select
   (`#react-select-*-option-*` or `[role=option]`) within 5s is
   suppressed.
3. Synthetic clicks on programmatically-created download anchors
   (`body > a` fired ≤ 50ms after a real click) are excluded — found in
   the export flow.
4. React-select index reuse can alias distinct chips to one selector
   (`-N-remove`); fingerprints for `react-select`-generated ids use the
   widget container, not the indexed id.

## Superset of friction detection: what changes, what stays

This layer does not sit beside the friction pipeline; it subsumes it.
The existing pipeline is stage-by-stage either kept, upgraded, or
retired:

**Kept — point-signal detection (`analyzeSession`).** `rage_click` and
`dead_click` detection stays, with the four suppressions. Signals remain
the point-event evidence that the `struggled-with-form` tag rolls up;
`friction_signals` remains their store, and incidents keep referencing
them. New requirement: signals must record **per-occurrence
timestamps** (new JSONB column `occurred_ats`), because the adjudicator
needs windows centered on each occurrence — the fold currently keeps
only the min timestamp, which placed evidence windows 20 minutes early
in the prod run.

**Retired — `form_abandon`.** Measured acceptance 2 of 975 (0.2%); in
the deep run both remaining candidates were unadjudicable inline-edit
focus clicks. The detector stops producing signals at the new
RULE_VERSION. Its replacements are mechanical: `form-submit-failed`
(exact) plus `task-completed` (its absence in an `active` session on a
form page is digest-visible). Historical rows remain; the enum keeps the
value.

**Upgraded — adjudication.** Same gate, same generation/threshold
machinery, same prompt-version discipline; two changes:

1. **Input**: the adjudicator receives the ±15s condensed event window
   around each flagged occurrence (clicks with selector+cursor, request
   start/end pairs, page events, form_submits) instead of the selector
   string alone. Windows are centered on the occurrence and
   click/submit events are always retained when the window is trimmed.
   Chunks are fetched by the occurrence's time range via existing
   `first_event_ms`/`last_event_ms` metadata. Verdicts must cite window
   events; a third verdict `uncertain` is allowed and does not surface.
   Measured effect: the window-based verdicts overruled 4 of the
   shallow story-based judgments in the prod run — evidence beats vibes.
2. **Unit**: one call per flagged session (covering all its windows),
   not one call per signal. The eager per-signal fold path is removed;
   the ±30s error-fold *attach* logic (pure SQL) stays.

**Unchanged — promotion and incidents.** Fingerprint identity,
5-users-in-7-days threshold, `error_groups` with `kind='friction'`,
autonomy ladder, insight cards, PR dedup interplay: untouched. Tags do
not promote; only adjudicated signals do, exactly as today.

**Unchanged — investigation deep reads.** Error and friction
investigations keep their evidence paths; they additionally read the
session's tags for context ("this error occurred in an
`entry:/getting-started` `struggled-with-form` session") and the PR
description may say so.

**Prerequisite repair — re-analysis.** Bumping RULE_VERSION today
double-counts: v2 signal rows insert alongside still-active v1 rows
because `superseded_by` is written by no code path. Before the new
RULE_VERSION ships: re-analysis marks prior-version rows
`superseded_by` (as the 2026-07-13 design specified), and a one-time
backfill job re-analyzes retained sessions (30-day window) so tags and
corrected signals exist historically — this also seeds week-over-week
trends on day one.

## Consumers

**Daily digest (CEO plan #4).** A template over tag-count queries; no
LLM. Data contract (per project, per day): sessions by activity class;
`no-replay` count; `task-completed` count; confirmed
`struggled-with-form` sessions (adjudication-accepted only) grouped by
entry path with counts; `failed-requests` sessions grouped by status
class; deltas vs the trailing 7-day mean once history exists. Template
lines render only above thresholds (no "0 friction today" noise).
Delivery mechanics (Slack wiring, scheduling) are the digest plan's
scope, not this spec's.

**Session ledger.** Tag chips on the session row (activity class +
notable tags). Existing accepted-signal badges unchanged.

**Investigation.** `getSessionForAnalysis`-style read of
`session_tags` for the pointed session; included in investigation
context and PR narrative.

**Keyless self-host.** Every tag except `struggled-with-form` is
mechanical and fully visible without an API key. `struggled-with-form`
without an adjudicator shows as "unverified" instead of being invisible
(today's behavior: detected friction is silently hidden keyless).

## Explicitly cut (re-entry requires a new decision)

- Anomaly detection / statistical outlier flagging
- Periodic LLM sweeps over unlabeled sessions
- AI-authored per-app tag vocabulary (semantic flow names)
- Model-minted tags (`source='model'` is reserved, unused)
- Per-session LLM reads outside adjudication and investigation
- Refresh-burst tagger (naive rule false-fired on 20/34 sample sessions
  because chunk boundaries re-emit page events; needs a proven
  navigation discriminator first)
- Latency/slow-request tagger (durations derivable via requestId join,
  no baselines yet)
- @opslane Q&A (act two; it will query this same table)

## Verification

- Unit: golden tests per tagger over synthetic envelopes shaped like
  the five prod cohorts (idle panel, checkout, marathon, bounce,
  failed-bootstrap). Prod data itself must not enter the repo.
- The existing analyzer bench gate (p95 < 5s) must hold with taggers
  added.
- Suppression regression tests: cursor-text click, answered
  option-select, synthetic download anchor, react-select reindex.
- Re-analysis: bump RULE_VERSION in a test, assert prior signals are
  superseded and tags are rebuilt without duplication.
- Live smoke per AGENTS.md: seeded session with a scripted timeline →
  close → assert exact expected tag rows; keyless run → assert
  mechanical tags present and struggled-with-form marked unverified.

## Constraints stated honestly

- v1 counts sessions, not users (5.9% identified).
- 36% of sessions are `no-replay`; the digest reports the bucket, and
  the SDK coverage gap (status-0 event POSTs inside Jira iframes were
  observed in the sample) is a separate issue to file.
- `struggled-with-form` precision after suppressions was 2 confirmed +
  3 uncertain of 12 flagged on the sample — the adjudicator is not
  optional for this tag.
- Digest numbers scale from a one-project instance; a second production
  project may move the thresholds.
