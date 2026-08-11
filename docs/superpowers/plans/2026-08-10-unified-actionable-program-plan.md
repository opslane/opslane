# Unified Actionable Program: Implementation Plan (single worktree)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans task-by-task.
> **Authority:** `docs/design/2026-08-10-unified-actionable-program.md` (v2) wins over everything here and over both older plans (`docs/superpowers/plans/2026-08-10-actionable-receipts-v1.md`, `docs/plans/2026-08-10-actionable-pipeline.md`). Those remain reference detail only where this plan says "carried forward."
> **Verification method:** each checkpoint carries acceptance criteria in the `/verify` format (do it / expect it / intent / baseline / witness). Criteria marked **[gate]** are engineering gates (compile/CI checks, not user-drivable); all others are drivable the way a user drives the system and form the pre-drafted half-one criteria for an `/opslane-verify:verify` run at that checkpoint.
> **Review record:** 2 Codex iterations (session `019fed7c`), all P1/P2 findings from both rounds folded in.

**Goal:** every customer-visible issue arrives as a receipt (verified fix PR, reviewable attempt with diff, or agent-ready report), produced by a pipeline where nothing grades its own work.

**Execution mode:** one worktree (`error-tracking` branch). One PR per work item (C0 is four small PRs, same day). A checkpoint passes before the next begins, except the C6/C7 tracks noted in the sequencing summary.

## Global constraints (inherited by every checkpoint)

- Postgres queue only; wire contract append-only; lease and terminal-status contracts preserved; human-trigger bypass untouched.
- **Copy rule, precisely:** Opslane-authored surface copy (digest lines, story lines, labels, receipt lines) is templates over stored fields; no model prose. The investigation's `root_cause` and `agentTaskBrief` are model-authored technical reports: they render only where labeled as investigation output, only when their verdict validated (citations mechanically checked), and never inside templated copy.
- No judgment-based impact labels. Digest cards always carry an action; a replay link is never a card's only action. The incident page's honest state (not-verified + replay links + counts) is the deliberate fallback surface, not a receipt.
- Confidence self-grades removed from routing; "no usable diagnosis" is the only stop. Tiers are mechanical; the judge can veto, never approve past a failed predicate.
- Automated PRs are **drafts as the v1 terminal posture**; changing that posture is a future decision with its own review, not a checkpoint here.

---

## C0: Interface freeze (four small PRs)

- W0.1 Diagnosis contract in `shared/src/diagnosis.ts`: `evidence[]{path,detail,symptomLink}`, `agentTaskBrief`, verdict outcome value `incomplete`. No `suggested_direction`.
- W0.2 Receipts payload: `SchemaVersion int` + `ReceiptItems` + cluster-card variant, Go + TS, all optional/`omitempty` (unset payload serializes exactly as today). The cluster card ships as a frozen serialization only: no producer or renderer until the convergence work after this program; CP4 proves the formatter tolerates it.
- W0.3 Migration `044`: `diagnosis_decisions.policy_eligible/policy_basis` **and the outcome constraint change admitting `'incomplete'`** (whatever form the current constraint takes: enum value, CHECK update, or documented free-text with a consumer test); `error_groups.terminal_fix_job_id` + four impact columns; `digest_readiness` table (`status IN ('eligible','ineligible','pending')`, `reason`); `fix_run_ledger` table (job id, command, commit, dirty flag, discovered/passed/failed/skipped counts, truncation/timeout flags, not-run list, created_at) — the ledger's persistence home; `triggered_by` admits `'reinvestigate_report_only'` wherever constrained.
- W0.4 Evidence-tier + ledger record types (worker), matching the `fix_run_ledger` columns.
- Each PR adds a **contract consumer test failing on base**, written without type escapes (no `as unknown as`): TS construction tests, Go marshal tests, SQL selects including an INSERT of `outcome='incomplete'` and a ledger row.

**CP0 criteria:**

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC0.1 [gate] | Run the contract consumer tests on base, then branch | Each fails on base (missing type/column/value), passes on branch, and contains no type-escape casts | changes / fail / success |
| AC0.2 [gate] | Apply migration 044 via the runner; re-run the runner; then simulate a partial apply (stop after each statement boundary in a disposable DB) and re-run | Clean apply; runner re-run is a no-op; every partial boundary is recoverable by re-running (statements re-runnable or transactional) | changes / fail / success |
| AC0.3 | Send one browser event through the stack; build one digest from prod-shaped seed with no receipt items set | Event ingests; digest JSON byte-identical to pre-branch output (unset new fields omitted — the property under test) | preserves / pass / success |
| AC0.4 [gate] | Diff `test-fixtures/wire/` | Zero changes | preserves / pass / refusal |

