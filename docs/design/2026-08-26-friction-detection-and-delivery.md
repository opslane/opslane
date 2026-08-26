# Friction detection and delivery: surface what's caught, then widen the gate

Status: M1 shipped · 2026-08-26 · Owner: Abhishek Ray · Supersedes the friction-family-grouping draft (falsified by replay, see Evidence)

> **M1 implementation note.** Delivery was added to the production v4 path
> (`freeze.go` → digest writer → `validate.go`), not the legacy `build.go`
> preview path described below. The v4 validation transaction loads the full
> actionable universe once, selects four cards by `impact_visits` plus the
> oldest remaining card, writes the per-run decision ledger, renders up to five
> receipt cards plus an overflow count, and commits them with the outbox event
> and `delivered` status. Frozen cards retain their episode-keyed publication
> records; actionable receipts use ledger `included` plus the delivered run as
> their publication record. Rotation of the fifth slot when the same oldest
> item remains parked is a follow-up.

## Problem

Opslane's largest friction finding in AMFJ 2 (dead clicks hitting 43 identified users in the last 7 days on the global page; "finding" until a human validates the root cause) was detected, judged real by the model three times (Aug 14, 20, 24), root-caused, and turned into two incidents on Aug 13-14. Both incidents have sat in `awaiting_approval` for twelve days. No digest ever mentioned them, and no digest ever could: the delivery lane structurally excludes friction incidents.

The daily digest has two lanes. The frozen-candidate lane requires an episode whose diagnosis is `verified_fix` or `needs_human` (`digest/freeze.go:197`); friction diagnoses carry NULL `episode_id`, so they never qualify (`digest_run_items` for this project: zero rows, ever). The receipts lane (`digest/build.go`) stacks three gates, and friction fails all three:

1. `pipelineEligibleSQL` (`build.go:107`) demands the group's latest episode carry an `open_inquiry` factual decision and an `investigate` inquiry decision. Friction episodes have zero `error_event_identities` rows, so the error-side filter parks every one in `watch` forever. Verified on both parked incidents: factual=`watch`, inquiry=NULL.
2. The decision timestamp must fall inside that day's 24-hour window (`build.go:83`). An item that misses its one morning never reappears.
3. Publication dedup is keyed by episode (`issue_publications.episode_id`), which friction diagnoses don't populate.

So "Nothing needs your attention today" was wrong in the sharpest possible way: fully processed work affecting 40 users was waiting for a human, and the notification layer had no path to say so.

### Evidence, including two retractions

A replay spike over the full trailing-7-day prod corpus (703 signals, 278 distinct click-target tuples, 135 identified users; harness in the session scratchpad, `proto*.mjs`) established:

- **The user distribution is bimodal, not spread.** Under today's bucketing: 201 spots, of which 125 have exactly one identified user and 28 have none (anonymous only). Two spots are outliers with 43 and 38 users; 18 spots have ≥5. 69% of identified users (93/135) touch a top-5 spot.
- **Grouping changes nothing this month.** Replaying the corpus under the proposed family rules and under maximal anchor-merging produced zero newly threshold-eligible buckets. The flagship splintered widget (`#inlineEdit-_rN_`, 20 variants) collapses to at most 2 identified users per page per week. The prior design's impact claim is falsified; that doc is withdrawn.
- **Retraction: there was no adjudication outage.** The earlier "zero model calls Aug 20-24" claim came from a mis-sorted query (`ORDER BY 1` sorted by project id). Correct per-day calls: Aug 18=16, 19=9, 20=11, 21=4, 22-23=none (weekend, nothing crossed), 24=13, 25=27. Verdicts completed in ~2s, first attempt, every weekday. No correlation with the Slice 9 deploy.
- **Hygiene decay is real but slow.** Atomic CSS classes rotate per deploy (observed: `_11c81d4k` to `_11c82smr`), resetting the 7-day accumulation; a second generated-id format (`#inlineEdit-uid35`) escapes the current patterns. Neither explains this month's silence.

## Goals / non-goals

Goals:

- The 43-user and 38-user defects appear in the next digest after deploy, with their age stated.
- Accepted-but-unacknowledged work repeats in the digest until a human acts; acting silences it.
- Friction spots with 2 identified users become reachable by adjudication. Accepted verdicts reach the digest directly in v1; a corroboration hold is added only if the pre-ship precision measurement says thin-evidence accepts are mostly noise.
- The demonstrated selector-instability fixes ship, so accumulation survives deploys.

