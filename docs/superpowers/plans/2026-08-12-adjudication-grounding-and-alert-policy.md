# Adjudication grounding and alert delivery policy (program addendum)

> **Relationship to the program:** addendum to `docs/superpowers/plans/2026-08-10-unified-actionable-program-plan.md` (and its authority doc). It covers failures that program does not: the external-cause routing gate in `packages/worker/src/classify.ts`, the reason-code mapping for external causes, and the first-seen `issue.created` alert. It inherits every global constraint from the program plan and adds none.
> **Trigger:** prod incident `9e16a803-ab01-4b96-8404-f7feda966845` (project "AMFJ 2", 2026-08-12), diagnosed end to end; see Context.

**Goal:** an investigation that correctly concludes "the cause is external" reaches the `insight` surface with a capped priority and templated copy — and a zero-impact first-sighting can be configured not to page a human.

## Context: the incident this generalizes from

A Connect-on-Forge Jira app's page threw `BridgeAPIError("the window title wasn't changed due to error.")` from Atlassian's own `@forge/bridge` chunk on `cdn.prod.atlassian-dev.net` — zero customer frames in the stack, one event, zero users. Sentry had tracked the same error for four months (54 events) without escalation. The correct terminal state was `insight` / `not_actionable` with a capped priority.

What happened instead, in order:

1. The investigation correctly adjudicated `cause_kind: external_system`.
2. `deriveOutcome` (`classify.ts:105-127`) demoted it to `needs_more_context` because two local candidate hypotheses were "unrejected". The check requires each candidate's statement to appear verbatim (lowercased substring) in the free-prose `rejected` array, so even a genuine rejection in different words fails it. **Correction (2026-08-13, from the replay eval):** the afterEach hypothesis was *real* — `master` of the customer repo contains an unawaited, uncaught `view.changeWindowTitle()` in `vue3/client/src/modules/common/router/index.ts:24` (the original assessment grepped a `staging` checkout that lacks it). The judge was right to hold the external conclusion; the genuine failures were the surface (judge meta-prose rendered as ROOT CAUSE) and the uncapped priority. Grounding remains the correct mechanism precisely because it distinguishes this case: a real candidate stays grounded and keeps veto power; only candidates naming code that is not there lose it. The replay eval showed the grounded pipeline, given resolved stacks, diagnosing the real call site as a parked code fix (6/7 actionable vs baseline 2/7).
3. The group landed `needs_human` / `insufficient_context` — a reason code the priority sweeper does not cap — and the judge's meta-objection rendered as "ROOT CAUSE" (the rendering half is already fixed on main by C1/C2; prod lag).
4. Separately, the first-seen `issue.created` Slack alert had already paged a human for a group with one event and zero users, before any investigation ran.

The veto in step 2 rests on unvalidated model prose — precisely the artifact class C1 eliminated everywhere else. The program's own rule is "the judge can veto, never approve past a failed predicate"; here the veto itself must clear a predicate.

## Issues in scope (not covered by the program plan)

- **I1** `Adjudication.rejected` is free prose matched by verbatim substring; `candidates_considered` entries are never grounded against the checkout. A fabricated candidate can veto a correct external conclusion forever.
- **I2** `reasonCodeForDecision` maps every `not_actionable` outcome to `unfixable_infra`; the third-party-code distinction (`unfixable_third_party`) exists in the reason-code vocabulary and the sweeper cap list but is unreachable from investigation outcomes.
- **I3** `issue.created` publishes at first-seen inside the ingestion transaction (`db/queries.go` → `publishIssueCreated`), when impact is definitionally one event. There is no per-destination way to wait for triage.

## Non-goals (considered and rejected)

- **SDK title prefix** (`e:` from a minified constructor): fixed forward by #320; the residual "generic `Error:`" case is cosmetic. Customer action: upgrade the SDK.
- **Pre-clone third-party short-circuit by frame origin:** unsound for Connect-on-Forge apps, where the customer's own page is served from the platform CDN origin — the grounded adjudication path (I1) is the correct place to catch these.
- **Capping `insufficient_context` in the sweeper:** unknown is not unimportant; the fix is correct classification, not blanket demotion of failures.
- **Prod deploy lag:** operational; C1/C2 already remove the prose leak once deployed. Not plan work.
- **Backfill of already-misfired groups (decided 2026-08-12):** no re-triage of the existing `needs_human`/`insufficient_context` book. Recurrences trigger natural re-investigation; anything paging annoyingly can be archived by hand. Chosen over report-only re-enqueue to avoid spending investigations on parked incidents.