---

## C1: Investigator fix, quarantine, and the honest surface

Carried forward: pipeline T3 detail (split exploration/classification budgets; classification requested only after ≥1 file read and ≥1 citation; mechanical citation checking at the recorded `investigated_commit`; filler rejection; prompt caching). No `suggested_direction`.

**Work items:** W1.1 friction harness rewrite + error-lane `submit_diagnosis` gains `evidence[]`/`agent_task_brief`; W1.2 verdict validation → `outcome='incomplete'` persisted on the decision row, `digest_readiness` set `('ineligible', reason)`, `root_cause` NULL; W1.3 quarantine migration: the 7 placeholder incidents get `('ineligible','quarantined_degenerate')` rows; W1.4 report-only re-enqueue (`triggered_by='reinvestigate_report_only'`; fix-job creation structurally unreachable for that attribution); **W1.5 the honest surface now:** incident DTO + dashboard render readiness (an `ineligible` or `pending` incident shows "Investigation has not verified a cause yet" + replay links + counts, never `root_cause`), and the current digest builder gains an interim predicate: **exclude incidents whose readiness row is `ineligible` or `pending`; incidents with no readiness row (the legacy book) render as today.** The absent-row policy is explicit and temporary; C4 replaces it with eligible-only over the projection plus the C3 backfill.

**CP1 criteria:**

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC1.1 | Re-enqueue the 7 quarantined incidents report-only; wait for terminal states | All 7 terminate; 0 persist any `/placeholder|tbd|to be determined/i` cause; ≥5 persist causes with every citation mechanically verified; the others persist `incomplete`, not prose; 0 fix jobs exist for the 7 | changes / fail / success |
| AC1.2 | Open one of the 7 quarantined incidents' pages; render a digest including it | Page shows the honest not-verified state (no cause text); digest has no row for it | changes / fail / refusal |
| AC1.3 | Drive an invalid investigation through the pipeline (forced filler verdict in a test project) | Readiness row lands `ineligible` written by the pipeline; its page shows the honest state; the digest excludes it | changes / fail / refusal |
| AC1.4 | Run one investigation with exploration budget forced to zero | `outcome='incomplete'` with a stated reason; `root_cause` NULL; readiness `ineligible`; no fix job | changes / fail / refusal |
| AC1.5 | Seed a crash whose planted cause lives at a known file/line; run the error-lane investigation | Diagnosis cites the planted file among its verified citations with a symptom-linked detail; the brief validates and renders under the investigation-output label | changes / fail / success |
| AC1.6 [gate] | Unit-assert the rewritten harness's prompt prefix is byte-stable across turns and records `investigated_commit`; run twice and read the trace | Stable prefix asserted; second run shows `cache_read_input_tokens > 0`; `investigated_commit` equals the clone HEAD | changes / unknown / success |
| AC1.7 [gate] | Submit a verdict citing a file absent from the checkout | Rejected to `incomplete`; nothing persists to `root_cause` | changes / fail / refusal |

Exit: C1 ships alone and first; W1.5 is what makes "the placeholder lie is off customer screens" true without waiting for C4.

---

## C2: The worker: saved diffs, fail-first, ledger, judge, policy

Carried forward: saved diffs (receipts A1 revised: extracted diff returned in the existing `diff` result field on unsuccessful terminal exits; persisted via the existing `candidate_diff` path). New: fail-first + ledger (pipeline T4/T5 pulled forward; ledger rows persist to `fix_run_ledger`), the judge, policy routing without confidence.

**Work items:** W2.1 saved diffs. W2.2 fail-first + ledger + tier derivation (ledger written by harness code only). W2.3 the judge: separate agent session; inputs diagnosis, checked citations, diff, test source, ledger; probe budget ≤3 commands, only on ledger anomalies; structured verdict; approval required for automated PRs; assessment into PR body; veto feedback onto the saved-diff report; **the authorization decision id it acted on is persisted with its verdict**. W2.4 policy routing: `outcome=code_fix` + live impact bar (project-scoped, `bool_and` anon semantics, recorded as `policy_basis`); confidence deleted from routing; "no usable diagnosis" maps to the concrete state: group `needs_human` with reason `insufficient_context`, readiness `('ineligible','no_usable_diagnosis')`; authorization loads the decision via the job's **`source_job_id`** (exposed on the claim row — not the generic `source_id`), NULL falls back to newest-for-group (test-pinned); reused pending fix jobs re-pointed atomically (payload + `source_job_id` + decision); terminal adoption via `terminal_fix_job_id`. **C2 also writes `digest_readiness` for its outcomes** (PR opened / attempt failed → the receipt-eligible states), so C4 has no orphaned receipts.

