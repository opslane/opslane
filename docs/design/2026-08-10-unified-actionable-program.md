# Unified program: actionable receipts + actionable pipeline (v2, consolidated)

Date: 2026-08-10 · Status: agreed (Abhishek, two grill sessions, consolidated) · Supersedes three documents:
`docs/design/2026-08-10-actionable-receipts.md` (error lane), `session-analysis-friction:docs/design/2026-08-10-actionable-pipeline-design.md` (friction lane), and v1 of this page.
The lane docs remain the detailed specs for their streams; where anything disagrees, this page wins. Identical copies live in both worktrees. Task plans in both worktrees are re-cut against this page before execution.

## The bar (shared)

Every item on a customer surface carries something to act on: a verified fix, a reviewable attempt with its diff, or a report the customer can hand to their coding agent. A replay link is supplementary, never the only action. Labels never claim more than the evidence tier earned. No sentence of customer copy asserts a fact that is not computed from a stored field or query.

## The decisions

1. **One digest contract, one gate.** The receipts payload (`SchemaVersion` + `ReceiptItems`, receipts §5d) is the only digest payload; friction incidents become receipt items once the investigator fix lands, plus one cluster card type for cross-issue convergence. Eligibility is decided in exactly one place: the persisted readiness projection (`digest_readiness`, single writer in the worker persistence layer, pipeline §6.4). Formatters and the incident page read the projection; nothing else decides customer visibility. An ineligible incident renders the honest state, never its stored analysis.

2. **One impact vocabulary, one source.** `blocked / degraded / invisible`, stored in the shared columns on `error_groups`. Both lanes compute it the same way: from session recordings (last recorded activity relative to the last crash or friction signal in that session). The friction lane's "judgment-based until the backfill" clause from v1 is overturned: judgment-based impact labels never ship. Where recordings are missing the label is "recording impact unavailable." The session-facts backfill (#314) stays on the roadmap for filters and adjudication context and is off every customer-facing critical path.

