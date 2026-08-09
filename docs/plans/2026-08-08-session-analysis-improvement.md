# Session analysis: accuracy and usability

Status: DRAFT, revised twice after Codex review
Date: 2026-08-08
Evidence: read-only production spikes (`~/deploy/scripts/prod-sql.sh`), 30-day
window ending 2026-08-08, single project. Competitive research: PostHog,
OpenReplay, Sentry, Lucent. Review: two Codex rounds. Round 1 rejected the first
draft's central diagnosis; round 2 corrected the measurement unit, the retirement
mechanism, and the ship order. Both are reflected below.

## Summary in plain terms

We record 130,000 sessions a month and analyze 1,000 of them. Of the findings we
produce, our own model rejects 98%. The first draft of this plan blamed timing:
we ask the model at the moment a bucket crosses five users, so it always sees
exactly five. That was wrong, and the truth is worse.

A rejected verdict permanently removes those five users from the bucket's
evidence pool. The bucket refills from zero, hits five again, and asks the
identical question. One button on one page went through this **68 times** and
was rejected all 68 times, each time for "only 5 users."

We are not running a detector badly. We are asking the same question 68 times
and never once showing the model what it already learned.

## What production actually looks like

30 days to 2026-08-08 unless noted.

### Volume and recording

| Measure | Value |
| --- | --- |
| Sessions | 129,920 |
| Projects producing sessions | 1 |
| Identified end users | 405 |
| Sessions with no `end_user_id` | 122,377 (94%) |
| Sessions with zero chunks | 47,095 (36.2%) |
| Sessions with one chunk or fewer | 54.7% |
| Median chunk count | 1 |
| Daily volume range | 1,401 to 17,038 |

### Analysis coverage

`session_analysis` holds 1,076 rows. The first was written 2026-08-08 05:24 UTC,
about eleven hours before these spikes; the backfill has never run and 128,786
sessions await it. Every fact-derived number below therefore describes an
eleven-hour, non-random slice.

Of 801 sessions with complete coverage: 18 `active`, 4 `light_touch`, 582
`zero_interaction`, 197 `idle_tab`. Real activity in 2.7%.

### The friction funnel

| Stage | Count |
| --- | --- |
| Friction signals | 3,538 |
| Signals at retired rule version 1 | 3,530 |
| Signals currently eligible (active, pending, identified user) | 814 |
| Distinct buckets | 648 |
| Buckets ever reaching 5 distinct users | 69 |
| Adjudication generations | 231 |
| **Distinct generation tuples behind them** | **50** |
| **Max generations on one tuple** | **68** |
| Median generations per tuple | 1 |
| Accepted / rejected generations | 5 / 226 |
| Friction incidents | 524 (360 archived, 161 candidate, 3 insight) |

The tuple is `(project, environment, fingerprint, rule_version, prompt_version)`,
which is the unit the durable generation index actually uses. Grouping at that
grade rather than by bare fingerprint changes nothing here: all 231 generations
are `rule_version 1`, `prompt_version 1`, in a single environment out of seven.
The 50 and the 68 hold.

Per-rule rejection: `form_abandon` 982/984 (99.8%), `dead_click` 740/788
(93.9%), `rage_click` 157/197 (79.7%).

### The mechanism

`countEligibleUsers` (promotion-db.ts:322) and `listEligibleSignals`
(promotion-db.ts:100) both select only `adjudication_status = 'pending'`.
`applyBucketOutcome` turns those rows terminal when the verdict lands.
`uq_friction_generation_inflight` blocks only concurrent `adjudicating` rows, so
nothing stops the next round.

So a rejection deletes five users' worth of evidence from all future counting.
The bucket cannot accumulate. It refills, crosses five again, and presents the
same minimal case. That is why 231 generations sit on 50 tuples and why one tuple
carries 68.

The model's complaint ("only 5 occurrences across 5 distinct users in 7 days is
too low-volume") is not an error on its part. It is an accurate description of
what we hand it, every single time, regardless of how much evidence the bucket
has actually seen.

One nuance: "refills from zero" is conceptually right but not transactionally
exact. Signals arriving between listing and verdict stay pending and carry over.