PR bodies at this checkpoint contain the verification (ledger) and judge sections; impact-first layout arrives at C5.

**CP2 criteria:**

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC2.1 | Seed a fixture repo with a plantable bug **and an issue meeting the impact bar (2 identified users seeded)**; let investigate complete; click nothing | A fix job runs; a draft PR opens; body contains the ledger-rendered verification section (red-then-green for the declared test) and a judge section; readiness row is receipt-eligible | changes / fail / success |
| AC2.2 | Read the PR's `fix_run_ledger` rows | Declared test in base-run failures with the expected assertion, absent from fix-run failures; zero other new failures; rows carry command, commit, dirty flag, counts, and the not-run list | changes / fail / success |
| AC2.3 | Fixture whose only test also passes on the base commit | Harness predicate fails it before any judge involvement: tier not `reproduced`, no PR, diff saved | changes / fail / refusal |
| AC2.4 | Fixture red-then-green but probing an unrelated element | Judge vetoes; no PR; veto reason on the saved-diff report | changes / fail / refusal |
| AC2.5 [gate] | Feed the judge path a mechanically failed attempt with a forced glowing verdict | No PR can open; predicate failure is terminal regardless of judge output | changes / fail / refusal |
| AC2.6 | Seed "no usable diagnosis" | No fix job; group is `needs_human`/`insufficient_context`; readiness `('ineligible','no_usable_diagnosis')`; nothing customer-facing renders it as a receipt | changes / fail / refusal |
| AC2.7 | Seed a usable diagnosis below the impact bar (0 identified users, 1 anon session) | No attempt; decision row records `policy_eligible=false` with basis numbers | changes / fail / refusal |
| AC2.8 | Two investigations on one group; requeue the older fix job | The persisted judge/authorization record names the decision id of the job's own `source_job_id`, not the newest; a NULL-source legacy job's record names the newest (fallback pinned) | changes / fail / success |
| AC2.9 | Existing pending fix job, then a second investigation completes | The pending job's payload, `source_job_id`, and the authorization record all reference the new decision (atomic repoint) | changes / fail / success |
| AC2.10 | Force budget exhaustion after edits | Terminal state carries the working diff, readable from the incident page | changes / fail / success |
| AC2.11 | Human-click a fix on a parked incident | Runs regardless of eligibility; judge output appears as a report; PR not blocked by it | changes / fail / success |
| AC2.12 | Kill the worker between terminal group write and job completion; reaper requeues | Requeued run adopts via `terminal_fix_job_id`; exactly one attempt's artifacts exist | changes / fail / refusal |
| AC2.13 [gate] | Behavioral pair: two seeded diagnoses identical except the model's old confidence field value | Identical routing and outcomes for both (confidence is inert) | changes / fail / refusal |
| AC2.14 [gate] | Judge session assertions across AC2.1 (clean ledger) and a seeded anomalous-ledger run (truncation flag set) | Separate session id from the fixer; zero probes on the clean run; ≥1 and ≤3 probes on the anomalous run | changes / fail / success |

---

## C3: Impact, readiness backfill, session pointers

Carried forward: receipts B1 revised SQL (open-status predicate, explicit transaction + temp table, stale-clear guarded on non-NULL, `IMPACT_WINDOW_DAYS=30`, planner review) and B2 (stitched-span coverage, friction pointer with retraction fallback, playability via full snapshot). New: friction incidents stamped by the same arithmetic over their signals' sessions; **W3.B readiness backfill**: one migration classifies every existing open incident into the projection (eligible when it has a validated cause or receipt state, `pending` otherwise), retiring C1's absent-row policy before C4 flips to eligible-only.