3. **Autonomy without self-grading.** Confidence tiers are removed from routing, from the digest, and from the issue page. The investigator reports evidence, not a grade of itself; the only stop signal it keeps is "no usable diagnosis" (today's `insufficient`, renamed), which routes to the internal queue and never to a customer. Any usable `code_fix` diagnosis on an issue meeting the impact bar (≥1 identified user or ≥3 recent anonymous sessions, recorded on the decision row as `policy_basis`) gets a fix attempt with no human click. The agent brief ships regardless of attempt outcome.

4. **Evidence tiers grade the attempt, mechanically.** Tier 1 **reproduced**: a declared failing test seen red on the base commit and green with the fix, compared by the harness. Only tier 1 may auto-merge, and only with the project's `auto_fix` opt-in. Tier 2 **checked**: reproduction attempted and declared impossible with a recorded reason; suite, diff review, and build green; opens PRs as drafts. Tier 3 **attempted**: saved diff plus report, never labeled verified. The fail-first harness lands in the first worker milestone.

5. **The judge (overturns v1's "no second reader-judge").** An LLM judge with tools reviews every automated PR before it opens. It reads the diagnosis, the checked citations, the diff, the test source, and the executed-checks ledger; it does not re-run verification, but carries a small probe budget (two or three commands) for suspicion cases only: a ledger timeout, a truncation, a test whose name matches nothing in the diff. Its distinctive check is the one no instrument can make: whether the declared failing test honestly probes the customer's symptom or is an artificial toggle. The judge cannot override the hard predicates (tier rules above); it can only add a veto. Judge approval is required to open any automated PR, and its assessment is written into the PR body when it has something to say; on a veto, its feedback lands in the saved-diff report. Human-triggered fixes get the judge's assessment as an advisory report, not a blocker. This is not the retired two-reader design (`diagnose-schema.ts` history): that judge graded prose with the same blind spots as the writer; this one grades instrument data and can execute.

6. **One diagnosis contract.** `evidence[]` (mechanically checked citations) plus `agentTaskBrief` (self-contained markdown brief), both lanes, one schema migration. `suggested_direction` from the receipts doc is dropped; the brief subsumes it. The digest's "copy report for your agent" carries the brief verbatim.

7. **One PR body.** Impact-first layout (receipts M4), verification section generated from the executed-checks ledger with not-run items at equal prominence, judge feedback section when present. One stream owns the surface, the other supplies facts.

8. **Identity: instances land anywhere, the class has one owner.** The `bum` splinter fix ships as-is and becomes a named fixture in the identity contract's golden table when the host-free cutover (T1) lands. #30/#77/#247 close into the identity epic. T1's expand/contract deployment sequence is unchanged from the pipeline doc (§6.1) and remains the program's riskiest infrastructure change.

## Stream ownership (the no-duplication rule)

Each subsystem belongs to exactly one branch. The other branch does not touch those files.

**Stream A: `error-tracking` branch (error lane + surfaces + verification):**
- Fix agent and verification: saved diffs on failure, policy authorization and impact bar, evidence tiers + fail-first harness, executed-checks ledger, **the judge** (one branch edits `agent-fix.ts` / `pipeline.ts` / `pr.ts`, not two).
- Impact columns + the recordings-based sweeper computation (and its extension to friction signal sessions; A owns the query, B's incidents get stamped by it).
- Readiness projection, digest receipts payload, `narrative` package, Slack formatter, issue-page and PR-body reorders.
- Grouping splinter (receipts M5).

**Stream B: `session-analysis-friction` branch (friction lane + identity + facts):**
- Investigator harness #316 (T3), quarantine and report-only re-enqueue, and the shared diagnosis-schema migration: `evidence[]` + `agentTaskBrief` (no `suggested_direction`). Stream A consumes, does not edit, `shared/src/diagnosis.ts`.
- Identity contract: #308/#309/#310/#312, expand/contract cutover, golden fixtures (including Stream A's splinter case).
- Session facts: #313 filters, #314 backfill (off the critical path).
- Friction receipt emission + cluster card detector (against Stream A's payload contract), eval loop T7 (both lanes), #315 shadow eval.

**Interface between streams (the only coordination points):** the `ReceiptItems` schema + cluster card type (A publishes, B consumes); the diagnosis schema (B publishes, A consumes); the evidence-tier record and readiness projection (A publishes, all rendering reads); the impact columns and recordings query (A publishes, B's incidents are stamped by it).

## Sequence

```
Now, parallel:  B: T3 (#316, quarantine, report-only re-enqueue)   A: M1 (saved diffs + policy auth + tiers/fail-first + judge)
Then:           B: T1 identity cutover                              A: M2 impact + readiness projection, M3 digest receipts
Then:           B: friction receipts feed + T8a facts filters       A: M4 surfaces (PR body reads B's ledger facts)
Then:           B: T7 eval + cluster cards (internal), T8b on go    A: M5 splinter (anytime)
```

Deploy-order constraints carried forward: T1's expand/contract steps; the receipts formatter cutover only after the captured-v1-payload test is green (receipts R8); automated PRs are drafts until the tier-1 harness **and** the judge land; the quarantine of the seven placeholder verdicts ships in the same release as T3.

## Standing decisions folded in

- #311: age out the 521 origin-full friction groups (no consolidation migration).
- Correlation layer for mass silent breakage: deferred; the adjudication budget cap is the backstop.
- No LLM-written customer copy anywhere: templates over stored fields, both lanes. The judge's PR-body feedback is developer-facing PR content, not customer digest copy.
- Confidence is never self-reported upward: code demotes, execution promotes (tiers), and an evidence-reading judge with execution rights reviews every automated PR.

## Where v1 of this page was overturned, explicitly

- v1 said "no second reader-judge." Decision 5 replaces that with the tool-holding, ledger-reading judge; the objection v1 encoded (a second reader shares the first reader's blind spots) is answered by giving the judge instrument data and execution rights, not another copy of the prose.
- v1 allowed friction impact labels "from signal shape now and session facts after the backfill, labeled as judgment until then." Decision 2 forbids judgment-based labels entirely; friction impact comes from the same recordings computation as errors, or renders as unavailable.
- v1 landed `suggested_direction` alongside the brief; decision 6 drops it.

## What would reopen these decisions

A multi-domain-single-project customer (reopens origin-as-dimension). Receipt items proving too rigid for an unforeseen friction card shape (reopens the cluster-card addition, not the contract). Tier-2 draft PRs accumulating unreviewed (reopens the impact bar or the draft rule). Judge approval rates drifting toward 100% or toward 0% (reopens the judge's prompt and probe budget; the eval loop T7 tracks both rates from day one).