## Known residual (stated, not hidden)

Every mechanical predicate here checks that the model's claims are *anchored in real repository content*; none can check that the anchor is *interpreted honestly*. A model could still cherry-pick a real quote that misleadingly supports rejecting a real candidate. What the predicates guarantee: a candidate or a rejection that describes code which does not exist can no longer route anything. What they do not guarantee: correct reasoning about code that does exist — that is the judge's territory, and the blast radius of a wrong `not_actionable` is bounded to the `insight` surface (never a PR: the fix lane still requires `code_fix` plus the impact bar plus fail-first verification).

## W-A: Grounded candidates and structural rejection (I1 + I2)

### Contract (`shared/src/diagnosis.ts`) — optional in the type, required at the submission boundary

The stored type stays backward-compatible with every persisted decision row; strictness lives in the `submit_diagnosis` tool schema and worker-side validation, the only producer of new rows:

- `candidates_considered` entries gain optional `id?: string` and optional `citation?: GroundedQuote`.
- New optional field `rejected_candidates?: Array<{ id: string; evidence: string; citation: GroundedQuote }>` — a rejection must itself be anchored in repository content, not only reference an id (an arbitrary prose `evidence` alone converts nothing).
- `GroundedQuote` is `{ path: string; line: number; quote: string }`: `path` undecorated (same rule as `CauseLocation`), `line` 1-based, `quote` a verbatim excerpt of 1–300 characters after trimming, non-whitespace, compared with per-line trailing-whitespace normalization.
- **Grounding predicate (one definition, used everywhere):** `path` resolves via the existing `resolvePath` AND `quote` appears within ±5 lines of `line` in that file at the investigated commit. Quote-anywhere-in-file is not grounding (a fabricated hypothesis can quote an unrelated real line); the line anchor forces the citation to point where the quote lives.
- `id` contract: unique within the adjudication, format `c<n>` with `n ≥ 1` (uniqueness required; contiguity not — deletion during model retries must not invalidate the set).
- The legacy `rejected: string[]` stays for old decision-row reads. Old rows are display-only: nothing re-derives routing from a persisted adjudication (routing runs once, at investigation time, on a fresh submission; report-only re-enqueues run a fresh investigation). Asserted by AC-A.7 against named reader entry points.

The decision row (`PersistedDecision`) gains optional `candidate_dispositions?: Array<{ id: string; disposition: 'rejected' | 'ungrounded' | 'live' }>` — additive, covered by the same old-row parse test as the adjudication fields.

### Submission validation (worker, C1's retry/`incomplete` path — never a crash, never a persisted half-shape)

Rejected at the boundary: duplicate candidate ids; missing or malformed ids; a `rejected_candidates` entry whose `id` matches no candidate or duplicates another rejection; empty or whitespace-only rejection `evidence`; a local (`local_code`/`configuration`) candidate missing `citation`; any `GroundedQuote` violating the bounds above. (Schema enforces shape; the validator enforces the cross-field rules the schema cannot.)

### Routing (`deriveOutcome` — pure; `resolvePath` plus a `quoteAt(path, line, quote)` predicate injected)

Each local candidate is disposed, **grounding evaluated first** so forensics show fabricated candidates as fabricated even when the model also "rejected" them:

- **ungrounded**: candidate citation missing or failing the grounding predicate — the candidate does not describe the actual repository and cannot block an external conclusion;
- **rejected**: grounded, and referenced by a `rejected_candidates` entry whose own citation passes the grounding predicate;
- **live**: grounded and not validly rejected → `needs_more_context` with basis `unrejected_local_candidates`, exactly as today. The gate stays; only ungrounded vetoes and ungrounded rejections die.

Dispositions are persisted as `candidate_dispositions` on the decision row.

`reasonCodeForDecision` becomes cause-kind-aware for `not_actionable`: `external_system` → `unfixable_third_party`, `data_or_input` → `unfixable_infra` as today. Both are in the sweeper's capped set, so routing weight is unchanged either way. The label is coarse for server-side external services; refining the taxonomy is listed under unresolved decisions rather than smuggled in here.

`diagnose-schema.ts` (the `submit_diagnosis` tool schema) requires the new fields on submission; the harness prompt states the grounding rule. If the W7.3 eval-loop CI gate has landed, this prompt change ships with its paired eval artifact; if not, the PR records a manual before/after eval on the seeded fixtures below.