Non-goals:

- **Family grouping / leaf-chain merging.** Falsified by the replay: zero eligibility gain, real false-merge risk. The withdrawn design's token-parser work is shelved, not adapted.
- **Page-level eligibility.** Rejected in Codex round 3 as an aggregation fallacy (five unrelated weak signals on a busy page would drag every widget into scrutiny).
- **Counting anonymous users toward promotion.** Plan D3 stands; 15% of tuples are anonymous-only and stay excluded.
- **Error-lane admission and investigation changes.** The error filter's `admitUnits=2` gate and the `unable_to_establish_cause` digest gap are real but separate. (Fix 1's repeat-while-actionable rule does apply to error-kind `needs_human` receipts: that is a delivery change, deliberately in scope for both kinds.)

## User requirements

| # | Requirement | Verified by |
|---|---|---|
| R1 | A friction incident in `awaiting_approval` or `needs_human` appears in every digest while the status persists, with no activity expiry | Integration test + live smoke: seeded stale incident appears with age line |
| R2 | Acting on the incident (approve, reject, archive, resolve) removes it from the next digest | Integration test: status transition silences the card |
| R3 | The two parked prod incidents (`30dedafb`, `b77de612`) appear in the first post-deploy digest | Prod observation, day 1 |
| R4 | Friction receipts no longer require error-lane episode decisions | Unit test: friction-kind group with `watch` episode passes eligibility |
| R5 | A spot with 2 identified users, ≥2 sessions, ≥3 capped occurrences, activity on ≥2 days is adjudicated | Integration test + temporal replay of the prod corpus |
| R6 | Contingent on M3: if 2-user precision measures poor, below-confidence accepts are held out of the digest until a third distinct user or post-cutoff later-day recurrence corroborates; otherwise no hold ships | M3 precision numbers recorded; if the hold ships: integration test that corroboration transitions it to `awaiting_approval` exactly once |
| R7 | One user recurrent path: 1 user, ≥3 sessions, ≥2 days, capped occurrence score promotes | Unit test on the threshold function |
| R8 | Deploy rotation of atomic classes and both generated-id formats no longer split buckets | Golden-corpus unit tests with the observed prod selectors |
| R9 | Model spend stays under 50 calls/day at the new gate | Friction-specific daily cap set to 50 (`ADJUDICATION_DAILY_CAP`); temporal replay projects the expected load, including re-adjudications after the version bump and the single-user path |

## Fix 1: delivery, repeat while actionable (the load-bearing change)

Shipped in the v4 validation transaction (`digest/validate.go`), not the legacy
preview builder. Four behaviors:

- **An explicit friction eligibility contract, not a bypass.** `pipelineEligibleSQL` keeps gating error-kind groups (it encodes error-lane triage). Friction-kind groups (branched on the authoritative `kind` column, never on the absence of episode evidence) get their own contract: terminal accepted adjudication for this group, validated publishable diagnosis belonging to that adjudication, current actionable status, not snoozed, not resolved/archived/superseded (plus not held, if the M3-contingent hold ships), project-scoped. Everything the old gate enforced besides the two error-lane decisions is audited into this list, not dropped.
- **Repeat while actionable.** For `awaiting_approval` and `needs_human`: include in every digest while the group is in an actionable status. The rule is "current status is actionable", not "a transition happened": `awaiting_approval → needs_human` stays visible, automated transitions do not silence anything, and re-entering an actionable status resumes delivery. A new `actionable_since` timestamp drives the age line ("waiting on you since Aug 13"); deriving age from `updated_at` would reset on unrelated writes. There is no activity expiry on pending human work: an inactive-for-8-days item still needs a decision, and expiring it silently reproduces the observed failure. `pr_created`/`insight`/`investigated` receipts keep the day-window (they are FYIs, not requests).
- **Snooze.** `snoozed_until` on the group, settable from the dashboard, so "intentionally deferred" is distinguishable from "ignored". Without it, daily repetition becomes wallpaper and users learn to skim past the section.
- **Cap without starvation.** Four slots by user impact plus one slot for the oldest unacknowledged item, with a count line for the rest. A pure top-5 lets four large findings suppress a small one forever.

