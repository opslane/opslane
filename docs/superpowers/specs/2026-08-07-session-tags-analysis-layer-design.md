# Session analysis: typed per-session facts, the v1 analysis layer

Status: draft for review (rev 2 — incorporates external review)
Date: 2026-08-07
Evidence: every design decision was validated against 34 production
sessions (491 chunks, five cohorts) pulled read-only from the production
instance on 2026-08-07, with the analyzers run as real code and the
adjudicator run as real model calls over real evidence windows. Visual
walkthrough: the "Session labels" artifact from the same session.

Rev 2 changes after review: typed one-row-per-session table replaces the
open-vocabulary tag table; digest attribution keyed to session
`started_at` (rebuild-safe); honest mechanical names
(`successful_write_count`, not "task-completed"; "same-origin", not
"first-party"); struggle stays solely in `friction_signals`; adjudication
keeps the per-signal interface and gains evidence windows; coverage is an
explicit tri-state owned by the analyzer; model-call caps and shadow
rollout added; `bounced`/`marathon` cut (the latter is derivable from
`sessions` alone).

## Problem

Always-on recording stores every session, but the analysis layer only
speaks about ~4% of them: sessions with an error event or a friction
signal. The friction detectors have a measured 6% acceptance rate after
LLM adjudication (form_abandon: 2 accepted of 975 adjudicated), and
their outputs are point events with no way to state a fact about a whole
session ("this was an idle embedded panel", "this session completed a
write"). The daily digest (CEO plan #4) has no substrate to read, and
investigation has no session-level context.

Production facts that constrain any design (measured 2026-08-07):

- 127,776 sessions in 14 days; one active project.
- 36% of sessions have zero replay chunks. 27% of error-linked sessions
  (775 of 2,833) have no replay. No analysis can see these; they must be
  a visible coverage bucket, and the SDK gap is a separate fix.
- 88% of sessions enter at `/issue-context` (embedded Jira panel);
  idle-panel traffic drowns every metric unless classified.
- 5.9% of sessions have an identified user. v1 counts sessions, not
  users.
- Telemetry coverage: request start/end pairs in 94% of sampled
  sessions, form_submit in 26%, clicks in 47%.
- Friction flag rate: 1.8% of prod sessions have any signal today
  (pre-suppression). The 12-of-34 rate in the sample is an artifact of
  stratified sampling, not a volume estimate.

## Decision summary

1. **The analyzer writes one typed facts row per session** at close —
   free, deterministic, mechanical facts only, in `session_analysis`.
2. **The LLM adjudicates only detector-flagged signals**, through the
   existing per-signal interface and gates, upgraded to read the real
   evidence window around each occurrence. Measured on prod: window
   verdicts overruled 4 of 12 shallow verdicts and produced
   2 confirmed / 3 uncertain / 7 rejected, each citing window events.
3. **The LLM never browses.** Unflagged sessions are never model-read.
   The digest is a template over SQL rollups (no LLM, per CEO plan #4).
   Deep e2e session reads happen only inside investigations, as today.

This matches PostHog (on-demand, pre-filtered, condensed events) and
LogRocket Galileo (deterministic detection + anonymized-count severity
model; LLM narrates only severe issues).

## The `session_analysis` table

One row per session; the analyzer is its sole writer (including empty
and no-replay sessions — the analysis job runs for every closed
session). Idempotent upsert; a late scrubbed chunk re-runs analysis and
upgrades the row in place. Nothing references this table by foreign key,
so rebuild is safe by construction.

```sql
CREATE TABLE session_analysis (
  session_id          TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id          UUID NOT NULL,
  environment_id      UUID,
  session_started_at  timestamptz NOT NULL,  -- copied from sessions; digest attribution key
  coverage            TEXT NOT NULL CHECK (coverage IN ('complete','partial','no_replay')),
  activity_class      TEXT NOT NULL CHECK (activity_class IN
                        ('active','light_touch','zero_interaction','idle_tab','unknown')),
  entry_path          TEXT,                  -- normalized; NULL when no_replay
  click_count         INTEGER NOT NULL DEFAULT 0,
  input_event_count   INTEGER NOT NULL DEFAULT 0,
  page_event_count    INTEGER NOT NULL DEFAULT 0,
  failed_request_4xx_count          INTEGER NOT NULL DEFAULT 0,  -- same-origin only
  failed_request_5xx_count          INTEGER NOT NULL DEFAULT 0,  -- same-origin only
  unattributed_failed_request_count INTEGER NOT NULL DEFAULT 0,  -- end with no recorded start
  successful_write_count            INTEGER NOT NULL DEFAULT 0,  -- same-origin POST/PUT/PATCH → 2xx
  failed_write_count                INTEGER NOT NULL DEFAULT 0,  -- same-origin write → ≥400
  rule_version        INTEGER NOT NULL,
  analyzed_at         timestamptz NOT NULL DEFAULT now()          -- audit only, never attribution
);
CREATE INDEX idx_session_analysis_rollup
  ON session_analysis (project_id, session_started_at);
```

Design points, each earned by the prod run or the review:

- **Typed columns, not tags.** v1's vocabulary is fixed and
  model-authored vocabulary is cut, so an open tag table would trade a
  small database interface for a large unconstrained product interface.
  A new concept requires a migration — deliberate review friction.
  (Act-two model annotations, if approved, get their own table with
  their own provenance; they do not retrofit into this one.)
- **`session_started_at` is the attribution key.** Rollups and
  week-over-week deltas group by it, never by `analyzed_at` — so
  re-analysis and the backfill cannot shift history into "today".
- **Raw counts are stored** so thresholds (the activity floor, a future
  `bounced`) can be re-cut in SQL without re-reading chunks.
- **Coverage is explicit.** `no_replay`: no playable (scrubbed,
  readable) evidence existed at analysis time — not merely
  `chunk_count = 0`. `partial`: the bounded reader truncated (20 MiB
  session cap) or some chunks were unreadable. `partial` and
  `no_replay` rows are excluded from behavioral digest denominators and
  reported as their own line. `activity_class = 'unknown'` whenever
  coverage is not `complete`… with one exception: a `complete` session
  with zero events is `zero_interaction`, not `unknown`.

### Fact semantics (mechanical, honestly named)

| fact | rule | sample result |
| --- | --- | --- |
| `activity_class` | `idle_tab`: span ≥ 10 min, 0 clicks + 0 inputs. `zero_interaction`: 0 + 0, shorter. `light_touch`: 1–2 interactions. `active`: ≥ 3 interactions (clicks + inputs). | 22 active / 10 zero-interaction / 2 idle-tab at the ≥1 floor; the ≥3 floor is a deliberate tightening so "active" means engagement |
| `entry_path` | first page event's pathname, normalized: strip query/hash, template numeric and uuid segments to `:id`, strip `_ctx_*` Forge blobs | without `_ctx` stripping, 429 prod sessions produce garbage rows |
| failed request counts | request_end status ≥ 400 whose request_start URL is **same-origin** with the session's observed page origins; cross-origin excluded (the dead Defender SDK and CDN beacons produced 8 of 11 naive positives); an end with no recorded start increments `unattributed_failed_request_count` (observed: panel-bootstrap 401s whose start predates recording) | 3 sessions with same-origin failures after the split |
| write counts | same-origin POST/PUT/PATCH by result status. **Named `successful_write_count`, not "task completed"** — a 2xx write may be an autosave or preference update; task semantics require product-specific flow definitions, which v1 cuts | 9 sessions with successful writes, incl. checkout POST → 201 |

Not in the table: struggle (owned by `friction_signals`, below);
`marathon` (derivable as `last_chunk_at - started_at` from `sessions` by
any consumer, no analyzer needed); `bounced` (re-enters when a consumer
names it; its inputs are already stored as raw counts).

## Friction detection: what changes, what stays

**Kept — point-signal detection.** `rage_click` and `dead_click` stay in
`analyzeSession`, gaining four suppressions that fix the measured
false-positive sources at the origin:

1. Clicks on `cursor: text` targets never count (focus/select-all
   clicking; two prod rage_clicks were this).
2. A dead-click candidate answered by an option-select
   (`#react-select-*-option-*` or `[role=option]`) within 5s is
   suppressed.
3. Synthetic clicks on programmatically-created download anchors
   (`body > a` fired ≤ 50ms after a real click) are excluded — found in
   the export flow.
4. React-select index reuse can alias distinct chips to one selector
   (`-N-remove`); fingerprints for `react-select`-generated ids use the
   widget container, not the indexed id.

`friction_signals` remains the sole store and source of truth for
struggle. Session-level struggle counts are derived by consumers from
accepted signals (the session ledger already does exactly this). New
schema requirement: signals record **per-occurrence timestamps**
(`occurred_ats` JSONB), because evidence windows must center on each
occurrence — the fold's min-timestamp put windows 20 minutes early in
the prod run.

**Retired — `form_abandon`.** Measured acceptance 2 of 975 (0.2%); in
the deep run both remaining candidates were unadjudicable inline-edit
focus clicks. The detector stops producing signals at the new
RULE_VERSION. Mechanical replacements: `failed_write_count` (exact) and
the absence of successful writes in an `active` session (digest-visible).
Historical rows remain; the enum keeps the value.

**Upgraded — adjudication input only.** The per-signal interface, the
generation/threshold machinery, the eager error-fold path, and promotion
semantics (fingerprint identity, 5 users / 7 days) are all unchanged —
per-session batched verdicts are deferred until measured cost justifies
their state machinery. Two changes:

1. **Input**: the adjudicator receives the ±15s condensed event window
   around each flagged occurrence (clicks with selector+cursor, request
   start/end pairs, page events, form_submits) instead of the selector
   string alone. Windows center on the occurrence; click/submit events
   are always retained when trimming; chunks are fetched by the
   occurrence's time range via existing `first_event_ms`/`last_event_ms`
   metadata. Verdicts must cite window events. Measured effect: window
   verdicts overruled 4 of 12 shallow judgments.
2. **Uncertain maps to rejected.** The run produced 3 windows with
   genuinely insufficient evidence. The persisted state machine keeps
   its four states; an uncertain verdict is stored as `rejected` with
   `adjudication_reason = 'uncertain'` — same surfacing (none), the
   distinction preserved for threshold tuning, no migration.

**Cost and rollout guards** (new): a per-project daily adjudication-call
cap (default 500) with overflow left `pending` for the next day's
budget; a feature flag for window-input adjudication with a shadow mode
that logs the would-be verdict while the selector-only path still
decides; the backfill runs rate-limited behind the same cap; call
counts and verdict distribution are logged per project per day.

**Prerequisite repair — re-analysis.** Bumping RULE_VERSION today
double-counts: v2 signal rows insert alongside still-active v1 rows
because `superseded_by` is written by no code path. Before the new
RULE_VERSION ships: re-analysis marks prior-version rows
`superseded_by` (as the 2026-07-13 design specified), and a one-time
rate-limited backfill re-analyzes retained sessions (30-day window) so
facts rows and corrected signals exist historically — attribution by
`session_started_at` makes this safe for trends by construction.

## Consumers

**Daily digest (CEO plan #4).** A template over SQL rollups; no LLM.
Per project, per `session_started_at` day: sessions by coverage bucket;
activity-class distribution over `coverage = 'complete'` sessions only;
`successful_write_count` totals; adjudication-accepted struggle sessions
(from `friction_signals`, joined to `sessions` for the day and to
`session_analysis.entry_path` for grouping); same-origin failed-request
sessions by status class; deltas vs the trailing 7-day mean once history
exists. Template lines render only above thresholds. Delivery mechanics
(Slack wiring, scheduling) are the digest plan's scope.

**Session ledger.** Chips derived from the typed columns (coverage,
activity class, failure counts). Existing accepted-signal badges
unchanged (already derived from `friction_signals`).

**Investigation.** Reads the pointed session's `session_analysis` row
for context ("error in an active `/getting-started` session with 6
same-origin failures") and may say so in the PR narrative.

**Keyless self-host.** Every fact is mechanical and fully visible
without an API key. Detected-but-unadjudicated signals surface as
"unverified" via a UI query over `pending` signals (today they are
silently invisible keyless).

## Explicitly cut (re-entry requires a new decision)

- Open-vocabulary and model-minted annotations (future table if approved)
- Per-session batched adjudication verdicts
- Anomaly detection / statistical outlier flagging
- Periodic LLM sweeps over unlabeled sessions
- AI-authored per-app flow vocabulary (semantic task names)
- `bounced`, `marathon` (derivable; no consumer yet)
- Refresh-burst detection (naive rule false-fired on 20/34 sample
  sessions — chunk boundaries re-emit page events; needs a proven
  navigation discriminator)
- Latency/slow-request facts (durations derivable via requestId join,
  no baselines yet)
- @opslane Q&A (act two; queries this same table)

## Verification

- Unit: golden tests per fact over synthetic envelopes shaped like the
  five prod cohorts (idle panel, checkout, marathon, bounce,
  failed-bootstrap). Prod data itself must not enter the repo.
- The existing analyzer bench gate (p95 < 5s) must hold with fact
  extraction added.
- Suppression regression tests: cursor-text click, answered
  option-select, synthetic download anchor, react-select reindex.
- Coverage: truncated-read session asserts `partial` and
  `activity_class = 'unknown'`; unscrubbed-chunks-only session asserts
  `no_replay`; late-chunk re-analysis upgrades the row in place.
- Re-analysis: bump RULE_VERSION in a test; assert prior signals are
  superseded, facts rows upserted without duplication, and a
  yesterday-started session backfilled today attributes to yesterday.
- Live smoke per AGENTS.md: seeded session with a scripted timeline →
  close → assert the exact expected `session_analysis` row; keyless run
  → assert facts present and pending signals shown as unverified.

## Constraints stated honestly

- v1 counts sessions, not users (5.9% identified).
- 36% of sessions are `no_replay`; the digest reports the bucket; the
  SDK coverage gap (status-0 event POSTs inside Jira iframes were
  observed) is a separate issue to file.
- Struggle precision after suppressions was 2 confirmed + 3 uncertain
  of 12 flagged on the stratified sample — the adjudicator is not
  optional for struggle; prod flag volume (~1.8% pre-suppression) is
  the planning number, not the sample rate.
- Digest numbers come from a one-project instance; a second production
  project may move thresholds.