Corollary on framing: "98% of findings rejected" is wrong. It is 226 rejected
*generations* over ~50 findings, one of which was rejected 68 times.

### Three defects found while checking this

**1. Bucket eligibility ignores rule version.** The fingerprint is
`sha256(signalType | selector | pageUrl)` (fingerprint.ts:38), no rule version in
it. `findValidAcceptedGeneration` filters `rule_version` and `prompt_version`
(promotion-db.ts:378); `countEligibleUsers` and `listEligibleSignals` do not. So
signals from different detector generations count toward one threshold while the
generation is stamped with whichever version triggered it.

Blast radius measured at the correct grade: **2 buckets** today. It grows as rule
version 2 accumulates, but see defect note below on how much the backfill
actually changes that.

**2. The prompt has no acceptance rubric.** `buildAdjudicationPrompt`
(adjudicator.ts:38) asks whether the detection "reflects a real user-facing
problem" and hands over `bucket: {distinctUsers, totalOccurrences, windowDays}`.
It never says that five distinct users is our own significance bar, already
cleared. So the model invents a bar, and the one it invents is higher than ours.

**3. Anonymous traffic cannot produce findings.** `countEligibleUsers` requires
`end_user_id IS NOT NULL` and 94% of sessions have none. Friction in signed-out
flows (signup, pricing, checkout entry) is structurally invisible.

### What the backfill actually does to rule version 1

`persist.ts:66` already supersedes v1 rows that have a v2 replacement and
retracts any remaining v1 rows for that session. So re-analysis is itself the
retirement mechanism for signals, per session, automatically. The bulk
`superseded_by` update proposed in the first draft is unnecessary and would have
been wrong.

What re-analysis does **not** clean up: accepted v1 generations (which can still
be inherited via `valid_until`), and the materialized incident counts on
`error_groups`. Those need an explicit policy, and that is the actual v1
retirement work.

### Signal we collect and never use

Of 1,076 analyzed sessions: 122 unattributed failed requests, 48 with 4xx, 15
with successful writes, 1 with a failed write, **0 with 5xx**.

No detector consumes any of it. Whether the 5xx zero is an extraction bug is
genuinely unknown: across an eleven-hour non-random slice, a true session-level
5xx rate under roughly 0.3% yields zero observations with nothing broken.
`unattributed > 4xx` is likewise not proof of a bug, since aborts, transport
failures, and opaque cross-origin responses legitimately land there. Item 4 is
the experiment that settles it.

### Errors and friction barely overlap

2,834 sessions had an error, 2,341 had a friction signal, 795 had both. 99.9% of
error events (7,422 of 7,431) carry a session id. Caveat: "an error somewhere in
the same session" is not evidence the error was near the flagged interaction. No
temporal proximity has been measured.

### Usability

`ListSessions` orders strictly by `started_at DESC` (sessions_read.go:137).
Filters: end user, account, environment, search, date, `has_signals`. No filter
on `activity_class` or `coverage`, though both are in the response. With 62,193
sessions in 7 days at 2.7% activity, page 1 is about 49 untouched tabs in 50.

## What the research says others do

- **The heuristic layer is commodity and published.** Sentry: 3+ clicks on a
  `button`, `input`, or `a` within 7 seconds, no DOM update or scroll. PostHog:
  click an interactive-looking element, watch for DOM change or scroll.
  OpenReplay ships ~8 detectors including bad request, missing images, JS errors,
  high memory, high CPU. We have 2.
- **Everyone ships per-element opt-out.** PostHog `.ph-no-rageclick` and a
  `capture_dead_clicks` kill switch; Sentry `slowClickIgnoreSelectors`. Ours are
  hardcoded and customers cannot extend them.
- **PostHog analyzes the event stream rather than rendering the video**, and says
  so for speed reasons. That is a point in favor of the approach our facts layer
  already takes; it is not proof that the Batch 6 headless renderer has no use.
- **Lucent's custom Signals are a stored prompt plus a backfill flag** (`prompt`,
  `status`, `backfillStatus`, `matchCount`); their insight object is
  interval-scoped.