Publication accounting uses the ledger primary key
`(digest_run_id, error_group_id)`: one decision per group per digest, with
repetition across days. The existing episode-keyed `issue_publications` stays
owned by the frozen-card lane. For actionable receipts, ledger `included` plus
the run's `delivered` status is the durable publication record.

Why repeat-while-actionable rather than announce-once-reliably: the observed exclusion was structural (friction failed the eligibility gate on every day, not just one), but the day-window design means even a correct gate gives each item exactly one morning. Any once-only design fails silently on the next deploy transition; the status machine already encodes "still needs a human", so the digest should read it.

## Fix 2: operational, review the parked incidents now

Approve or reject `30dedafb` and `b77de612` in the dashboard, today, independent of any code shipping. Minutes of work, and reviewing their computed root causes is the first quality check on the friction fix pipeline's output. Real findings do not wait around to serve as test fixtures; if they are resolved before fix 1 deploys, R3 is verified with equivalently seeded state instead.

Fix 1's delivery lifecycle needs these tests (beyond the R-table): `awaiting_approval → needs_human` stays visible; automated transitions do not silence; re-entering an actionable status resumes delivery; snoozed items stay hidden until due; the four-plus-oldest cap prevents starvation; one card per group per digest but repetition across days; and, only if the M3-contingent hold ships: concurrent corroborating signals flip a hold exactly once, and a single-user accept is held.

## Fix 3: recall, lower the gate with deterministic guardrails (Codex round-3 "option G")

`promotion.ts` / `promotion-db.ts`:

- `PROMOTION_THRESHOLD_USERS` 5 → 2, and the user count stops being the only noise filter. Pre-model deterministic checks: ≥2 distinct sessions, ≥3 total occurrences after a per-session contribution cap, activity on more than one day.
- Single-user recurrent path: 1 identified user AND ≥3 distinct sessions AND ≥2 days AND capped occurrence score over threshold. Raw occurrence count alone is not evidence (30 rage clicks can be one amplified interaction episode).
- **No provisional hold in v1; the hold is a contingency gated on M3 data.** Default: every accepted verdict flows to delivery like any other, because the failure mode of a wrong accept at threshold 2 is a visible digest card the owner rejects in seconds, while the failure mode this plan exists to fix is silent loss. The M3 hand-label measures precision on the newly eligible 2-user and single-user strata **before** the gate ships; the hold is built only if that precision is poor (working line: below roughly 70% of accepts judged worth reading, decided at M3 with the data in hand). If it is built, its design is fixed now so M3 is a go/no-go, not a redesign: below-confidence accepts sit in a non-actionable state (never `awaiting_approval`, which means "a human should act") and transition to `awaiting_approval` on corroboration by a **third distinct identified user** or post-adjudication recurrence on a later day, never merely "another session" (a reload or cookie reset manufactures sessions from one person), always measured after the adjudication's evidence cutoff, recorded in a durable `friction_delivery_state` row keyed by group and accepted generation.
- Everything else (generation claim, budget, 1.5× watermark brake, fold path) unchanged.

Replay projection: ~30 additional multi-user spots become eligible on the current corpus (21 two-user, 5 three-user, 4 four-user); the recurrent single-user stratum is not yet counted and the temporal replay must report it separately, along with re-adjudication load after the fix-4 version bump. Ship gated on that replay (below).

## Fix 4: hygiene, the two demonstrated selector fixes only

`fingerprint.ts` `canonicalizeSelector` additions, behind the existing `RULE_VERSION` bump (5 → 6):

- Normalize generated id segments in both observed formats: `_rN_` (`#inlineEdit-_r4i_`) and `-uidN` (`#inlineEdit-uid35`).
- Drop underscore-prefixed digit-bearing atomic classes (`^_[a-z0-9]{7,9}$` with a digit), so a deploy stops re-keying every bucket.
- Raw `element_selector` untouched everywhere.

No family column, no token parser, no backfill: at threshold 2 with continuous traffic, re-accumulation after the one-time re-key takes days. The watermark does **not** protect across the version bump: bucket state is version-keyed, so a re-keyed bucket starts fresh and an accepted duplicate would create a second incident and a second digest card, exactly what the two parked incidents show is possible. Fix 4 therefore includes incident-level cross-version dedup: before creating an incident from a rule_version-6 bucket, check for an existing non-terminal incident on the same (signal type, page, environment) whose signals overlap the new bucket's, and attach instead of create. The SDK-side tightening is deferred; the worker normalizes whatever the SDK sends.