## W-B: End-to-end proof on the incident's shape

A worker-pipeline test with a **controlled adjudication** (harness stubbed to submit a fixed verdict — a live model run is nondeterministic evidence): third-party-only stack, `cause_kind: external_system`, candidate `c1` fabricated (quote absent from the cited window), candidate `c2` grounded and rejected by id with rephrased prose and a grounded rejection citation. **Seeded with nonzero impact (2 identified users)** so the cap arithmetic is distinguishable from zero. Assert: persisted dispositions exactly `c1: ungrounded`, `c2: rejected`; group status `insight`; `reason_code = unfixable_third_party`; root cause rendered only under the investigation-output label.

## W-C: Per-destination delivery policy for `issue.created` (I3)

### Delivery policy

- Migration (append-only, guarded): `notification_destinations.delivery_policy TEXT NOT NULL DEFAULT 'immediate'` plus a named constraint `notification_destinations_delivery_policy_check CHECK (delivery_policy IN ('immediate','post_triage'))`. Partial-apply recovery must cover the column-without-constraint boundary explicitly (AC-C.1).
- **The policy transforms *when* the existing `issue.created` subscription delivers; it is not a new subscription.** A destination subscribed to `issue.created` with `delivery_policy = 'immediate'` behaves exactly as today. With `'post_triage'`, the same subscription delivers an `issue.triaged` message at the triage terminal instead. Flipping the policy can therefore never silence a destination — there is no second event-type checkbox to forget. `issue.triaged` is an internal payload/formatter type, not a user-selectable subscription; the settings API exposes only `delivery_policy`.
- `publishIssueCreated`'s destinations CTE adds `AND delivery_policy = 'immediate'`.

### `issue.triaged` — every surface, enumerated