- **The industry uses the model to generate findings; we use ours to reject
  them.** Our numbers are what that difference looks like in production.

## Recommended changes

Ordered so nothing expensive runs against semantics we are about to change, and
so the baseline survives long enough to measure against.

### 1. Freeze and label the evaluation corpus (do this first)

**Change.** Snapshot the 231 generations with their inputs, verdicts, and reason
text before touching anything. Hand-label a sample of the underlying detections
as real or noise. Define the three metrics we will report from here on, never
blended: distinct findings, generations per finding, signals. Langfuse is already
wired into the worker.

**Why first.** Every change below alters what gets written. Once semantics move,
the current behavior is unrecoverable and we lose the only before-picture we
have. The first draft of this plan drew a confident causal conclusion from a
blended "98%" that turned out to describe 50 findings; a labeled set is how we
stop doing that.

### 2. Make bucket evidence accumulate, and version-scope it

**Change.**
- Add `rule_version` to eligibility and listing, or put it in the fingerprint.
  Pick one deliberately; four predicates and a hash input are not equivalent.
- Separate evidence from verdict. Threshold counting reads active signals (not
  retracted, not superseded, in window) regardless of `adjudication_status`, so a
  rejection stops the re-ask instead of resetting the count.
- Add **immutable generation-to-signal evidence membership**. Today a signal
  carries one `generation_id` and one mutable verdict
  (007_friction_adjudication.sql), so a later evaluation cannot reuse rejected
  evidence without destroying the earlier audit trail. This needs a join table
  recording which signals were evidence for which generation.
- Add a durable evaluated frontier, not a high-water count. The window rolls, so
  evidence expires; the watermark has to express "what has already been judged"
  in a way that survives expiry.
- Define renewal and revocation. Growth after a rejection should renew one
  finding, not create a contradictory second one. An acceptance that later looks
  wrong needs a revocation path rather than silent inheritance until
  `valid_until`.
- Separate fold-scoped from bucket-scoped evidence, or an already-folded error
  can promote a duplicate friction incident.
- **Normalize positional selectors in the fingerprint** (item 2b). Strip
  `:nth-of-type(n)` and `:nth-child(n)` before hashing, so one UI problem is one
  bucket rather than up to eleven. This changes the fingerprint, so it is a rule
  version bump and it must land with the rest of item 2 rather than separately.

**Also fix while in here**, all verified:
- The daily budget is reserved (promotion.ts:180) *before* `claimGeneration`, so
  concurrent losers burn budget without making a call.
- Budget exhaustion re-enqueues the entire `session_analysis` job
  (promotion.ts:239), replaying chunk reads and fact extraction to retry a
  promotion. Deferred adjudication needs its own durable state.
- Count, list, claim, and verdict application are not one snapshot; a retraction
  landing mid-call can promote stale evidence.
- Accepted-generation inheritance short-circuits before any growth evaluation
  (promotion.ts:143).
- A retry can meet its own in-flight generation, skip it, and still report
  success, so dead-letter-only reconciliation never runs. Stale claims need
  lease-aware recovery.

**Effect.** This alone should collapse generations-per-finding toward 1 and end
the repeated-batch pathology.

### 3. Validate the request facts with fixtures (parallel with item 2)

**Change.** Drive `test-fixtures/vue-app` and `react-app` through controlled
cases: successful writes, 4xx, 5xx, aborts, transport failures, fetch and XHR,
same-origin and cross-origin. Read the scrubbed events and extracted facts for
exactly those sessions. Count *requests carrying a usable status*, not sessions.
Cross-check a sample of the 122 unattributed sessions against server-side logs
for the same window.

**Why.** A failed-request detector built on unvalidated extraction is worse than
no detector, and right now we cannot tell a bug from a quiet sample.

### 4. Build the error-evidence contract, then finalize the prompt

**Change, in this order.** First define a bucket-scope error evidence field
(distinct from the fold-scope `nearbyError` shape): join only errors from the
eligible signal sessions; scope by project and environment explicitly; require
temporal proximity to the stored `occurred_ats`; respect the generation window;
exclude retracted and superseded signals; carry a normalized error fingerprint or
class, not a raw title, bounded in length and cardinality.