## Sequencing and milestones

| M | Change | Exit criterion |
|---|---|---|
| M1 | Fix 1 (delivery: eligibility contract, repeat-while-actionable, dedup key, snooze, starvation cap) | R1-R4 pass; live smoke on worktree stack; first post-deploy prod digest carries both parked incidents |
| M2 | Fix 4 (hygiene + cross-version incident dedup) | R8 golden corpus green; no duplicate incident across the version bump (seeded test) |
| M3 | Temporal replay + full hand-label of newly eligible candidates | Precision per stratum (1, 2, 3-4 users, plus the existing 5+ set as control) recorded; go/no-go on fix 3 thresholds |
| M4 | Fix 3 (gate) | R5, R7, R9 pass; first 2-user adjudications in prod; digest reject rate on new-strata cards tracked for the first two weeks |

The parked incidents get reviewed **now**, not as a milestone; real findings don't wait to serve as test fixtures; R3 is verified with equivalently seeded state if they've been acted on before M1 deploys. Fix 1 ships first and alone: widening intake before the delivery layer stops dropping accepted work would only park more findings invisibly. Hygiene precedes the replay so the gate is measured under the identity rules production will run.

### M1 rollback notes

- Migration 062 deploys before the binary and is additive. Old binaries ignore
  `actionable_since`, `snoozed_until`, and
  `digest_run_candidate_evaluations`.
- Rolling the binary back silently stops repeat delivery and snooze enforcement;
  the retained columns and ledger rows remain harmless forward history.
- The lifecycle trigger remains safe with an old binary because it only governs
  the two new columns and does not run for occurrence-count updates.
- Rolling back the filter change resumes friction `watch` decisions and inquiry
  filtering noise; it does not damage incident or delivery state.
- Delivery-SLA checks currently emit structured diagnostics only. Paging,
  deduplication, and Slack routing remain follow-up operational work.

## Measurement before fix 3 ships

The replay harness becomes temporal: feed the corpus in arrival order and simulate the gate day by day, measuring calls/day, eligible-queue age, which strata (1, 2, 3-4, 5+ users) produce verdicts, and, over a window longer than 7 days, whether the version bump creates duplicates and (informing the hold decision) how often a third user or later-day recurrence would have arrived for 2-user accepts. Hand-label the **entire** newly eligible population (it is only ~30 multi-user spots plus the recurrent single-user candidates), with the existing 5+-user set as a control, recording both model agreement and whether the generated root cause is humanly actionable. Feasible in an afternoon at this corpus size; this is total coverage of a small population, not sampling.

## Observability: make the next investigation a query, not an archaeology dig

This investigation took roughly thirty hand-written prod queries, produced one false outage diagnosis from a mis-sorted result, and found a 12-day-old parked finding only by accident. The substrate is the database, not metrics: these facts are durable global state, and in-process counters reset on deploy, disagree across ECS tasks, and nothing scrapes the existing `/metrics` endpoint today. No new service; O1 and O5 do add schema. Slack (existing `notify/`) carries only actionable violations, routed to an internal channel, never the customer digest channel.

**O1. Per-candidate digest decision ledger (shipped in fix 1).** Aggregate counts cannot answer "why was incident `30dedafb` excluded?", which is the exact question this investigation kept re-deriving. Each digest run writes one row per currently actionable group to `digest_run_candidate_evaluations(digest_run_id, error_group_id, outcome, primary_reason_code, details)`. Reason codes are mutually exclusive and closed: `included`, `snoozed`, `error_lane_ineligible`, `not_publishable`, `frozen_lane_owns`, and `capped_overflow`. `capped_overflow` items remain in the digest's overflow count; they are omitted, not ineligible.

**O2. Build-time reconciliation invariant (shipped in fix 1).** At every digest build, every currently actionable group must be included or carry exactly one explicit exclusion reason. The check runs over the single transaction snapshot used for selection and ledger writes. If reconciliation fails, the additive lane rolls back to its savepoint, the frozen-card delivery continues, and the digest carries a warning instead of a false all-clear.

**O3. Delivery-SLA diagnostics, not a pending-work alarm (shipped in fix 1).** Structured checks report runs stuck past six hours, recent failed runs, missing expected runs, actionable groups absent from the latest delivered run's ledger, and stored reconciliation failures. These findings are logs only today; paging, deduplication, and Slack routing are follow-up work. A human leaving an item pending for days is expected under repeat-while-actionable and never triggers this diagnostic by itself.