1. **Emission point — one function.** A single worker helper (in `worker/src/db.ts`) owns the SQL that sets `error_groups.status`; it appends the outbox CTE when the write **transitions the group into** `needs_human` or `pr_created`. All existing writers (`updateGroupStatus`, `updateGroupInvestigation`, `updateGroupAndCreateFixJob`, the PR-creation path) are refactored to call it — "single choke point" is made true by construction, then proven by an inventory test (AC-C.8) driving every caller path. Not emitted at the investigation terminal write for `code_fix` (the PR does not exist yet); `pr_created` is the emission transition for PR-bearing outcomes. Crash paths (`worker_runtime_error`) transition through the same helper, so post-triage destinations cannot go silent on exactly the failures that most need a human.
2. **Outbox rows:** same `outbound_events`/`outbound_deliveries` insert shape as `publishIssueCreated`, destinations filtered to `delivery_policy = 'post_triage' AND 'issue.created' = ANY(event_types)`.
3. **Dedup key:** `issue.triaged:<groupID>:<terminal job id>`. Retries and reclaimed leases of the same job dedup to one delivery; a *new* investigation after a regression reopen carries a new job id and pages again. (`issue.triaged:<groupID>` alone would permanently silence reopened regressions.)
4. **Payload — one JSON shape, two runtimes.** The worker (TypeScript) writes it; the dispatcher/formatter (Go) reads it. Exact field names mirror the existing Go `notify.EventPayload` JSON (`version`, `event_type`, `issue`, `project`, `environment`, `dashboard_url`) plus `outcome`: `{ status, reason_code, label, impact: { users_7d, anon_sessions_7d } }`. `label` comes from a fixed template table keyed on **(terminal status, reason_code)** — keying on reason code alone would announce a successful PR as "low confidence fix", since every `code_fix` decision carries `low_confidence_fix`. No model prose (program copy rule); `reason_message`/`root_cause` never enter the payload. A checked-in JSON fixture is asserted byte-identical by a TS construction test and decoded field-for-field by a Go test (AC-C.6).
5. **Validation/registry:** `handler/notifications.go` event-type allowlist gains `issue.triaged` for payload validation/dispatch purposes; destination create/update does NOT accept it as a subscription (see policy semantics above); `delivery_policy` exposed in the settings API and dashboard types.
6. **Formatter:** `notify/slack.go` gains an `issue.triaged` case; unknown-type fallback behavior untouched.
7. **Docs:** `docs/contracts/` notification event catalog updated.
8. **`insight` / `not_actionable` outcomes emit nothing** — those groups reach humans through the existing daily digest (already shipped: `packages/ingestion/digest/`; C4 later tightens its gating to `digest_readiness`, which C2 already writes for these outcomes — evidence: `worker/src/index.ts:697-712` writes `readiness: eligible` on the `not_actionable` path. No dependency on C3–C7 for W-C's correctness, only shared surfaces to coordinate on).

## Checkpoints

### CP-A (with W-B folded in)

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC-A.1 [gate] | Contract consumer tests: (a) new-shape construction fails on base, passes on branch; (b) an **unchanged old-shape** `Adjudication` literal (no ids, no citations, prose `rejected`) still compiles and round-trips on the branch; (c) a persisted old-JSON decision row — including one with no `candidate_dispositions` — parses under the branch types | (a) proves availability; (b)+(c) prove additivity for both the adjudication and the decision-row contract; no type-escape casts anywhere | changes / fail / success |
| AC-A.2 [gate] | `deriveOutcome` unit (branch-only, via a legacy-shape adapter so base comparison isolates behavior, not schema): external conclusion + candidate citing a real file with a quote absent from the ±5-line window (including a quote that exists elsewhere in the same file) | `not_actionable`, basis `cause_outside_codebase`; disposition `ungrounded` — the line-window check, not path existence, is what fired | changes / fail / success |
| AC-A.3 [gate] | Unit: external conclusion + grounded candidate, unrejected; and + grounded candidate whose rejection's own citation fails grounding | Both land `needs_more_context`, basis `unrejected_local_candidates` (the gate survives; an ungrounded rejection converts nothing) | preserves / pass / refusal |
| AC-A.4 [gate] | Unit: grounded candidate rejected by id, rephrased evidence prose, grounded rejection citation | Accepted as rejected (the old substring bug is the baseline failure, demonstrated through the adapter with equivalent legacy input) | changes / fail / success |
| AC-A.5 | Run the W-B pipeline fixture (2 seeded identified users), then one sweeper pass | `priority_inputs` records `reason_code = 'unfixable_third_party'`, `cap_applied = true`, and nonzero impact; `priority_score` equals impact × route_weight × 0.1, with the uncapped product also asserted — zero-impact would make cap and no-cap indistinguishable | changes / fail / success |
| AC-A.6 [gate] | Submission validator, one case each: duplicate ids; malformed id; rejection id matching no candidate; duplicate rejection ids; empty/whitespace rejection evidence; local candidate missing citation; quote over 300 chars; whitespace-only quote | Each rejected at the submission boundary onto C1's retry/`incomplete` path; nothing persists | changes / fail / refusal |
| AC-A.7 [gate] | Feed a legacy-shape stored decision row through each **named** persisted-row reader entry point (dashboard incident DTO, digest builder, fix-job authorization loader) | Every reader renders/reports without crashing and none routes from it — display-only proven at the entry points, not by grep | preserves / pass / refusal |
| AC-A.8 | Disposition forensics: candidate with a fabricated citation that is also "rejected" by a grounded rejection | Disposition records `ungrounded`, not `rejected` (grounding evaluated first) | changes / fail / success |

### CP-C

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC-C.1 [gate] | Apply migration; re-run; then simulate partial apply stopped between column add and constraint add, and re-run | Clean, idempotent; the named check constraint exists and is enforced after every recovery path | changes / fail / success |
| AC-C.2 | Ingest a first event for a new group with an `immediate` destination | Slack "New issue" arrives; formatter output identical to pre-branch capture with dynamic fields (ids, timestamps, URLs) pinned by the fixture | preserves / pass / success |
| AC-C.3 | One project, two destinations subscribed to `issue.created` (`immediate` + `post_triage`); ingest a first event; let investigation land `needs_human` | `immediate` receives exactly one `issue.created` and no triage message; `post_triage` receives exactly zero `issue.created` and exactly one `issue.triaged` with the outcome label — cross-delivery in either direction is the failure | changes / fail / success |
| AC-C.4 | `post_triage` destination, investigation lands `insight`/`not_actionable` | No `issue.triaged` row in `outbound_events` for the group; the group appears in the digest build (current builder rules) | changes / fail / refusal |
| AC-C.5 | (a) Deliver one `issue.triaged` (delivery asserted present first), then crash/reclaim and re-run the same terminal job; (b) reopen the group via a regression event and let a *new* investigation land terminal | (a) exactly one event row survives the re-run (dedup); (b) a second delivery occurs under the new job id | changes / fail / refusal |
| AC-C.6 [gate] | Seed a group whose `reason_message`/`root_cause` contain a sentinel string; capture the **persisted** `outbound_events.payload`; run the checked-in fixture through the TS construction test and the Go decoder test | Sentinel absent; payload matches the fixture field-for-field in both runtimes; `version` present; only allowlisted templated fields | changes / fail / refusal |
| AC-C.7 | Force a fix job to die as `worker_runtime_error` on a group with a `post_triage` destination | The `needs_human` transition still emits exactly one `issue.triaged` (crash paths cannot silence post-triage destinations) | changes / fail / refusal |
| AC-C.8 [gate] | Drive every status-writer path into a terminal transition: investigation → `needs_human`; investigation → `insight`; fix fail → `needs_human`; runtime error → `needs_human`; PR success → `pr_created` | Each `needs_human`/`pr_created` transition emits exactly one outbox row through the shared helper; `insight` emits none; a status write bypassing the helper is unrepresentable in the worker (no other call site compiles against the raw SQL) | changes / fail / refusal |
| AC-C.9 | PR-bearing outcome on a `post_triage` destination | The triage message announces the PR (label from the (status, reason_code) template table), not "low confidence fix" | changes / fail / refusal |

## Deploy gate for W-A (decided 2026-08-12): prod-replay eval

W-A ships only after a replay eval on real prod incidents, run entirely outside prod (prod is read via the debug SQL runner; nothing writes back — consistent with the no-backfill decision):

- **Sample (N=20):** ~14 groups from AMFJ 2's `needs_human`/`insufficient_context` cohort (50 available with sample events, confirmed 2026-08-12) + ~6 controls from `resolved`/`pr_created` groups whose code cause is known.
- **Method:** export each group's sample event, seed into a disposable worktree stack, run the investigation twice per incident — current schema/prompt vs grounded — with a live LLM key.
- **Ship criteria:** grounded arm's `incomplete` rate ≤ baseline arm + 10 percentage points; the window-title incident (and any other external-cause misfire in the sample) lands `insight`/`unfixable_third_party`; every control still reaches its code cause. Attach both outcome tables to the W-A PR.
- **Post-deploy watch:** week-over-week `incomplete` share in `diagnosis_decisions`; tripwire (rate doubles) → prompt/schema fix before further rollout; rollback is redeploying the previous worker image (no feature flag — deliberately, per the no-shims guardrail).

## Sequencing

W-A → W-B are one PR series and depend only on C2 (merged), gated by the replay eval above. **W-C is deferred (decided 2026-08-12): do not start it until C4/C5 have merged.** Its design here is settled and ready, but its status-write refactor touches `worker/src/db.ts` and ingestion notification files that C4/C5 actively edit, and the alert-noise pain it fixes is tolerable once W-A makes outcomes honest. Nothing in C3–C7 is a hard dependency for W-C — the daily digest it leans on already ships today, and the readiness rows it reads are written by C2 — this is merge-churn avoidance, not sequencing necessity.

## Decisions from the 2026-08-12 alignment review

- Grounding over forbidding speculation: candidate enumeration stays free; only grounded candidates carry veto power (confirmed).
- No backfill of the existing misfired book (see Non-goals).
- Coarse `unfixable_third_party` label accepted for all `external_system` causes; revisit with data (see below).
- No extra safeguard for the cherry-picked-quote residual: blast radius is insight-only, no judge pass, no sampled audit.
- W-A deploy gated by the N=20 prod-replay eval; W-C deferred until after C4/C5.

## Unresolved decisions

- Whether `post_triage` should ever become the default delivery policy (needs usage data; deliberately out).
- Whether `immediate` destinations should get a follow-up thread message when triage completes (out: threading state is a new surface).
- Whether `external_system` should split into `third_party_code` vs `external_service` cause kinds; today's single mapping to `unfixable_third_party` is coarse for server-side platforms (both candidates are priority-capped, so the stakes are labels, not routing). Accepted-for-now 2026-08-12.

## Review record

| Review | Trigger | Runs | Status | Findings |
|--------|---------|------|--------|----------|
| Codex Review | `/codex` (consult, plan embedded; session `019ff75e`) | 2 | issues_found → addressed | R1: 7 P1 / 11 P2 / 1 P3 — contract made optional-in-type/required-at-boundary; `pr_created`-transition emission; dedup epoch by job id; surface enumeration. R2: 4 P1 / 8 P2 / 1 P3 — line-anchored grounding; grounded rejection citations; policy-transforms-subscription semantics (no orphaned destinations); single-helper choke point + inventory AC; (status, reason_code) label table; cross-runtime payload fixture |