Then cut a new prompt version that (a) states the five-user bar is our own and is
already cleared, so the model judges detector validity rather than setting a
second volume bar, (b) receives the accumulated evidence from item 2, and (c)
receives the error evidence.

**Why this order.** Finalizing the prompt before the evidence contract exists
means immediately cutting another prompt version, and prompt versions invalidate
verdicts by design.

**Hazard.** Error titles are attacker-controlled browser content. The fenced-JSON
convention reduces accidental instruction-following but is not a security
boundary. Prefer class over free text.

**Example.** Today the model sees `dead_click`, `button.save`, `/settings`,
`occurrence_count: 5`, `bucket: {5 users, 5 occurrences, 7 days}`, and answers
"too low-volume." After: the same bucket with 47 accumulated occurrences across
19 users, the note that 5 users is our bar, and "4 of these sessions threw
`TypeError: undefined` within 10s of the click." That is a question it can
answer.

### 5. Enrich error incidents with session context (not a new detector)

**Change.** Do **not** create an `error-in-session` friction signal type or a new
incident kind. Errors already have groups, already carry session ids in 99.9% of
cases, and are self-evidently real, so putting them through friction adjudication
is nonsense. Instead, enrich and prioritize the existing `kind='error'` incidents
with the session facts we now extract.

**Evidence.** 2,834 sessions with errors, only 795 overlapping a friction signal.
The ~2,000 non-overlapping sessions are reachable through the error path we
already have.

**Reversal note.** The previous draft proposed this as a new detector. Codex
argued it would duplicate incidents that already exist, and that is right.

### 6. Detectors, opt-out, and the read path

**6a. Failed-request detector**, only after item 3 proves the facts.

**6b. Per-element opt-out.** A customer-extensible ignore list
(`.opslane-no-friction` plus a project setting). Every comparable product has
one.

**6c. Sessions list.** Add `activity_class` and `coverage` filters (the API
already returns both) and an ordering other than recency. This needs a precise
ranking and cursor contract, including what happens to sessions with no analysis
row yet, which is most of them until item 8. Default the view to sessions with
activity, an error, or an accepted signal: page 1 goes from about one interesting
session in fifty to fifty.

**6d. Digest.** The digest is about the customer's product, not our pipeline. Its
job is to name problems. Session volume is an operational footnote and belongs at
the bottom, or only when recording is broken.

Today's digest for the real last-24h window is almost entirely volume:

> No new insights.
> Top new issues: 4 new error groups.
> 126 older issues still awaiting your review.
> *Watched 4,480 sessions across 57 users.*

The same window, written as the findings we actually hold:

> **People are clicking things that don't respond.** Clicks landing on form field
> containers in the asset editor, doing nothing. Six positional variants of one
> pattern, 52 distinct people across them this week.
>
> **The bottom action bar gets rage-clicked.** 32 people, 79 times in 7 days.
>
> **New errors:** `RangeError: Invalid time value` and `TypeError: Cannot read
> properties of undefined (reading 'reporter')`, both investigated.
> `Nu: There is already a Loanee with this name` reached a real user.
>
> 126 issues awaiting your review.
>
> *291 of 1,091 analyzed sessions had no recording.*

Three requirements this implies, beyond wiring in the rollup (which still needs
its `no_replay` and empty-day tests):

- Findings lead. Volume goes last and only earns space when it signals a problem,
  such as a rising share of sessions with no recording.
- Never imply we analyzed more than we did. "Watched 4,480" while analyzing 1,091
  is a false claim in the current build.
- Merged fragments must be reported as one problem with its true distinct-user
  count (52), never as six findings or as the sum of their user counts.

Note that every finding in the improved version already exists in our database
today. None of it requires a new detector. It requires items 2 and 2b so the
findings survive to be reported.

### 7. Retire rule version 1 where the backfill will not

**Change.** Signals retire themselves on re-analysis (persist.ts:66), so the work
here is the rest: stop v1 emission; expire or revoke accepted v1 generations so
late signals cannot inherit them; recount or retire the affected `error_groups`
rows; confirm the sessions-list chips and `has_signals` filter retired rows; and
decide whether historically accepted v1 findings stay visible as history. A
retired detector does not mean every past detection was false.