**O4. Promotion-state view (ships inside fix 3).** A SQL view classifying every friction candidate under the current rule and prompt versions into exactly one of: `below_base_threshold`, `watermark_braked` (with `next_required_users = max(threshold, ceil(evaluated_users * 1.5))` computed explicitly), `promotion_ready`, `claimed`, `retry_scheduled`, `budget_deferred`, `delivery_hold` (only if the hold ships; includes single-user holds), `terminal`, `stuck_or_expired`. "Over-threshold but not judged" is deliberately not a metric: it conflates correct braking with starvation, which is exactly the confusion behind the false outage diagnosis. Starvation = promotion-ready, no valid generation, older than a grace period; alert on that, with age measured from `ready_since`. A daily rollup row snapshots the classification counts plus adjudication attempts/successes/failures/retries, oldest claimed generation, and latency, since history cannot be reconstructed from live state.

**O5. Incident status events (follow-up, not gating).** `incident_status_events(incident_id, from_status, to_status, actor, at)` written from the single status-transition path; if any mutation bypasses that path, the write moves into a trigger. Scope is honest: status transitions only. Adjudication completions, diagnosis attachment, folds, snoozes, corroborations, and publication attempts live in their own tables (generations, O1's ledger, `friction_delivery_state`) and a timeline is a UNION view over them, not a second write path.

Moved out of this section: honest filter reason strings and keeping friction episodes out of the error filter ship with fix 1's eligibility branch (they are correctness, not observability).

Alerting rules from day one: alert on transition into a failure state, not on every poll; persist alert identity keyed by (project, alert_type) with dedup and a single resolved notice carrying duration; require two consecutive failing evaluations except for O2, which fires immediately; repeat unresolved alerts at most every 24h; summarize (one message listing incidents, never one message per incident); respect digest schedule so weekends do not read as missed delivery; include run and group ids plus the diagnostic query, never raw selectors or user data.

## Risks

- **Repeat-card fatigue.** A user who ignores an item sees it daily. Mitigations: the age line makes the nag legible, acting or snoozing silences it, the section is capped at five slots. Residual: a backlog the user never triages becomes wallpaper; the snooze data will show whether that is happening.
- **Threshold-2 noise reaching the digest.** With no hold in v1, a wrong accept at 2 users becomes a digest card the owner must reject by hand. Bounded by the M3 precision gate before shipping and the tracked reject rate after; the pre-designed hold is the escalation if either goes bad. The inverse risk (a real finding waiting forever for corroboration) only exists if the hold ships, and then the dashboard shows held items.
- **Fingerprint re-key duplicates.** Covered by fix 4's incident-level cross-version dedup; the residual cost is duplicate model calls (bounded by the 50/day friction cap), not duplicate incidents.
- **The root causes on the parked findings might be bad.** If review finds them wrong, fix 1 still stands (delivery is correct regardless), but fix-pipeline quality becomes its own investigation, and the hand-label in M3 will quantify it.

## The honest caveat

The long tail stays dark. 125 of 201 friction spots have exactly one identified user, and 28 more are anonymous-only; after every change here, only the recurrent-single-user slice of that tail can ever surface. That is a deliberate trade: at this tenant's traffic, judging one-touch spots would be judging noise. If AMFJ's identified-user base grows, the same thresholds get more coverage for free; the harness now exists to re-measure whenever that assumption is questioned.

## Alternatives considered

- **The family-grouping design (this doc's predecessor).** Withdrawn: replay showed zero newly eligible buckets under any grouping scheme, and its fallback guard refused the very merges it was designed for. Its useful residue is fix 4 and the replay harness.
- **Announce-once with better timing (fix the window instead of repeating).** Rejected: reproduces the observed failure class; any single missed morning is permanent.
- **Page-level eligibility with batched adjudication.** Rejected per Codex round 3: aggregation fallacy, cross-candidate prompt contamination, page watermark ambiguity.
- **Counting anonymous users (weighted or not).** Rejected: an anonymous session cluster can be one person; plan D3's identity guarantee is what makes "2 users" mean two humans.
- **Raising model spend instead of adding deterministic prechecks.** Rejected: the adjudicator judging sparse evidence is not an independent corroborating signal; the prechecks are free and falsifiable.