**CP3 criteria:**

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC3.1 | Seed the schippers shapes; one sweeper pass | Crash-loop-only group `blocked` (2 visits, 0 recovered); loop-plus-17-min group `degraded` (2/1) | changes / fail / success |
| AC3.2 | Seed a friction incident with one dead-click session ending 5s after the signal and one continuing 10 min | Friction incident `degraded`, visits 2, recovered 1 | changes / fail / success |
| AC3.3 | Group whose only session has NULL-bounded chunks | Impact columns all NULL after sweep | changes / fail / refusal |
| AC3.4 | Age a stamped group past the window; sweep twice | Clears once; second sweep writes nothing (row version stable) | changes / fail / refusal |
| AC3.5 | Friction incident page whose representative signal is retracted, accepted sibling exists | Player loads the fallback signal's session at its offset | changes / fail / success |
| AC3.6 | Event whose session's coverage spans **three chunks** stitched across the ±15s window; and an event with only a 1ms chunk | Multi-chunk session yields a watch pointer; 1ms session yields none | changes / fail / success |
| AC3.7 | Drive the readiness transitions through the pipeline: valid investigation completes; a fix attempt records its outcome; the backfill runs on a seeded legacy book | Rows land `eligible` (validated cause), `eligible` with receipt reason (attempt outcome), `pending`/`eligible` per backfill rules — written by pipeline/migration, not seeded | changes / fail / success |
| AC3.8 [gate] | Seed 100k events, 80% older than the window or on closed groups; `EXPLAIN (ANALYZE, BUFFERS)` the sweeper statements | Examined-row counts proportional to the in-window open subset (ratio asserted), buffers recorded in the PR for index review | changes / unknown / success |

---

## C4: Digest receipts

Carried forward: receipts C1/C2 revised (state-change window, cap 10, `occurrence_count`, 300-char sanitized excerpts, `has_usable_diagnosis` join, held-back over surfaced-eligible states, `narrative` neutral package, SchemaVersion branching, quiet day). The gate reads `digest_readiness` exclusively (eligible-only; the C3 backfill made that safe). Displayed titles pass the same sanitizer as excerpts; forensic source fields are not customer copy.

**CP4 criteria:**

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC4.1 | Render a digest from a pipeline-produced seed with one incident per receipt state (PR open; failed with diff; failed without diff; report-ready) | Four cards, correct receipt line each, ≥1 working action each, sanitized title + story line | changes / fail / success |
| AC4.2 | Drive a placeholder-verdict investigation and a no-usable-diagnosis investigation through the pipeline into the digest build | No cards; held-back footer counts exactly both (readiness written by the pipeline, not seeded) | changes / fail / refusal |
| AC4.3 | Seed the prod rank-divergence shape | Priority-score leader first | changes / fail / success |
| AC4.4 | Render a captured v1 payload; a v2 with items; a v2 with zero items; a v2 containing one cluster-card item | v1 → legacy layout; v2-items → cards; v2-zero → quiet day (triage line + footer); cluster item → tolerated without error and not rendered (no renderer exists yet, by design) | changes / fail / success |
| AC4.5 | Seed 14 eligible state-changes at T; render at T+1h and again at T+25h with no new changes (both `now` values pinned) | First: exactly 10 cards, priority order, overflow named; second: quiet day (window passed, no repetition) | changes / fail / refusal |
| AC4.6 | Inspect rendered copy fields (titles, story, receipt lines, excerpts) — not button URLs | No CSS selectors, no origin-full URLs, no internal reasoning; excerpts ≤300 chars | changes / fail / refusal |
| AC4.7 | Human gate: one full digest from prod-shaped data, read by the owner | Sign-off recorded in the cutover PR before the Slack destination flips | changes / fail / success |

**W4.M measurement ritual:** checked-in `scripts/loss-ledger.sql`; each run appends a dated entry to `docs/research/loss-ledger.md` **with the runner's raw output attached** (the debug-ro task output pasted verbatim, not summarized). First entry: the 2026-08-10 baseline (163 open groups, ~2% user-impact conversion). CP: both entries exist; the attached output parses.

---

## C5: Surfaces (issue page, PR body)

Carried forward: receipts D1/D2 revised (shared `Incident` typing; recordings via `EXISTS`; crash counts aggregated before any chunk join; PR body renders the C2 ledger). All four issue-page receipt states.

**CP5 criteria:**

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC5.1 | Open incident pages for all four receipt states | Each renders its receipt (PR link / saved-diff view / failed-no-diff report / report-ready), ordered: impact badge+title, story, recordings, cause, receipt | changes / fail / success |
| AC5.2 | Fetch the incident API response, then load the page | Response contains the `story` string; the page displays that exact string | changes / fail / success |
| AC5.3 | Incident with NULL impact | Story reads "recording impact unavailable"; no badge invented | changes / fail / refusal |
| AC5.4 | One event whose session has 6 covering chunks | Recordings list shows crash_count 1 (no multiplication) | changes / fail / refusal |
| AC5.5 | Read policy PR bodies: impact data present / NULL impact / no session link | Impact-first numbers / unavailable phrase / watch link omitted; verification lists every executed check + not-run list; judge section when present | changes / fail / success |
| AC5.6 | Compare a human-triggered PR body against a pre-branch capture | Every pre-existing section still present | preserves / pass / success |

---

## C6: Identity cutover (host-free friction keys)