### 8. Canary, then backfill once

**Change.** Add the project-id filter to `EnqueueAnalysisBackfillBatch` and
`CountAnalysisBackfillCandidates` (#241). Run a small time slice first with
explicit success and rollback criteria: no starvation of fix and investigate
jobs, no retry amplification, generations-per-finding at or near 1, budget
consumption within cap. Then backfill the 30-day window once.

**Why last.** `SESSION_ANALYSIS_MAX_CONCURRENT` bounds *claimed* jobs, not queue
depth: each enqueued row stops qualifying for the next batch, so repeated calls
will queue the whole corpus into the shared job table alongside fix and
investigate work. Backfilling before semantics settle also means doing it twice,
at rule-version cost.

### 9. Decisions this plan makes rather than defers

**Anonymous evidence.** Keep distinct identified users as the primary threshold,
and add distinct *qualified sessions* as a secondary path with a higher bar, where
qualified means complete coverage and `activity_class` in (`active`,
`light_touch`). Rationale: 94% exclusion makes signed-out funnel friction
invisible, which is where funnel friction matters most; and the facts layer now
gives us a bot filter that raw session counting lacked. This is a real abuse
surface, so the bar should be set from the corpus in item 1, not guessed here.

**Single-chunk sessions.** 54.7% are one chunk or less, 36.2% have none. Keep
recording them, stop analyzing them, and shorten their retention specifically.
That last part also gives the evidence pin an actual job: today the pin and the
default retention are both 30 days, so pinning buys minutes.

**Migration policy for existing state.** Before item 2 ships: decide what happens
to the 226 historical rejections (re-adjudicate under the new semantics, or let
them age out), to accepted generations mid-inheritance, and what initial
watermark existing buckets receive.

**Observability.** Ship item 2 with metrics on generations per bucket tuple,
stuck `adjudicating` rows, retry counts, and budget deferrals. The 68-generation
tuple ran for weeks and nothing alerted.

## Measured effect of the proposed changes

These are counterfactual spikes against the same production data, not estimates.

### Item 2, accumulating evidence: the pipeline is currently dead

Counting distinct identified users per bucket over the trailing 7 days, two ways.
`form_abandon` is excluded throughout: it is the retired rule and including it
inflates every number here.

| | Today (pending only) | Under item 2 (all active evidence) |
| --- | --- | --- |
| Live buckets in window | 339 | 339 |
| Buckets crossing 5 users | **0** | **27** |
| Max users on any bucket | **4** | **33** |
| Max occurrences on any bucket | 7 | 79 |

Read the "today" column carefully. **No live bucket in the last seven days has
five pending users. The maximum is four.** The promotion path is not producing
weak findings right now; it is producing nothing at all, because prior verdicts
stripped the evidence out from under it.

Worked example, from the real data. A `rage_click` on the bottom action bar of
`app.assetmanagementforjira.com`: **32 distinct users, 79 occurrences in 7 days,
45 rejections, 0 pending.** Zero pending means it sits below threshold as the
code counts today, so it will never be adjudicated again while 32 people keep
hitting it.

Secondary effect: 231 generations collapse to roughly 50 findings, so model calls
drop about 4.5x while evidence per call goes up.

### Item 2b, selector fragmentation: consolidation, not more findings

The fingerprint is built from the raw selector, so positional selectors split one
UI problem across buckets. In this data, `dead_click` on the asset editor appears
as `div:nth-of-type(4) > div.field-container`, `div:nth-of-type(3) > ...`, and
`div > div.field-container.has-label`, which is one unwired field label showing up
at several positions.

Collapsing positional indices out of the selector:

| | Today | Normalized |
| --- | --- | --- |
| Distinct buckets | 339 | 238 |
| Buckets crossing 5 users | 27 | 21 |
| Max users on one finding | 33 | **52** |
| Groups made of >1 fragment | — | 44 (max 11 fragments in one) |

Note what this does and does not buy. It produces **fewer** findings, not more,
because fragments merge. The gain is that each surviving finding carries stronger
evidence: the largest goes from 33 users to 52. Thirteen of the 21 crossing
groups are built from multiple fragments.

An earlier draft of this analysis claimed the dead-click cluster represented ~128
affected users by summing the per-fragment counts. That was wrong: the same
people hit several fragments, and the true distinct count after merging is 52.

### Item 5, error evidence: real but a minority

Of 3,526 active signals:

| Proximity | Signals | Share |
| --- | --- | --- |
| Error anywhere in the same session | 1,293 | 37% |
| Error within 60s of the flagged moment | 830 | 24% |
| Error within 15s of the flagged moment | 458 | **13%** |

So the correlation the adjudicator keeps asking for genuinely exists for 13% of
signals at tight proximity, 24% at loose. For the other three quarters, "no
nearby errors" is a true statement about the world and the model's objection
stands. This scopes item 5 down: worth building, not a fix for the rejection
rate.

Also worth noting: only 6 of the 90 accepted signals had an error within 15
seconds, so error proximity is not what drove historical acceptance.

### Item 6c, sessions list: 69x reduction

Of 62,195 sessions in the last 7 days, **904 (1.45%)** contain an error, an
accepted signal, or real activity. A page of 50 goes from roughly one worth
opening to fifty.

That 904 is a floor. The activity criterion can only match the ~1,100 sessions
that have been analyzed, so most of the reduction currently comes from the error
criterion alone. After item 8 the interesting set grows.

### Not yet measured

The anonymous-session fallback in item 9 cannot be sized until the backfill runs,
since qualifying a session requires facts we have for under 1% of them. Backfill
runtime and queue contention need the canary. Item 3's fact validation needs
fixtures, not queries.

## What this adds up to

The counterfactual changes the framing of this plan. The problem is not that we
surface weak findings. It is that we currently surface **nothing**, while sitting
on a rage click that 32 people hit 79 times last week and that we have rejected
45 times and stopped asking about.

After items 1, 2 and 2b, generations per finding collapse toward 1 and roughly 21
consolidated findings become eligible with real evidence behind them. If
acceptance still does not move, the labeled corpus tells us the detectors are
genuinely imprecise, which is a different and larger problem than this plan
fixes.

After 4 through 6, a customer notices: better verdicts, a session list that opens
on something worth watching, a daily message that reports what the system saw.

Item 8 makes any of it true across the full corpus rather than the 1% we analyze
today.

## Deliberately not proposed

- **Per-session LLM analysis.** Probably what Lucent does. It inverts the cost
  model the free tier assumes. Cost it against the corpus from item 8.
- **Headless replay rendering** (Batch 6). Deprioritized, not disproven.
- **Natural-language custom signals.** Cheaper than we scoped them, but
  downstream of precision.

## Open questions for review

1. Rule version in the fingerprint, or in the query predicates?
2. Where should the qualified-session bar sit for anonymous evidence?
3. Re-adjudicate the 226 historical rejections, or let them age out?
4. Sessions list: filtered to interesting by default, or unfiltered with a
   prominent toggle?

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found | round 1: central diagnosis rejected; round 2: 6 corrections, 4 adopted, 2 disputed with prod data |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**CODEX:** Round 1 rejected the "adjudicate at threshold" diagnosis and identified
the real mechanism (terminal verdicts partition the evidence pool). Round 2
corrected the measurement unit (full generation tuple, not bare fingerprint),
found that `persist.ts` already retires v1 signals so the proposed bulk update was
wrong, required immutable generation-evidence membership, and argued
error-in-session should enrich existing error incidents rather than become a new
detector. All adopted. Two claims were checked against production and did not
survive: full-tuple grouping confirms 50 findings and 68 generations on one tuple
(1 environment, so bare-fingerprint grouping was equivalent here), and
rule-version mixing measures at 2 buckets, not more than the 5 originally stated.

**VERDICT:** Codex review complete, 2 rounds. Eng review required before
implementation.

**UNRESOLVED DECISIONS:**
- Rule version in fingerprint vs query predicates (item 2)
- Qualified-session bar for anonymous evidence (item 9)
- Re-adjudicate 226 historical rejections vs age out (item 9)
- Sessions list default filtering (item 6c)