Carried forward intact: pipeline T1 §6.1 expand/contract. **C6 owns its own cross-language URL golden fixtures** (the W7.1 splinter fixtures are message-normalization cases and do not belong here — prior coupling removed). Own PR series after C0; may interleave with C2-C5.

**CP6 criteria:**

| AC | Do it | Expect it | i/b/w |
|---|---|---|---|
| AC6.1 [gate] | Run the URL golden fixture file through the Go test and Vitest suite | Identical, origin-free normalization on every row | changes / fail / success |
| AC6.2 | CI fixture: same dead-click from three rotated Forge origins | One bucket, three signals, one candidate | changes / fail / success |
| AC6.3 | During the expand phase (dual-read deployed, migration not yet run): look up a route stored origin-full and one stored path-only | Both resolve to their names (dual-read proven under mixed data) | changes / fail / success |
| AC6.4 | Run the canonicalization migration on a prod-shaped copy, twice | Zero `^https?://` patterns; collisions resolved per policy or present in the audit table; second run a no-op | changes / fail / success |
| AC6.5 | After enforcement: submit a route-map write containing a host-bearing pattern | Normalized or rejected at the write boundary; no origin-full row lands | changes / fail / refusal |
| AC6.6 | Replay a pre-cutover friction signal at the old rule version | Old buckets untouched | preserves / pass / refusal |
| AC6.7 | Post-deploy: watch the prod Forge canary across ≥2 origin rotations | One bucket accumulates | changes / fail / success |

---

## C7: Tail work

- **W7.1 Grouping splinter** (any time after C0; no C6 dependency). CP7.1: [gate] diagnosis test names the differing fingerprint component; drivable: send the two `bum` variant events through ingestion → one group; a distinct error → its own group; run the suppression and family suites and confirm their assertions still pass (behavior, not file-diff) | changes / fail / success + preserves / pass / success.
- **W7.2 Session-facts filters (#313)** (any time). CP7.2: the sessions list answers "active sessions with failed requests this week" and "not analyzed" with exactly the seeded sessions (changes / fail / success); the unfiltered list is unchanged (preserves / pass / success).
- **W7.3 Eval loop (T7)** (after C2). CP7.3: a prompt-change PR without a paired eval artifact fails CI (changes / fail / refusal); one with a valid artifact passes, and the artifact records baseline/candidate outcomes plus judge approve/veto rates (changes / fail / success).
- **W7.4 Backfill (#314)** (explicit go only; off every critical path). CP7.4: the 1k-session cost batch report exists with extrapolation; post-run, every cohort session analyzed or terminally classified with a reason code; re-run is a no-op; no criterion references a customer surface.

---

## Program-level gate (after C4, and at program end)

`pnpm -r build && pnpm test` (DATABASE_URL exported; skip counts read), `go build ./... && go test ./...` (zero skips), `docker compose config --quiet`, the AC2.1 chain re-run, one digest re-eyeballed, and `scripts/loss-ledger.sql` run against prod with raw output appended to `docs/research/loss-ledger.md` and compared to baseline. The program's success metric is that number moving.

## Sequencing summary

C0 → C1 → C2 → C3 → C4 → C5. C6 as its own track any time after C0. W7.1/W7.2 any time after C0; W7.3 after C2; W7.4 on explicit go. C1 ships alone and first: it removes "Root cause: placeholder" from customer screens, and W1.5 makes that true without waiting for C4.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found → addressed | R1: 16 P1 / 17 P2 / 3 P3; R2: 15 P1 / 13 P2 / 3 P3; all folded into revisions 1-2 |
| Eng Review | `/plan-eng-review` | Architecture & tests | 0 | not run | — |

**CODEX:** Two iterations against the live repo (session `019fed7c`). Round 1: pass-by-construction checkpoint criteria, cross-checkpoint dependency inversions (C1/C2/C3 consuming later work), missing contracts for report-only attribution and the `incomplete` verdict, and a criterion that let the judge stand in for the fail-first predicate. Round 2: confirmed most resolutions, then caught the missing DB outcome constraint, the C2-to-C4 readiness orphaning (fixed with the C3 backfill), the brief-vs-copy-rule contradiction (resolved by scoping the copy rule), the consumerless cluster card, and the false W7.1→C6 fixture dependency. Both rounds' P1s and P2s are folded into the plan text.

**VERDICT:** CODEX CLEARED after two iterations — eng review not yet run (recommended before execution).

**UNRESOLVED DECISIONS:**
- The C4→cutover review cadence for draft PRs (drafts are the v1 terminal posture; changing it is a future decision, deliberately outside this plan).
