# C2: The Worker — Saved Diffs, Fail-First, Ledger, Judge, Policy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every automated fix attempt proves the bug before fixing it (red-then-green compared by the harness), records what it executed in `fix_run_ledger`, is graded mechanically into a tier, is reviewed by an instrument-reading judge before any automated PR opens, and is authorized by a recorded policy decision instead of a confidence self-grade — while failed attempts keep their working diff.

**Architecture:** The fix agent gains a declared-test contract (two new terminal-ish tools); after the existing gates settle on a final candidate, the harness runs an isolated-commit red/green protocol and records every executed check into a recorder created by the pipeline (so entries survive any throw) and persisted to `fix_run_ledger`; a pure function derives the `reproduced`/`checked`/`attempted` tier from those facts; a new judge session (own loop, own session id, probe tool enabled only on ledger anomalies) must approve every automated PR and can only veto, never rescue — and fails closed. Routing and authorization stop reading `confidence` on the error lane: any validated `code_fix` decision on a group meeting the live impact bar gets an attempt, recorded as `policy_eligible`/`policy_basis` on the decision row; authorization loads the decision by the job's own `source_job_id`. Fix outcomes write `digest_readiness` so C4 has no orphaned receipts.

**Tech Stack:** TypeScript (worker, Vitest), Postgres (migration 044 already holds every column C2 needs — **C2 adds no migration**), Go 1.24 (one small ingestion change: human retry clears the adoption marker), E2B sandbox (local backend available for tests via `OPSLANE_SANDBOX_BACKEND=local` + `OPSLANE_RELIABILITY_HARNESS=1`, `harness/sandbox-runtime.ts:145-152`).

**Parent:** `docs/superpowers/plans/2026-08-10-unified-actionable-program-plan.md` §C2. Authority: `docs/design/2026-08-10-unified-actionable-program.md` (decisions 3, 4, 5, 7); carried-forward detail: `docs/design/2026-08-10-actionable-receipts.md` §5a/§5b, `docs/design/2026-08-10-actionable-pipeline-design.md` §6.3/§6.4.

## Dependencies on C0 and C1 (hard prerequisites)

C0 is merged. C1 (`docs/superpowers/plans/2026-08-11-c1-investigator-honest-surface.md`) is on this branch and must merge before C2 execution starts; C2 branches from the C1 stack. Consumed, never edited:

- Migration `044_actionable_receipts_contracts.sql`: `diagnosis_decisions.policy_eligible BOOLEAN` / `policy_basis JSONB` (`:20-21`, zero readers/writers today); `error_groups.terminal_fix_job_id UUID REFERENCES error_group_jobs(id) ON DELETE SET NULL` (`:38-39`, unwritten); `digest_readiness` (`:80-90`); `fix_run_ledger` (`:92-116`) — `UNIQUE (run_id, entry_seq)`, composite FK `(job_id, project_id) → error_group_jobs ON DELETE RESTRICT` (job/tenant delete must remove ledger rows explicitly; Task 10 covers every deleter it can find plus test teardown).
- `packages/worker/src/verification-ledger.ts` (W0.4, types only, zero importers outside the C0 fixture): `VerificationTier = 'reproduced' | 'checked' | 'attempted'`; `LedgerEntry { jobId, projectId, runId, entrySeq, command, commitSha, workdirDirty, discovered, passed, failed, skipped, truncated, timedOut, notRun }`; `TierRecord { tier, declaredTest: { identifier, expectedAssertion } | null, reproductionImpossibleReason: string | null }`. C2 writes the first producer; the shapes are frozen (`__tests__/contracts/c0-ledger.fixture.ts`). The ledger deliberately has **no check-kind column**: check roles (`repro_red`, `suite_baseline`, …) and assertion-match facts live in the persisted `EvidenceRecord.checks` (which already carries `name`/`outcome`/`command`/`output_tail`) and in a worker-local in-memory role map for PR rendering (Task 9) — the ledger stays the raw executed-command audit, the evidence record stays the interpreted one, and AC2.2 reads both (its task map row says so).
- C1's `validateVerdict` (`packages/worker/src/verdict-validation.ts`) and its reason vocabulary; C1's `upsertDigestReadiness` (`db.ts:98-113`, the single TS readiness writer — C2's new readiness writes go through it, never a second INSERT); C1's `Diagnosis.investigatedCommit` and `CloneResult.headSha`.
- C1's report-only guard: `processFixJob` refuses `triggered_by='reinvestigate_report_only'` before any group read (`index.ts:1100-1106`), and `updateGroupAndCreateFixJob` guards at entry. C2's changes to both functions must keep those guards first.

**Two tier vocabularies exist; C2's rule:** `fix_run_ledger` + `TierRecord` (`reproduced`/`checked`/`attempted`) are the *grading* system — they drive the PR-open predicate, the PR-body verification section, and readiness reasons. The older `EvidenceRecord`/`EvidenceTier` (`shared/src/types.ts:210-246`, E0/E1/E2) stays as the *persistence envelope* (`verification_evidence` column, read API, ci-watch): C2 appends optional fields to it (`tier_record`, `authorization`, `judge` — Tasks 4, 9, 11) and keeps writing `checks`, now including named `repro_red`/`repro_green` entries. **E2 stays unreachable** (`computeTier` at `harness/evidence.ts:31-35` also requires a `repro_reversal` check C2 does not run — deliberately: the reversal is auto-merge machinery, out of scope); nothing renders E-tiers on new surfaces, and the PR body speaks `TierRecord` (Task 12).

## Global Constraints

- Postgres queue only; wire contract append-only (`test-fixtures/wire/` untouched); lease and terminal-status contracts preserved; **human-trigger bypass untouched** (a human click runs regardless of decisions, policy, or judge — the judge attaches an advisory report only, and a judge outage never blocks a human-triggered run, AC2.11).
- Copy rule: surface copy is templates over stored fields. The ledger-rendered verification section is computed from ledger/evidence fields — no model prose may appear in it. The judge's assessment and veto reason are model prose and are **developer-facing PR content** (design "Standing decisions"): they render only inside the labeled judge section of the PR body and the labeled judge report on the saved-diff view; they are persisted only under `evidence.judge`; **`reason_message` and every other templated field carries computed copy only** — including the *existing* diff-judge interpolation at `agent-fix.ts:1195-1197`, which Task 11 also converts to templated copy (it predates C2 and violates the same rule).
- Confidence is deleted from *error-lane routing and authorization*, not from storage: `diagnosis_decisions.confidence`, `error_groups.confidence`, and `confidenceFor` keep existing so history and display don't break. AC2.13 is the proof: two decisions differing only in confidence route identically. The friction auto-fix rung is **frozen, not widened** (Task 3 rationale — the one C2 decision flagged for owner sign-off).
- The judge can veto, never approve past a failed predicate: on automated jobs the judge is invoked **only after** the tier predicate has passed (structural ordering, asserted by AC2.5's forced-glowing-verdict test), and an absent, errored, or malformed judge verdict **fails closed**.
- Automated PRs are **drafts, always** — the v1 terminal posture (program constraint). Three enforcement points, all Task 11: PR creation posture, the reservation-replay path, and **ci-watch's draft→ready promotion (`ci-watch.ts:208-217`), which is disabled for automated PRs** (auto-promotion is exactly the posture change the program defers). A pre-cutover ready PR that is *already open* is grandfathered, not retroactively converted — recorded in the PR description as a bounded one-time exception. Human-triggered PR posture is unchanged.
- Fail-first tightens, never weakens, the existing verification gates (receipts doc §2 non-goal): the baseline suite, build gate, diff judge, and precision gate all still run and still bind — the PR predicate becomes `tier === 'reproduced' AND buildGatePassed AND qualityConfirmed` for ready-tier attempts, with `checked` folding the same gates in via its tier definition.
- **No new migration.** 044 froze every column C2 needs. New `digest_readiness.reason` strings and the `job_usage.phase='judge'` value are free-text-per-schema (`reason TEXT`; `phase TEXT CHECK (phase <> '')`).
- Worker DB tests use the existing gate (`const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip`); handler-level integration tests are mandatory where a task's deliverable is branch wiring (the C1 rule).
- Frozen reason-string mini-contract added by C2 (persisted to `digest_readiness.reason`, asserted at CP2 and consumed by C4): `'no_usable_diagnosis'`, `'fix_pr_opened'`, `'fix_attempt_failed_with_diff'`, `'fix_attempt_failed_no_diff'`. Investigation-side reasons from C1 (`'validated_cause'`, `'reinvestigating'`, `'quarantined_degenerate'`) are unchanged.
- Model-controlled strings (`test_files[]`, `identifier`, `expected_assertion`) are untrusted input to the harness: path-resolved inside the repo, length-capped, and shell-quoted through one helper; a string that fails validation is a contract violation (tier `attempted`), never an executed command. A declared file whose path does not look like test material arms the judge's probe budget as a ledger anomaly (Task 9/11) — the artificial-toggle residual is the judge's distinctive check plus rubric sampling, per the design's honesty note, not a mechanical guarantee.
- Line numbers in this plan are anchors into the C1 working tree, verified 2026-08-11; where a symbol has moved, locate it by name (`grep -n`) and keep the semantic instruction — the named function is the contract, not the line.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/worker/src/db.ts` (modify) | `ClaimedJob.sourceJobId`; source-linked decision loading (returns decision id); impact-bar query; policy columns; pending-auto-only repoint + human-job refusal; `terminal_fix_job_id`; readiness on fix outcomes; ledger persistence; `UsagePhase` gains `'judge'` |
| `packages/worker/src/index.ts` (modify) | Error-lane routing without confidence; no-usable-diagnosis state; terminal adoption branch; fix-outcome readiness threading |
| `packages/worker/src/agent-fix.ts` (modify) | Source-linked policy authorization with an every-exit evidence finalizer; saved diffs on unsuccessful exits; fail-first orchestration after the gates; tier-based PR predicate; judge invocation; templated copy at the old diff-judge interpolation |
| `packages/worker/src/harness/tool-bridge.ts` + `packages/worker/src/harness/types.ts` (modify) | `declare_failing_test` + `declare_reproduction_impossible` tools; `AgentState` fields |
| `packages/worker/src/harness/fail-first.ts` (create) | Isolated-commit red/green protocol; contract validation + quoting; declared-test runner over the suite-runner's report parsing; restoration contract |
| `packages/worker/src/harness/test-runner.ts` (modify) | `runDeclaredTest` (filtered run + stale-report deletion + report-file parsing); `SuiteRun` gains optional `timedOut`/`truncated` |
| `packages/worker/src/verification-ledger.ts` (modify) | `LedgerRecorder`, `deriveTierRecord`, `detectLedgerAnomalies` beside the frozen types |
| `packages/worker/src/harness/fix-judge.ts` (create) | The judge: own session, fenced instrument inputs, anomaly-gated probe tool (≤3), structured verdict, fail-closed semantics |
| `packages/worker/src/pipeline.ts` (modify) | Recorder ownership + finally-persistence; `candidateDiff` on all needs_human exits; delivery-gate-preserving draft posture incl. reservation replay; judge/tier threading to PR |
| `packages/worker/src/pr.ts` (modify) | Ledger-rendered verification section with CI sub-markers; judge section |
| `packages/worker/src/ci-watch.ts` (modify) | Rewrites only its CI sub-block inside the verification markers; draft→ready promotion disabled for automated PRs |
| `shared/src/types.ts` (modify) | `EvidenceRecord` gains optional `tier_record`, `authorization`, `judge` (append-only) |
| `packages/ingestion/db/queries.go` (modify) | Human fix retry clears `terminal_fix_job_id` |
| `test-fixtures/fix-target-app/` (create) | Plantable-bug fixture repo with a runnable Vitest suite for CP2 |
| `test-e2e/helpers.ts` (modify) | `cleanupTenant` deletes `fix_run_ledger` rows |
| `packages/worker/src/__tests__/purge-fix-run-ledger.ts` (create) | Purge helper for the RESTRICT-FK table, called from every teardown that deletes fix jobs |

**PR train** (each PR = consecutive tasks, merged in order): PR1 = Tasks 1–4 (policy + authorization) · PR2 = Tasks 5–6 (repoint + adoption) · PR3 = Tasks 7–11 (saved diffs, fail-first, ledger, **judge + draft enforcement — one release**) · PR4 = Tasks 12–13 (PR body, readiness) · CP2 = Task 14. The tier-based PR predicate, the judge gate, and always-draft posture (including the ci-watch promotion disable) land in the **same** PR (PR3): no deployed state exists where tier-passing automated PRs open unjudged, undrafted, or auto-promoted. PR4 is rendering and readiness only.

---

### Task 1: `ClaimedJob.sourceJobId` and source-linked decision loading

**Files:**
- Modify: `packages/worker/src/db.ts` — `ClaimedJob` (:210-228), `claimJob` row type (:313-328), RETURNING list (:368-370), mapping (:384-401); new `loadDiagnosisDecisionForSource`; `loadDiagnosisDecision` (:126-149) selects `id, policy_eligible, policy_basis`
- Test: extend `packages/worker/src/__tests__/db.test.ts` (DB-gated; seed helpers `seedTenant` :36, `seedErrorGroupAndJob` :48)

**Interfaces:**
- Consumes: migration 043's `error_group_jobs.source_job_id` column (written today at `db.ts:1989-2001`, never read back); 044's policy columns.
- Produces (consumed by Tasks 2–4):

```ts
// ClaimedJob gains (after sourceId):
  /** The investigate job that produced this fix job's diagnosis; NULL on legacy/human jobs. */
  sourceJobId: string | null;

export interface LoadedDecision {
  id: string;                    // diagnosis_decisions.id — the authorization identity Tasks 4/11 persist
  outcome: DiagnosisOutcome;
  basis: DerivedDecision['basis'];
  confidence: ConfidenceLevel;
  policyEligible: boolean | null;
  policyBasis: { v: 1; identified_users: number; recent_anon_sessions: number } | null;
}

/** Decision for the job's own source investigate job; NULL sourceJobId falls
 *  back to newest-for-group (legacy in-flight jobs — fallback pinned by test). */
export async function loadDiagnosisDecisionForSource(
  errorGroupId: string,
  projectId: string,
  sourceJobId: string | null,
): Promise<LoadedDecision | null>;
```

  SQL: `SELECT id, outcome, basis, confidence, policy_eligible, policy_basis FROM diagnosis_decisions WHERE error_group_id = $1 AND project_id = $2 AND job_id = $3 ORDER BY decided_at DESC, id DESC LIMIT 1` (the `id DESC` tie-breaker makes retried same-job decisions deterministic); when `sourceJobId` is null, drop the `job_id` predicate (newest-for-group — today's `loadDiagnosisDecision` semantics, same tie-breaker added). When the source-scoped query finds nothing (a source job that never inserted a decision), return `null` — do **not** silently fall back to newest; an authorization miss must be visible, not papered over. The decision id reaches the worker through this SELECT; `insertDiagnosisDecision` is unchanged (no `RETURNING` — the fix job always *re-loads* its decision at authorization time, one identity path, no threading).

- [ ] **Step 1: Write the failing tests** in `db.test.ts` (inside the existing `describeDb`):

```ts
it('claimJob exposes source_job_id on the claim row', async () => {
  const { projectId, groupId } = await seedErrorGroupAndJob({ jobType: 'investigate' });
  const inv = await claimJob('w1');
  const lease = leaseFrom(inv!);
  await updateGroupAndCreateFixJob(groupId, projectId, {
    decision: decisionRow({ outcome: 'code_fix' }), sourceJobId: inv!.id,
  }, lease);
  await completeJob(inv!.id, 'w1', inv!.leaseGeneration);
  const fix = await claimJob('w1');
  expect(fix?.jobType).toBe('fix');
  expect(fix?.sourceJobId).toBe(inv!.id);
});

it('loadDiagnosisDecisionForSource returns the decision for the given source job, not the newest', async () => {
  // seed two investigate jobs J1, J2 for one group; insert decision D1 (job_id=J1,
  // policyEligible=true) then D2 (job_id=J2, policyEligible=false) via
  // updateGroupInvestigation's decision field; read both ids back with a direct SELECT.
  const d = await loadDiagnosisDecisionForSource(groupId, projectId, j1Id);
  expect(d?.id).toBe(d1Id);
  expect(d?.policyEligible).toBe(true);
});

it('two decisions for one job at the same decided_at resolve deterministically (id DESC)', async () => {
  // insert two decisions with job_id=J1 and identical decided_at; the loader returns the higher id
});

it('falls back to newest-for-group when sourceJobId is NULL (legacy pin)', async () => {
  const d = await loadDiagnosisDecisionForSource(groupId, projectId, null);
  expect(d?.id).toBe(d2Id); // the newest
});

it('returns null (no fallback) when the named source job has no decision', async () => {
  const d = await loadDiagnosisDecisionForSource(groupId, projectId, jobWithNoDecision);
  expect(d).toBeNull();
});
```

  (Adapt seed-helper names to what `db.test.ts` actually exports — read its `seedErrorGroupAndJob`/`seedPendingJob` first; keep the assertion shapes.)
- [ ] **Step 2: Run → FAIL.** `DATABASE_URL=… pnpm --filter @opslane/worker test -- db.test`
- [ ] **Step 3: Implement.** Three `claimJob` edits (row type :313-328, RETURNING :368-370, mapping :384-401). Add `loadDiagnosisDecisionForSource`; extend `loadDiagnosisDecision`'s SELECT with `id, policy_eligible, policy_basis` so both loaders return `LoadedDecision`.
- [ ] **Step 4: Run → PASS**, plus the full DB-gated worker suite.
- [ ] **Step 5: Commit.** `feat(worker): authorization identity — source_job_id on the claim row, decisions loaded with ids (C2/W2.4)`

### Task 2: Live impact bar + policy columns written on decision insert

**Files:**
- Modify: `packages/worker/src/db.ts` — new `getGroupImpactBar`; `DecisionRow` (:32-47) gains `policyEligible?`/`policyBasis?`; `insertDiagnosisDecision` INSERT column list (:78-81) writes them
- Test: extend `packages/worker/src/__tests__/db.test.ts`

**Interfaces:**
- Produces (consumed by Task 3):

```ts
export interface ImpactBar {
  identifiedUsers: number;
  recentAnonSessions: number;
  eligible: boolean;   // identifiedUsers >= 1 || recentAnonSessions >= 3
}
export async function getGroupImpactBar(errorGroupId: string, projectId: string): Promise<ImpactBar>;

// DecisionRow gains:
  policyEligible?: boolean | null;
  policyBasis?: { v: 1; identified_users: number; recent_anon_sessions: number } | null;
```

  The query — **live** at investigation completion (not `priority_inputs`: the sweeper stamps every ~30 min and investigation completes ~71s after the first event; a new group has no stamp), project-scoped, anonymous semantics matching the sweeper's `bool_and` rule (a session is anonymous only when **all** its events are anonymous). Postgres returns `count(*)` as `bigint` → string in pg; convert with `Number(...)` explicitly:

```sql
SELECT
  (SELECT count(*) FROM error_group_affected_users
    WHERE project_id = $2 AND error_group_id = $1) AS identified_users,
  (SELECT count(*) FROM (
     SELECT session_id FROM error_events
     WHERE project_id = $2 AND error_group_id = $1
       AND session_id IS NOT NULL AND timestamp > now() - interval '7 days'
     GROUP BY session_id HAVING bool_and(end_user_id IS NULL)
   ) anon) AS recent_anon_sessions;
```

  (Verify the affected-users table/column names against the sweeper's queries in `packages/ingestion/priority/` before implementing; if the identified-user source of truth differs — e.g. a `DISTINCT end_user_id` over `error_events` — mirror the sweeper's source exactly and record which one was used in the PR description. The **semantics** above are frozen; the table spelling follows the sweeper.)

- [ ] **Step 1: Failing tests** in `db.test.ts` — the exact bar boundaries, both sides of each threshold:

```ts
it('impact bar: 1 identified user → eligible (threshold, not above it)', ...);
it('impact bar: 0 identified, 3 recent anon sessions → eligible', ...);
it('impact bar: 0 identified, 2 recent anon sessions → NOT eligible (below threshold)', ...);
it('impact bar: 0 identified, 1 anon session → not eligible, numbers exact (AC2.7 basis)', async () => {
  const bar = await getGroupImpactBar(groupId, projectId);
  expect(bar).toEqual({ identifiedUsers: 0, recentAnonSessions: 1, eligible: false });
});
it('a session with one identified and one anonymous event is NOT anonymous (bool_and)', ...);
it('anon sessions older than 7 days do not count', ...);
it('decision insert persists policy_eligible and policy_basis', async () => {
  // updateGroupInvestigation with decision { …, policyEligible: false,
  //   policyBasis: { v: 1, identified_users: 0, recent_anon_sessions: 1 } }
  // then SELECT policy_eligible, policy_basis FROM diagnosis_decisions … and assert both.
});
it('decisions without policy fields insert NULLs (friction/legacy unchanged)', ...);
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `insertDiagnosisDecision` column list gains `policy_eligible, policy_basis` (JSONB via `JSON.stringify`, NULL when absent).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(worker): live impact bar recorded as policy_eligible/policy_basis on the decision row (C2/W2.4)`

### Task 3: Routing without confidence — the impact bar decides, `no_usable_diagnosis` lands

**Files:**
- Modify: `packages/worker/src/index.ts` — `processInvestigateJob` branch ladder (:647-745; fix branch :701-721; parked :722-745; `needs_more_context` :664-680)
- Test: extend `packages/worker/src/__tests__/index.test.ts` (mock seams at :10 `vi.mock('../db.js')`, :62 `vi.mock('../investigate.js')`; helpers `makeJob` :147, `makeGroup` :163)

**Interfaces:**
- Consumes: `getGroupImpactBar` (Task 2), `DecisionRow.policyEligible/policyBasis`.
- Produces — the new error-lane ladder (order preserved; `incomplete` and `not_actionable` branches unchanged from C1):
  1. `incomplete` → unchanged (needs_human / `insufficient_context` / readiness `('ineligible', decisionReason)`).
  2. `needs_more_context` → group write unchanged (needs_human / `insufficient_context`), readiness becomes **`{ status: 'ineligible', reason: 'no_usable_diagnosis' }`** (replacing C1's interim `('pending','reinvestigating')` — the program plan's AC2.6 state; C1's plan explicitly marked this a C2 replacement).
  3. `not_actionable` → unchanged (`insight`, readiness eligible).
  4. `code_fix` (was: `code_fix && confidence === 'high'`): compute `const bar = await db.getGroupImpactBar(...)`; decision row gains `policyEligible: bar.eligible, policyBasis: { v: 1, identified_users: bar.identifiedUsers, recent_anon_sessions: bar.recentAnonSessions }`. When `bar.eligible && job.triggeredBy !== 'reinvestigate_report_only'` → `updateGroupAndCreateFixJob` exactly as today (:701-721, `sourceJobId: job.id` stays). Otherwise → parked `investigated` (today's :722-745 call) with the policy-stamped decision and readiness `('eligible','validated_cause')` (a below-bar validated diagnosis is the report-ready receipt).
  5. There is no confidence read anywhere in the error-lane ladder. `triage.confidence` still flows into the decision row and group fields (storage, not routing).
- **Friction rung: frozen, deliberately.** The friction auto-fix condition (`verdict.confidence === 'high' && autonomyAllowsFix`, `index.ts:914`) is **not touched by C2**. Removing the confidence conjunct without an impact bar would widen automation with no recorded policy basis (the friction impact arithmetic runs over signal sessions, which C3 owns), and disabling the rung would regress shipped opt-in behavior. So the rung keeps its exact current semantics, with a code comment naming the debt: `// C3 replaces this confidence check with the signal-session impact bar (program plan §C3); frozen, not endorsed — see C2 plan Task 3.` This is the plan's one flagged judgment call for owner sign-off; the alternative (freeze → refuse until C3) is a one-line change if the owner prefers a hard stop over the status quo.

- [ ] **Step 1: Failing tests** in `index.test.ts` (the `processInvestigateJob diagnosis routing` suite at :285):

```ts
it('AC2.13 behavioral pair: identical diagnoses with different confidence route identically', async () => {
  for (const confidence of ['high', 'low'] as const) {
    vi.mocked(investigateError).mockResolvedValueOnce(scriptedResult({ outcome: 'code_fix', confidence }));
    vi.mocked(db.getGroupImpactBar).mockResolvedValueOnce({ identifiedUsers: 2, recentAnonSessions: 0, eligible: true });
    await processInvestigateJob(makeJob({ jobType: 'investigate' }), signal());
  }
  expect(vi.mocked(db.updateGroupAndCreateFixJob)).toHaveBeenCalledTimes(2); // both attempted
  const [a, b] = vi.mocked(db.updateGroupAndCreateFixJob).mock.calls;
  expect(a[2].decision?.outcome).toBe(b[2].decision?.outcome);               // same routing shape
});

it('AC2.7: usable code_fix below the bar parks with policy_eligible=false and basis numbers, no fix job', async () => {
  vi.mocked(db.getGroupImpactBar).mockResolvedValueOnce({ identifiedUsers: 0, recentAnonSessions: 1, eligible: false });
  await processInvestigateJob(makeJob(), signal());
  expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
  const call = vi.mocked(db.updateGroupInvestigation).mock.calls.at(-1)!;
  expect(call[2]).toBe('investigated');
  expect(call[3].decision).toMatchObject({
    policyEligible: false,
    policyBasis: { v: 1, identified_users: 0, recent_anon_sessions: 1 },
  });
});

it('AC2.6: needs_more_context lands needs_human/insufficient_context with readiness ineligible/no_usable_diagnosis', async () => {
  // scripted needs_more_context result →
  expect(call[3].readiness).toEqual({ status: 'ineligible', reason: 'no_usable_diagnosis' });
  expect(call[3].reason?.reason_code).toBe('insufficient_context');
  expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
});

it('report-only attribution still never creates a fix job even above the bar', async () => {
  // triggeredBy: 'reinvestigate_report_only', eligible bar → parked, no fix job (C1 guard preserved)
});

it('friction auto_fix rung is byte-for-byte unchanged (frozen pin)', async () => {
  // friction verdict codeCause=true, confidence 'low', friction_autonomy 'auto_fix'
  // → NO fix job (rung still requires high); confidence 'high' → fix job. Pins the freeze.
});
```

- [ ] **Step 2: Run → FAIL** (`getGroupImpactBar` unmocked/absent; confidence branch still live).
- [ ] **Step 3: Implement the ladder rewrite.** Delete the `triage.confidence === 'high'` conjunct at :709. Then `grep -n "confidence ===" packages/worker/src/index.ts packages/worker/src/agent-fix.ts` — the survivors must be exactly the frozen friction rung (:914) and the authorization check Task 4 deletes (agent-fix.ts:472); anything else is a missed routing read.
- [ ] **Step 4: Run the full worker unit suite → PASS** (existing routing tests asserting the old parked-medium behavior must be updated to the new contract in this task, not deleted).
- [ ] **Step 5: Commit.** `feat(worker): impact bar replaces confidence in error-lane fix routing; no-usable-diagnosis is the only stop (C2/W2.4)`

### Task 4: Authorization by the job's own decision — policy predicate, recorded identity on every exit

**Files:**
- Modify: `packages/worker/src/agent-fix.ts` — authorization block (:449-490; the `decision.confidence !== 'high'` check at :472 dies); `AgentFixInput` gains `sourceJobId: string | null`; **an every-exit evidence finalizer**
- Modify: `packages/worker/src/pipeline.ts` — thread `sourceJobId` from input into `runAgentFix` (`PipelineInput` at :21 gains `sourceJobId?: string | null`; `index.ts` passes `job.sourceJobId`)
- Modify: `shared/src/types.ts` — `EvidenceRecord` (:228-246) gains the authorization stamp (append-only optional)
- Test: extend `packages/worker/src/__tests__/agent-fix.test.ts` (db mock seam :46-54); extend `packages/worker/src/__tests__/source-job.integration.test.ts`

**Interfaces:**
- Consumes: `loadDiagnosisDecisionForSource` (Task 1).
- Produces:

```ts
// shared/src/types.ts — EvidenceRecord gains:
  /** Which diagnosis decision authorized this automated attempt, and how it was found. */
  authorization?: {
    decision_id: string | null;
    source: 'source_job' | 'newest_fallback' | 'human_bypass';
    policy_eligible: boolean | null;
  };
```

- Authorization rule for automated jobs (`triggeredBy !== 'human'`, `kind === 'error'` — the friction/human skips at :449-456 are unchanged): load via `loadDiagnosisDecisionForSource(errorGroupId, projectId, sourceJobId)`; accept iff `decision.outcome === 'code_fix' && decision.policyEligible === true`. A `null` decision or `policyEligible !== true` → today's needs_human refusal path with the existing reason code, plus the authorization stamp with what was found. Legacy decisions predating Task 2 have `policy_eligible IS NULL` → refused (`policyEligible === true` is strict); this is deliberate: an unaudited legacy authorization must not survive the cutover, and the parked group is re-attemptable by human click.
- **Every-exit stamping is not free today** — early returns exist *before* the evidence recorder is created (missing GitHub key at :417-427; clone failure at :590-603 returns without evidence). Task 4 therefore: (a) creates the evidence recorder and the authorization stamp at function entry, before the authorization block; (b) routes every `return` through one local `finalize(result)` helper that attaches `evidence` (with `authorization`) if absent — mechanical sweep: `grep -n "return {" packages/worker/src/agent-fix.ts` inside `runAgentFix` and route each. AC2.8 reads the stamp from the persisted `verification_evidence` on any terminal state.
- The NULL-source fallback to newest-for-group is **kept as specified by the parent program plan and receipts §5b** (AC2.8 pins it): it exists only for legacy in-flight jobs enqueued before this deploy, every use is visibly stamped `source: 'newest_fallback'`, and the strict `policyEligible === true` predicate means a fallback decision still needs a post-cutover policy stamp to authorize anything — the combination bounds the fallback's blast radius to zero silent authorizations.
- `evidence.authorization.source` is `'newest_fallback'` exactly when `sourceJobId` was null; `'human_bypass'` (with `decision_id: null`) on human-triggered jobs.

- [ ] **Step 1: Failing tests** in `agent-fix.test.ts`:

```ts
it('accepts a code_fix decision whose own row says policy_eligible, regardless of confidence', async () => {
  mockDecision({ id: 'd1', outcome: 'code_fix', confidence: 'low', policyEligible: true });
  // run reaches the sandbox phase (assert loadDiagnosisDecisionForSource called with input.sourceJobId)
});
it('refuses when policy_eligible is false or NULL', async () => {
  for (const pe of [false, null]) { /* → needs_human refusal, no sandbox created */ }
});
it('AC2.8: the persisted authorization names the source decision, not the newest', async () => {
  // input.sourceJobId = 'J-old'; mock returns { id: 'd-old', … } for that source;
  const result = await runAgentFix(input({ sourceJobId: 'J-old' }));
  expect(result.evidence?.authorization).toMatchObject({ decision_id: 'd-old', source: 'source_job' });
});
it('AC2.8: NULL source falls back to newest and says so', async () => {
  expect(result.evidence?.authorization).toMatchObject({ decision_id: 'd-newest', source: 'newest_fallback' });
});
it('human trigger bypasses decisions entirely and stamps human_bypass', ...);
it('a missing-GitHub-key exit still carries the authorization stamp (every-exit finalizer)', async () => {
  // no token configured → early refusal; result.evidence?.authorization present
});
```

  And in `source-job.integration.test.ts` (real DB): drive `processFixJob` for a claimed fix job whose `source_job_id` names the older of two investigations (mock `runPipeline` the way `index.test.ts:68` does, capture its input) and assert the pipeline input's `sourceJobId` is the older job id — proving the claim-row column (Task 1) reaches authorization, not just the payload.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Delete the confidence conjunct; wire `loadDiagnosisDecisionForSource`; recorder + stamp at entry; `finalize()` on every return.
- [ ] **Step 4: Run → PASS**, including the existing authorization tests (human bypass, friction skip).
- [ ] **Step 5: Commit.** `feat(worker): fix authorization reads the job's own decision and stamps every exit (C2/W2.4)`

### Task 5: Atomic repoint of reused pending fix jobs — pending auto jobs only

**Files:**
- Modify: `packages/worker/src/db.ts` — `updateGroupAndCreateFixJob` reuse path (:1923-1966; the `COALESCE` assignments at :1940-1942 and the reuse SELECT's predicate)
- Test: rewrite the pin in `packages/worker/src/__tests__/source-job.integration.test.ts:100`; add the repoint + human-provenance + claimed cases

**Interfaces:**
- Produces, three distinct reuse behaviors (read the current reuse SELECT first — per the working tree it matches both `pending` and `claimed` jobs and does not filter `triggered_by`):
  1. **Human job exists (`triggered_by='human'`, pending or claimed):** checked first, inside the transaction, `FOR UPDATE` — return `{ created: false, reason: 'pending_human_job' }` (extend `FixJobResult.reason`'s union). Never repointed (repointing would swap a human-authorized payload while keeping bypass semantics), never duplicated (the human attempt supersedes; the decision row and readiness still insert).
  2. **Pending auto job:** `payload`, `source_job_id`, and `platform` are **overwritten unconditionally** with the new investigation's values (newest decision owns the job), in the same transaction that inserts the new decision row and readiness write — AC2.9's atomicity.
  3. **Claimed auto job (a fix attempt is running right now):** reused as today **without repointing** — the running worker claimed a payload and must finish against it (mutating a claimed job's payload under a live lease is the race the lease contract exists to prevent); the decision row still inserts, and the running attempt's authorization-by-source keeps it internally consistent.
  The existing test "backfills a reused pending fix only when source_job_id is null" pins the old `COALESCE` behavior and is **replaced**, not appended to.

- [ ] **Step 1: Rewrite the failing tests** (DB-gated):

```ts
it('AC2.9: reusing a pending auto fix job repoints payload, source_job_id, and decision atomically', async () => {
  // investigation 1 → creates pending fix job F (auto) with source_job_id=J1, payload.diagnosis D1
  // investigation 2 (same group) → updateGroupAndCreateFixJob with sourceJobId=J2, diagnosis D2
  const row = await selectJob(F.id);
  expect(row.source_job_id).toBe(J2);
  expect(row.payload.diagnosis.one_line_description).toBe(D2.one_line_description);
  const newest = await loadDiagnosisDecisionForSource(groupId, projectId, J2);
  expect(newest).not.toBeNull();  // decision row inserted in the same tx
});

it('a pending human fix job is never repointed and never duplicated', async () => {
  // seed a pending fix job with triggered_by='human', guidance 'check the modal'
  const result = await updateGroupAndCreateFixJob(groupId, projectId, { …, sourceJobId: J2 }, lease);
  expect(result).toMatchObject({ created: false, reason: 'pending_human_job' });
  const row = await selectJob(H.id);
  expect(row.source_job_id).toBeNull();          // untouched
  expect(row.guidance).toBe('check the modal');  // untouched
  expect(await countFixJobs(groupId)).toBe(1);   // no duplicate
});

it('a CLAIMED auto fix job is reused but not repointed (live lease owns its payload)', async () => {
  // claim F with a worker; second investigation arrives →
  const row = await selectJob(F.id);
  expect(row.source_job_id).toBe(J1);            // untouched while claimed
  expect(await countFixJobs(groupId)).toBe(1);   // still no duplicate
});
```

- [ ] **Step 2: Run → FAIL** (COALESCE preserves stale linkage; no trigger/status discrimination).
- [ ] **Step 3: Implement** — human-job check first, then the auto reuse split by status; leave lease semantics untouched.
- [ ] **Step 4: Run the DB-gated suite → PASS.**
- [ ] **Step 5: Commit.** `fix(worker): newest decision owns a reused pending auto fix job; human and claimed jobs are never repointed (C2/W2.4, AC2.9)`

### Task 6: Terminal adoption via `terminal_fix_job_id`

**Files:**
- Modify: `packages/worker/src/db.ts` — `updateGroupStatus` (:738-828) gains `terminalFixJobId?: string`, written in the same UPDATE; `getErrorGroup` (locate by name — `grep -n "export async function getErrorGroup" packages/worker/src/db.ts`) selects `terminal_fix_job_id`
- Modify: `packages/worker/src/index.ts` — `processFixJob` adoption branch (the `pr_created`/`pr_draft` adoption at :1113-1120 gains the sibling condition)
- Modify: `packages/ingestion/db/queries.go` — human fix retry (`:1305-1317`) clears the marker: `terminal_fix_job_id = NULL` in the same statement that flips the group for retry
- Test: `packages/worker/src/__tests__/terminal-adoption.integration.test.ts` (create, DB-gated); extend `packages/ingestion/db/error_group_ingestion_test.go`

**Interfaces:**
- Produces: the terminal `needs_human` write from a fix job sets `terminal_fix_job_id = job.id` **in the same UPDATE** as the status (no second statement — a crash between two statements is the failure this column exists to close). Adoption: `processFixJob` early-returns (adopting, completing without re-execution) when `group.terminal_fix_job_id === job.id`, exactly like the existing `pr_created` adoption. Why: job completion happens in the poller (`poller.ts:140`), outside the handler, so a lease loss between the group write and `completeJob` would re-run the whole attempt — sandbox spend, a second ledger run, and a duplicate PR push. The Go retry-clear keeps a later human attempt from being swallowed by a stale marker.

- [ ] **Step 1: Failing test** (AC2.12's shape, using the poller's fault-injection seam at `poller.ts:139`):

```ts
it('AC2.12: a kill between terminal group write and job completion is adopted, not re-run', async () => {
  // real DB; mock runPipeline to return a needs_human result with a diff;
  // drive processOneJob with beforeComplete: () => { throw new Error('killed'); }
  // → job stays claimed/failed, group is needs_human with terminal_fix_job_id = F
  await expireAndReclaimWithSameWorker(F);      // db.test.ts helper :115
  const runs = vi.mocked(runPipeline).mock.calls.length;
  await processOneJob(/* the requeued claim */);
  expect(vi.mocked(runPipeline).mock.calls.length).toBe(runs); // adopted — no second execution
  // exactly one attempt's artifacts: candidate_diff unchanged, job now completed
});
```

  Go side: seed a group with `terminal_fix_job_id` set; call the human-retry path; assert the marker is NULL and a new `fix` job with `triggered_by='human'` exists.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement all three sides.**
- [ ] **Step 4: Run** worker DB-gated suite + `(cd packages/ingestion && go build ./... && go test ./db/...)` → PASS, zero skips with `DATABASE_URL` set.
- [ ] **Step 5: Commit.** `feat(worker): terminal fix adoption marker — lease loss re-runs nothing (C2/W2.4, AC2.12)`

### Task 7: Saved diffs on unsuccessful terminal exits

**Files:**
- Modify: `packages/worker/src/agent-fix.ts` — the diff-less unsuccessful exits: gave-up/declined (:872-884), agent budget/turn failure (:1032-1043), the harness catch-all (:1267-1275)
- Modify: `packages/worker/src/pipeline.ts` — `candidateDiff` mapping (:245, :274, :355): populated for **every** needs_human result carrying a diff, not only `deliveryPosture === 'draft'`
- Test: `packages/worker/src/__tests__/agent-fix-saved-diff.test.ts` (create); extend `packages/worker/src/__tests__/pipeline.test.ts`

**Interfaces:**
- Consumes: `extractDiff(sandbox, platform)` (`harness/sandbox-repo.ts:271-292`), the existing `AgentFixResult.diff` field (:119) and the `boundDiff` scrub/cap (`pipeline.ts:93-101`).
- Produces: on every unsuccessful terminal exit **where a sandbox exists**, attempt `extractDiff` before teardown and keep the result only when non-empty — no attempt to track "did the agent edit" from tool-call names (shell commands mutate, mutation tools fail; observed-tool heuristics are unsound — the empty-diff check is the truth). Extraction is guarded: `SandboxUnavailableError` or any extraction error → `diff` stays undefined and the original failure class is preserved, never masked. Failure classes that never reach the sandbox (clone failure, missing key, authorization refusal) stay diff-less by construction and render as "failed before producing a change" downstream (C4's copy; C2 only guarantees the data shape). `pipeline.ts` maps `result.diff → candidateDiff` for all needs_human exits; persistence needs no new path (`index.ts:1380` → `updateGroupStatus` → `db.ts:793` `candidate_diff`).

- [ ] **Step 1: Failing tests:**

```ts
it('AC2.10: budget exhaustion after edits returns the working diff', async () => {
  // scripted agent loop: one successful edit turn, then budget exhaustion;
  // mock extractDiff to return 'SAMPLE_EDIT_MARKER diff'
  const result = await runAgentFix(input());
  expect(result.status).toBe('needs_human');
  expect(result.reason?.reason_code).toBe('budget_exhausted');
  expect(result.diff).toContain('SAMPLE_EDIT_MARKER');
});
it('an empty extracted diff is dropped, not persisted as an empty string', async () => {
  vi.mocked(extractDiff).mockResolvedValueOnce({ diff: '', affectedFiles: [] });
  expect((await runAgentFix(input())).diff).toBeUndefined();
});
it('a dead sandbox at extraction time keeps the original failure and no diff', async () => {
  vi.mocked(extractDiff).mockRejectedValueOnce(new SandboxUnavailableError('gone'));
  const result = await runAgentFix(input());
  expect(result.reason?.reason_code).toBe('budget_exhausted'); // not masked
  expect(result.diff).toBeUndefined();
});
it('pipeline maps a needs_human diff into candidateDiff regardless of draft posture', async () => {
  // prPosture 'verified_only' (draft path off) + needs_human result with diff
  expect(pipelineResult.candidateDiff).toContain('SAMPLE_EDIT_MARKER');
});
it('pre-sandbox failures stay diff-less (no extraction call)', ...);
```

- [ ] **Step 2: Run → FAIL** (extraction only runs on success paths today).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS**, including `pipeline.test.ts` and `precision-gate.test.ts` untouched behavior.
- [ ] **Step 5: Commit.** `fix(worker): unsuccessful fix attempts keep their working diff (C2/W2.1, #73)`

### Task 8: The declared-test contract — two new fix-agent tools

**Files:**
- Modify: `packages/worker/src/harness/tool-bridge.ts` — two new tools after `submit_diagnosis` (:205)
- Modify: `packages/worker/src/harness/types.ts` — `AgentState` gains the declaration fields (the interface lives here, not in tool-bridge; strict TS fails otherwise)
- Modify: `packages/worker/src/agent-fix.ts` — system-prompt instructions for the contract
- Test: extend `packages/worker/src/__tests__/agent-fix.test.ts` (or the tool-bridge test file if one exists — check first)

**Interfaces:**
- Produces (consumed by Task 9): tools registered in `createToolBridge` (:33), **using the bridge's actual property spelling** (`inputSchema`, per the existing tools at :58/:70 — the JSON below is the schema content, not the property name):

```ts
{
  name: 'declare_failing_test',
  description: 'Declare the regression test that proves this bug: it must FAIL on the unmodified base commit and PASS with your fix. The harness will verify both mechanically; a test that passes on base voids the attempt.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    test_files: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' },
      description: 'Repo-relative paths of every file the test needs that you added or modified: the test file plus any fixtures, helpers, or config. The harness applies ONLY these files to the base commit for the red run.' },
    identifier: { type: 'string', maxLength: 300, description: 'The exact test name/id the runner reports (e.g. the it() title, or the full pytest node id).' },
    expected_assertion: { type: 'string', maxLength: 500, description: 'A distinctive substring of the failure message expected on the base commit (assertion message, not a stack line).' },
  }, required: ['test_files', 'identifier', 'expected_assertion'] },
},
{
  name: 'declare_reproduction_impossible',
  description: 'Declare that a failing regression test cannot be written, with the concrete reason (e.g. the bug needs a browser event loop the sandbox lacks). This caps the attempt at tier "checked".',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    reason: { type: 'string', maxLength: 600 },
  }, required: ['reason'] },
}
```

  `AgentState` (in `harness/types.ts`) gains `declaredTest?: { testFiles: string[]; identifier: string; expectedAssertion: string }` and `reproductionImpossibleReason?: string`; a later call overwrites an earlier one; calling both keeps the **last** call (the model changed its mind). Tool results confirm receipt in one sentence; **neither tool executes anything** (schema-level `maxLength` caps are the only validation here — path/quoting validation is the harness's job at execution time, Task 9, so a bad declaration degrades the tier instead of erroring the tool call). Prompt addition (in the fix system prompt near the existing workflow steps at :287-306): *"Before you finish: write a regression test that fails on the current code because of this bug, then call declare_failing_test with its files, name, and the exact failure message you expect on the unfixed code. If such a test is genuinely impossible here, call declare_reproduction_impossible with the concrete reason. An attempt with neither declaration cannot open a PR."*
- Note: `TierRecord.declaredTest` is frozen as `{ identifier, expectedAssertion }` (C0); `test_files` lives only on the agent state and the ledger's command lines — it is the harness's patch-isolation input, not part of the frozen record.

- [ ] **Step 1: Failing tests:** scripted agent run calls `declare_failing_test` → state carries the contract verbatim; calling `declare_reproduction_impossible` after it replaces it (last-call-wins asserted both orders); schema is sealed (`additionalProperties: false`) and caps are present; neither tool issues sandbox commands (assert on the sandbox mock).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement. Step 4: Run → PASS**, incl. `pnpm --filter @opslane/worker build` (strict TS across both files).
- [ ] **Step 5: Commit.** `feat(worker): the fix agent declares its expected-failure contract (C2/W2.2)`

### Task 9: Fail-first — isolated-commit red/green after the gates, the ledger recorder, tier derivation

**Files:**
- Create: `packages/worker/src/harness/fail-first.ts`
- Modify: `packages/worker/src/harness/test-runner.ts` — `runDeclaredTest` + `SuiteRun` gains optional `timedOut?: boolean` / `truncated?: boolean`
- Modify: `packages/worker/src/verification-ledger.ts` — add `LedgerRecorder` + `deriveTierRecord` beside the frozen types
- Modify: `packages/worker/src/agent-fix.ts` — orchestration **after** the existing gates; the PR predicate (:1151-1189); `baseSha` capture at sandbox setup
- Modify: `shared/src/types.ts` — `EvidenceRecord` gains `tier_record?` (append-only optional, snake-case wire shape)
- Test: `packages/worker/src/__tests__/fail-first.test.ts` (create); extend `packages/worker/src/__tests__/agent-fix.test.ts`, `packages/worker/src/harness/__tests__/test-runner.test.ts`

**Interfaces:**
- Consumes: declared contract (Task 8), `SandboxRuntime.commands.run` (`sandbox-runtime.ts:60-83`), `planTests`/`runSuite`/`compareSuiteRuns` (`harness/test-runner.ts:142/:200/:99`).
- **Position in the run, dictated by the existing retry loop:** the agent cascade retries attempts and resets the tree between them (`agent-fix.ts:958-960`, :987-989, :763-765), and the post-patch suite + build gate run inside each attempt (:900-999). Fail-first therefore runs **once, after the cascade settles on its final candidate and after the post-suite/build gates have passed on the working tree** — between the build gate and the diff judge (:1104). Committing F earlier would poison the retry resets. The ledger is chronological execution order: `suite_baseline`, agent attempts' `suite_post_patch` + `build` entries, then `repro_red`, `repro_green` — the PR body renders the *logical* red-then-green story from roles, not from sequence position. `extractDiff` (:898) has already captured the shipped diff before fail-first commits anything (the PR content is that diff string, re-applied in a fresh clone by `gitCommitAndPush`, `repo-clone.ts:241-266`).
- Produces:

```ts
// harness/fail-first.ts
export interface FailFirstInput {
  sandbox: SandboxRuntime;
  platform: Platform;
  plan: TestPlan;                        // from planTests, reused
  /** HEAD at sandbox setup, captured by agent-fix right after createRepoSandbox
   *  via sandbox git rev-parse (RepoSandbox does not expose it today — capture
   *  it explicitly and thread it here AND into the ledger entries' commitSha). */
  baseSha: string;
  declaredTest: { testFiles: string[]; identifier: string; expectedAssertion: string } | null;
  reproductionImpossibleReason: string | null;
  recorder: LedgerRecorder;
}
export interface FailFirstOutcome {
  redObserved: boolean;                  // declared test failed on base, matching the contract
  greenObserved: boolean;                // declared test passed with the fix
  contractViolation: string | null;      // human-readable, computed: why red/green did not hold
  fixCommitSha: string | null;           // commit F
  declaredTestSource: string | null;     // concatenated declared-file contents (judge input), see below
}
export async function runFailFirst(input: FailFirstInput): Promise<FailFirstOutcome>;

// harness/test-runner.ts
/** Run ONLY the declared test, via the plan's runner, grading from the runner's
 *  REPORT FILE (not stdout): deletes SUITE_RESULTS_PATH / PYTEST_RESULTS_PATH
 *  first (stale-report protection, mirroring :214-235), builds the filtered
 *  command per plan.kind — vitest/jest binary: `<base> <files...> -t <shq(identifier)>`;
 *  pytest: the identifier MUST be a full node id, passed positionally
 *  (`python -m pytest <shq(nodeid)>` — `-k` is an expression filter, wrong tool);
 *  npm-script plans cannot target a single test → return
 *  { runnable: false, reason: 'npm_script_not_filterable' } and the caller
 *  records a contract violation. Parses per-test status + failure message from
 *  the report file the way runSuite does. */
export async function runDeclaredTest(sandbox, plan, testFiles, identifier):
  Promise<{ runnable: boolean; reason?: string; run?: SuiteRun; failureMessage?: string }>;

// verification-ledger.ts — the recorder is CREATED BY THE PIPELINE and passed
// down through runAgentFix, so entries survive any throw (Task 10 persists in
// a finally). Harness-written only; nothing model-generated creates entries.
// EVERY invocation records — including each attempt inside withInfraRetry
// (agent-fix.ts:611-614): the retry wrapper takes the recorder and records the
// first, hidden execution too; an executed command that vanishes from the audit
// is the defect this table exists to prevent.
export interface LedgerRecorder {
  runId: string;                                        // crypto.randomUUID() per execution
  record(entry: Omit<LedgerEntry, 'jobId' | 'projectId' | 'runId' | 'entrySeq' | 'notRun'>,
         role: LedgerRole): void;                       // entrySeq auto-increments
  finalizeNotRun(checks: string[]): void;               // MUST be called after the last record();
                                                        // sets notRun on the final entry (empty [] on all others)
  entries(): LedgerEntry[];
  roles(): Array<{ entrySeq: number; role: LedgerRole; assertionMatched?: boolean }>;
}
export type LedgerRole = 'suite_baseline' | 'repro_red' | 'repro_green' | 'suite_post_patch' | 'build';
export function createLedgerRecorder(jobId: string, projectId: string): LedgerRecorder;

// verification-ledger.ts
export function deriveTierRecord(args: {
  declaredTest: { identifier: string; expectedAssertion: string } | null;
  reproductionImpossibleReason: string | null;
  redObserved: boolean;
  greenObserved: boolean;
  suiteNewFailures: string[] | null;     // from compareSuiteRuns; null = suite not comparable
  suiteDiscovered: number | null;        // SuiteRun.total on the post-patch run
  buildPassed: boolean | null;
  qualityConfirmed: boolean | null;      // the existing diff-judge verdict
}): TierRecord;
```

  `truncated`/`timedOut` on suite/build entries come from the extended `SuiteRun` fields (populated where the sandbox command result exposes them; `false` otherwise — the columns are NOT NULL). The `roles()` map is the worker-local, **in-memory** bridge from raw ledger rows to labeled PR-body lines (Task 12) — the frozen `LedgerEntry`/table carry no check-kind column by design; the persisted labeled record is `EvidenceRecord.checks` (each fail-first command also recorded there with `name` = the role and an `output_tail` that includes the matched failure message on the red run). `declaredTestSource`: the declared files' contents read from commit F, concatenated with `--- <path> ---` headers, capped at 30,000 chars total (truncation marker appended); an unreadable file contributes `--- <path> (unreadable) ---`.

  **Tier rules, mechanical (design decision 4):** `'reproduced'` ⇔ `declaredTest` present ∧ `redObserved` ∧ `greenObserved` ∧ `suiteNewFailures` is an empty array (set containment: every failure with the fix also failed on base — no "explained delta" path in v1) ∧ `suiteDiscovered > 0`. `'checked'` ⇔ not reproduced ∧ `reproductionImpossibleReason` present ∧ empty `suiteNewFailures` ∧ `buildPassed` ∧ `qualityConfirmed`. Everything else ⇔ `'attempted'`. A declared test that **passes on base** is a contract violation → never `reproduced`, and (because a violated contract is not "reproduction impossible") never `checked` — AC2.3's refusal is this line. **The tier alone does not open a PR** — see the predicate below.

  **Contract validation before any execution** (untrusted model strings): every `testFiles[]` entry must resolve inside the repo (the `resolveInsideRepo` pattern from C1's validator; reject `..`, absolute paths, and paths not present in commit F); `identifier` and `expected_assertion` are rejected if they contain single quotes, backslashes, or control characters (they are interpolated into a shell string for `sandbox.commands.run`). All command arguments pass through one quoting helper (`shq(s: string): string` — single-quote wrapping with `'\''` escaping, exported for tests). A validation failure sets `contractViolation` (e.g. `'contract_invalid: test file escapes the repository'`) and skips execution — tier `attempted`, never an executed command. **Residual honestly stated:** a declared "test file" can be any repo path (fixtures and config legitimately live outside test directories), so a declared file whose path matches none of `/\.(test|spec)\./`, `/__tests__\//`, `/^tests?\//`, `/conftest|fixture/i` is reported by `detectLedgerAnomalies` (Task 11) and arms the judge's probe budget — mechanical checks bound the injection surface; the artificial-toggle risk is the judge's distinctive check plus rubric sampling (design honesty note), not a harness guarantee.

  **The red/green protocol, isolated commits (never stash/pop):** every command recorded via `recorder.record` with `commitSha` = `git rev-parse HEAD` and `workdirDirty` = `git status --porcelain` non-empty at command time, and mirrored into the evidence recorder as a named check:
  1. Record the original branch name (`git rev-parse --abbrev-ref HEAD`). Commit the agent's work with explicit identity (no global config assumed): `git -c user.email=fix@opslane.dev -c user.name="Opslane Fix Agent" add -A && git commit -m "opslane: candidate fix" --allow-empty` → commit F (`--allow-empty` because the agent may have committed by itself mid-run; F is "the fix state", whatever HEAD+tree hold).
  2. `git checkout -B opslane-repro <baseSha>` then `git checkout <F> -- <testFiles...>` — the tree holds only the declared files on the base commit.
  3. `runDeclaredTest(sandbox, plan, testFiles, identifier)`. **Red criteria, compared by the harness, not prose:** the run is `runnable`, its report names `identifier` as failed, and `expected_assertion` is a substring of that test's failure message from the report file. Record (counts from the report; `truncated`/`timedOut` from the run).
  4. `git checkout <original-branch>` (tree = F). `runDeclaredTest` again → green criteria: report names `identifier` as passed. Record.
  5. **Restoration contract:** the protocol runs inside try/finally; the finally executes `git checkout <original-branch> && git reset --hard <F> && git clean -fd` — tracked state reset to F **and red-run artifacts removed** (`clean -fd`: untracked report files, caches, and anything the red run generated must not leak into later steps; the diff judge and PR content are already captured from the diff string, so nothing shipped depends on the tree after this point). If restoration itself fails, throw `VerificationInfraError` (the run is unusable; existing infra handling requeues).
  **Sandbox-death rule, one semantic:** `SandboxUnavailableError` anywhere in the protocol **rethrows** — the existing `VerificationInfraError` classification at `agent-fix.ts:1239-1263` requeues, exactly as for any other infra death (a dead sandbox cannot be restored, so a "recorded violation" would lie about the tree state). An ordinary command *timeout with the sandbox alive* records `timedOut: true` on the entry and sets `contractViolation: 'infra: declared test timed out'` — not evidence about the patch, tier `attempted`, run continues to terminal.
  When `declaredTest` is null (agent declared impossible, or declared nothing): skip the protocol; the harness terminal path calls `recorder.finalizeNotRun(['repro_red', 'repro_green'])`.
- The existing suite runs (baseline at :616-646, post-fix at :900-953) and build gate (:966-995) each also `recorder.record` their execution with their role — one recorder covers the whole attempt, including retried invocations (the `withInfraRetry` note above).
- **The PR predicate rewrite (:1151-1189), gates preserved:** `verified := tierRecord.tier === 'reproduced' && buildGatePassed && qualityConfirmed` (the ready candidate); `draftEligible := tierRecord.tier === 'checked'` (whose tier definition already folds in suite/build/quality). Nothing the pipeline gates on today (baseline suite, build gate, diff judge, precision floor) is removed — fail-first is a strictly additional predicate. The precision-gate floor check stays exactly where it is (`precision-gate.test.ts` behavior preserved: it can still only demote). `AgentFixResult` gains `ledger?: LedgerEntry[]`, `ledgerRoles?: ReturnType<LedgerRecorder['roles']>`, `tierRecord?: TierRecord`, and `declaredTestSource?: string | null`; `EvidenceRecord.tier_record` carries the snake-case mirror `{ tier, declared_test, reproduction_impossible_reason }`.

- [ ] **Step 1: Failing unit tests** for the pure parts first, in `fail-first.test.ts`:

```ts
describe('deriveTierRecord', () => {
  it('red+green+clean suite+nonzero discovered → reproduced', ...);
  it('AC2.3: declared test passing on base → attempted, never reproduced or checked', () => {
    const t = deriveTierRecord({ ...base, redObserved: false, greenObserved: true,
      reproductionImpossibleReason: null, suiteNewFailures: [] });
    expect(t.tier).toBe('attempted');
  });
  it('declared-impossible + suite/build/quality green → checked', ...);
  it('a single new suite failure blocks reproduced (set containment, no explained delta)', ...);
  it('no declaration at all → attempted', ...);
  it('zero discovered tests blocks reproduced', ...);
});
describe('contract validation', () => {
  it('rejects a test file outside the repo (../escape) without executing anything', ...);
  it('rejects identifiers containing single quotes or control chars', ...);
  it('shq round-trips hostile strings safely', () => {
    expect(shq(`a'b`)).toBe(`'a'\\''b'`);
  });
});
describe('LedgerRecorder', () => {
  it('assigns monotonically increasing entrySeq under one runId', ...);
  it('finalizeNotRun lands on the final entry only', ...);
  it('roles() maps entrySeq to check roles', ...);
});
```

  In `test-runner.test.ts`: `runDeclaredTest` deletes the stale report file before running (seed a stale JSON naming the identifier as failed, script a run that produces no report → graded as not-runnable/infra, NOT as red from the stale file); npm-script plans → `{ runnable: false, reason: 'npm_script_not_filterable' }`; pytest identifiers without `::` (not a node id) → not runnable, contract violation. Then the protocol tests with a scripted sandbox mock (pattern: `agent-fix.test.ts`'s sandbox mock): assert the exact git command sequence (identity-flagged commit → checkout -B repro baseSha → checkout F -- testFiles → test → checkout original branch → test → restoration triple), that red-run mismatch on `expected_assertion` yields `redObserved: false` with a `contractViolation` naming the mismatch, that `SandboxUnavailableError` mid-protocol **rethrows** (and the caller requeues via `VerificationInfraError`), and that the finally's restoration (`checkout && reset --hard && clean -fd`) runs even when the red run throws.
- [ ] **Step 2: Run → FAIL. Step 3: Implement `fail-first.ts` + `runDeclaredTest` + recorder + `deriveTierRecord`.**
- [ ] **Step 4: Wire into `agent-fix.ts`** after the build gate and before the diff judge; capture `baseSha` right after `createRepoSandbox` (one `git rev-parse HEAD` through the sandbox); extend `agent-fix.test.ts`: a scripted run with a valid contract reaches `tierRecord.tier === 'reproduced'` and `result.ledger` contains baseline, post-suite, build, repro_red, repro_green entries (chronological) with `roles()` mapping them; a contract-less run yields `attempted` with the final entry's `notRun` naming the repro checks; a reproduced tier with `buildGatePassed=false` does NOT set `verified` (gate preservation); a retried suite run produces one ledger entry per invocation.
- [ ] **Step 5: Run the full worker suite → PASS** (`precision-gate.test.ts` must stay green unmodified — the floor's demote-only contract is the invariant).
- [ ] **Step 6: Commit.** `feat(worker): fail-first red/green protocol with a harness-written ledger and mechanical tiers (C2/W2.2)`

### Task 10: Ledger persistence — throw-proof

**Files:**
- Modify: `packages/worker/src/db.ts` — `insertFixRunLedger(entries: LedgerEntry[]): Promise<void>`
- Modify: `packages/worker/src/pipeline.ts` — creates the recorder, passes it into `runAgentFix`, and persists `recorder.entries()` in a **`finally`** around the fix phase (entries survive `VerificationInfraError` and any unexpected throw; persistence errors are logged, never mask the original failure)
- Create: `packages/worker/src/__tests__/purge-fix-run-ledger.ts` (mirror `purge-diagnosis-decisions.ts`), **called from `db.test.ts`'s `cleanupTestData` (:99) and every other teardown that deletes fix jobs** — `grep -rn "purge-diagnosis-decisions" packages/worker/src/__tests__/` and mirror each call site
- Modify: `test-e2e/helpers.ts` — `cleanupTenant` (:612-671) deletes `fix_run_ledger` rows before deleting jobs (the FK is `ON DELETE RESTRICT`)
- Test: `packages/worker/src/__tests__/fix-run-ledger.integration.test.ts` (create, DB-gated)

**Interfaces:**
- Produces: one multi-row INSERT, `ON CONFLICT (run_id, entry_seq) DO NOTHING` (idempotent under retry — a replayed pipeline with the same recorder cannot double-write; a re-executed attempt has a fresh `runId`, so both runs' rows coexist and are distinguishable, which is the audit intent). `insertFixRunLedger([])` is a **no-op** (no generated zero-row INSERT). Persisting in the pipeline's `finally` — before delivery/terminal handling on the success path, and on the throw path too — means AC2.12's adopted run finds the attempt's artifacts durable and "records every executed check" holds even when the run dies after executing commands. No lease guard: the ledger is an audit append; the composite FK `(job_id, project_id)` enforces tenancy.
- **Production deleters:** `grep -rn "DELETE FROM error_group_jobs\|error_group_jobs.*CASCADE" packages/` — every production path that deletes jobs (retention, tenant delete, admin) must delete matching `fix_run_ledger` rows first; if the grep finds none (likely — jobs are currently retained), record that finding in the PR description so the RESTRICT FK's blast radius is a documented fact, not a surprise.

- [ ] **Step 1: Failing tests** (DB-gated): insert 5 entries → 5 rows with correct columns incl. `not_run` JSONB array; re-insert the same entries → still 5 (conflict-silent); empty array → no query issued (spy on the pool); entries for a job in another project → FK rejection; **throw-path durability**: mock `runAgentFix` to record 2 entries then throw `VerificationInfraError` — after `runPipeline` rejects, the 2 rows exist; AC2.2's read shape:

```ts
it('AC2.2: the ledger + evidence for a run tell the red-then-green story', async () => {
  await insertFixRunLedger(entriesFromScriptedRun());
  const rows = await q(`SELECT command, failed, not_run FROM fix_run_ledger
                        WHERE run_id = $1 ORDER BY entry_seq`, [runId]);
  // red-run row: command names the declared test files and identifier, failed >= 1;
  // green-run row: same target, failed = 0; zero other new failures in the post-suite row;
  // every row carries command, commit_sha, workdir_dirty, counts, not_run.
  // The assertion-match fact is asserted from the persisted verification_evidence
  // checks (name 'repro_red', output_tail containing the expected assertion).
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement + wire the pipeline recorder/finally + teardown edits + the deleter grep.**
- [ ] **Step 4: Run** DB-gated worker suite **and** the e2e teardown path (`pnpm --filter test-e2e test` or its smallest teardown-touching suite) → PASS.
- [ ] **Step 5: Commit.** `feat(worker): fix_run_ledger persisted per attempt run, durable across throws (C2/W2.2, AC2.2)`

### Task 11: The judge — fail-closed, probe-budgeted, drafts enforced without breaking the delivery gate

**Files:**
- Create: `packages/worker/src/harness/fix-judge.ts`
- Modify: `packages/worker/src/verification-ledger.ts` — `detectLedgerAnomalies` pure function
- Modify: `packages/worker/src/agent-fix.ts` — judge invocation; veto/advisory/fail-closed semantics; **the diff-judge prose interpolation at :1195-1197 becomes templated copy**
- Modify: `packages/worker/src/pipeline.ts` — draft posture **without touching the candidate gate** (below); reservation-replay override
- Modify: `packages/worker/src/ci-watch.ts` — **draft→ready promotion (`:208-217`) disabled for automated PRs**
- Modify: `packages/worker/src/db.ts` — `UsagePhase` (:160) gains `'judge'`
- Modify: `shared/src/types.ts` — `EvidenceRecord` gains `judge?` (append-only optional)
- Test: `packages/worker/src/__tests__/fix-judge.test.ts` (create); extend `packages/worker/src/__tests__/agent-fix.test.ts`, `packages/worker/src/__tests__/pipeline.test.ts`, the ci-watch tests

**Interfaces:**

```ts
// verification-ledger.ts
/** Mechanical suspicion triggers; the ONLY thing that arms the probe tool. */
export function detectLedgerAnomalies(args: {
  entries: LedgerEntry[];
  declaredTest: { identifier: string; expectedAssertion: string } | null;
  declaredTestFiles: string[];
  diff: string;
  testSource: string | null;
}): string[];
// Triggers, exhaustively: any entry.truncated; any entry.timedOut; declaredTest
// present but its identifier appears in neither the diff nor the test source;
// any declared file whose path matches none of the test-material patterns
// (Task 9). Nothing else — a clean ledger yields [] and the judge gets no
// execution tool.

// harness/fix-judge.ts
export const FIX_JUDGE_MODEL = process.env['FIX_JUDGE_MODEL'] ?? 'claude-sonnet-5';
export const JUDGE_PROBE_BUDGET = 3;

export interface FixJudgeInput {
  apiKey: string;
  diagnosis: Diagnosis | null;                // null on human/legacy runs with no stored diagnosis —
                                              // the prompt renders an explicit "no diagnosis available" block
  diff: string;
  testSource: string | null;                  // FailFirstOutcome.declaredTestSource (concatenated, capped)
  ledger: LedgerEntry[];
  tierRecord: TierRecord;
  anomalies: string[];
  sandbox: SandboxRuntime | null;             // probes run here; null disables probing outright
  errorTitle: string;
}
export interface FixJudgeVerdict {
  approved: boolean;
  assessment: string;                          // model prose; ≤4000 chars, developer-facing only
  vetoReason: string | null;                   // ≤600 chars; required non-empty when !approved
  sessionId: string;                           // crypto.randomUUID() — the judge's own session
  probesUsed: number;
  probeCommands: string[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
}
export async function judgeFixAttempt(input: FixJudgeInput): Promise<FixJudgeVerdict>;

// shared/src/types.ts — EvidenceRecord gains:
  judge?: {
    approved: boolean;
    assessment: string;
    veto_reason: string | null;
    session_id: string;
    probes_used: number;
    /** The authorization decision id this verdict acted on (mirrors authorization.decision_id). */
    decision_id: string | null;
  };
```

- Session mechanics: `judgeFixAttempt` is its own bounded `client.messages.create` loop (pattern: `harness/diff-judge.ts` for the sealed-tool shape, `readonly-agent.ts` for the loop/caching shape — do **not** reuse the fixer's messages array or agent state; AC2.14's separate-session requirement is "no shared conversation state and a distinct recorded session id", enforced by construction and asserted by test). Inputs are fenced as untrusted data (`fenced` from `prompt-fence.ts`). Tools: `submit_judge_verdict` (sealed: `approved` boolean + `assessment` string required; `veto_reason` string) always; `run_probe { command: string }` **only when `anomalies.length > 0` and `sandbox` is non-null** — executes `sandbox.commands.run` with the sandbox's default timeout, hard-capped at `JUDGE_PROBE_BUDGET` calls (the 4th call returns a refusal string to the model and the loop forces the verdict turn). Max 6 turns.
- **Runtime verdict validation** (schema `strict` is request-time, not a runtime guarantee): `approved` must be boolean; `assessment` non-empty string, clamped to 4000 chars; `approved === false` requires a non-empty `vetoReason` (clamped to 600) — a malformed verdict gets **one** retry turn with a corrective message, then fails closed.
- **Failure semantics, exhaustive:** any of — API error after the SDK's retries, all turns consumed without a verdict, malformed verdict after the retry, probe-tool exception — yields `{ approved: false, vetoReason: 'judge_no_verdict: the judge session did not produce a valid verdict', … }`. Automated jobs treat that as a veto (**fail closed**; the templated refusal below). Human-triggered jobs treat judge failure as *advisory absent*: log, `evidence.judge` omitted, the run proceeds untouched — a judge outage never blocks a human (Global Constraints). `recordJobUsage({ phase: 'judge', … })` uses `verdict.usage`/`costUsd`; a usage-write failure is logged and never fails the attempt.
- **Probe safety by ordering:** the judge runs after the diff, ledger, suite results, and evidence are already captured — a probe that mutates the sandbox tree can corrupt nothing that ships (the PR content is the diff string, re-applied in a fresh clone by `gitCommitAndPush`; no verification re-runs after the judge). Probe commands are recorded in `probeCommands` for audit. A misled judge can only veto — the failure mode is a false refusal, never a false approval.
- Wiring in `agent-fix.ts`: **automated jobs** — judge runs iff the attempt is a PR candidate (`verified` or `draftEligible` per Task 9's predicate); tier `attempted` → no judge call (nothing to approve; predicate already failed — AC2.5's structural guarantee). Veto or fail-closed → the attempt terminates `needs_human` with the saved diff, `draftEligible: false`, `evidence.judge` carrying the full verdict, and **templated copy only** in the reason: `reason_message` gets the fixed sentence `'The verification judge rejected this attempt; its report is attached to the incident.'` — the model's prose lives **only** under `evidence.judge` (copy rule; C5 renders it under a labeled judge-report section). Approval → PR path proceeds (Task 12 renders the assessment). **Human-triggered jobs** — the judge runs whenever a diff exists (any tier: the human who clicked gets the report even on an attempted-tier failure); its verdict never changes status or posture (AC2.11). **Same task, same rule:** the existing diff-judge interpolation of `judgeExplanation` into `reason_message` (`agent-fix.ts:1195-1197`) is replaced with a fixed sentence (`'The automated diff review scored this change below the quality floor; details are in the verification evidence.'`), the prose moving into the evidence record — the pre-existing violation of the computed-copy rule dies here.
- **Draft posture without breaking the delivery gate.** The naive `publishDraft = triggeredBy !== 'human' ? true : …` would mark *every* automated needs_human result draft-publishable — including diff-less refusals and judge vetoes — bypassing `pipeline.ts:138-162` and crashing at the `fixResult.diff!` read (:164). The correct change keeps the candidate gate and only forces the *posture* of results that already qualify:

```ts
// pipeline.ts — replaces :133-136 and the posture derivation at :165
const draftCandidate = fixResult.status === 'needs_human'
  && fixResult.draftEligible === true
  && input.prPosture === 'draft_when_unverified'
  && input.platform !== 'python';
const opensPR = fixResult.status === 'fix_ready' || draftCandidate;   // the gate, unchanged in shape
let deliveryPosture: 'ready' | 'draft' =
  input.triggeredBy !== 'human' ? 'draft'                              // v1 terminal posture: automated ⇒ draft
  : draftCandidate ? 'draft' : 'ready';                                // human posture unchanged
```

  Reservation replay (:230): when the stored reservation says `'ready'` but the job is automated, the effective posture is forced to `'draft'` **for PR creation**; an already-open ready PR found by the existing-PR-by-head path (:264-276) is adopted as-is and recorded in the log as a grandfathered pre-cutover PR — C2 does not retroactively convert open PRs (bounded one-time exception, noted in the release PR description). **ci-watch:** the `markPullRequestReady` promotion (`ci-watch.ts:208-217`) is skipped when the group's terminal job was automated (`triggered_by !== 'human'` on the fix job the watch row references — read ci-watch's row shape first); auto-promotion is precisely the posture change the program plan defers to a future decision.
- Cost note, recorded as a plan decision: the judge runs on automated PR candidates and on human runs with a diff, so its spend attaches to attempts someone will actually read (bounded by the same per-run fix budget economics as the cascade; the eval loop W7.3 tracks approve/veto rates from day one per the design's reopen triggers).

- [ ] **Step 1: Failing tests** in `fix-judge.test.ts` (SDK module-mock pattern from `diff-judge.test.ts`):

```ts
it('clean ledger: the judge is never offered a probe tool (AC2.14 zero-probe half)', async () => {
  const verdict = await judgeFixAttempt(input({ anomalies: [] }));
  const tools = capturedCreateCalls().flatMap((c) => c.tools.map((t) => t.name));
  expect(tools).not.toContain('run_probe');
  expect(verdict.probesUsed).toBe(0);
});
it('anomalous ledger: probes available, hard-capped at 3 (AC2.14)', async () => {
  // script 4 probe attempts → 4th receives the refusal text; probesUsed === 3
});
it('a session that never submits a valid verdict fails closed', async () => {
  const v = await judgeFixAttempt(inputWithSilentModel());
  expect(v.approved).toBe(false);
  expect(v.vetoReason).toMatch(/^judge_no_verdict/);
});
it('a malformed verdict gets one corrective retry, then fails closed', ...);
it('an unapproved verdict with an empty veto_reason is malformed', ...);
it('a null diagnosis renders the no-diagnosis block instead of throwing', ...);
it('verdict carries usage and cost from the session', ...);
it('detectLedgerAnomalies: truncation, timeout, orphan identifier, non-test-path declaration — and nothing else', ...);
it('the judge session id differs from the fix run id and shares no messages (AC2.14)', ...);
```

  In `agent-fix.test.ts`:

```ts
it('AC2.5 [gate]: a glowing judge verdict cannot rescue a failed predicate', async () => {
  // scripted AUTOMATED run deriving tier 'attempted'; judge mock returns approved: true
  const result = await runAgentFix(input({ triggeredBy: 'auto' }));
  expect(vi.mocked(judgeFixAttempt)).not.toHaveBeenCalled();  // structural: never consulted
  expect(result.status).toBe('needs_human');                  // and no PR regardless
});
it('AC2.4: a veto on a reproduced attempt lands on the saved-diff report, no PR', async () => {
  // tier 'reproduced' + gates green, judge mock veto('test probes an unrelated element')
  expect(result.status).toBe('needs_human');
  expect(result.diff).toBeTruthy();
  expect(result.reason?.reason_message).toBe('The verification judge rejected this attempt; its report is attached to the incident.');
  expect(result.reason?.reason_message).not.toContain('unrelated element'); // prose stays out of templated copy
  expect(result.evidence?.judge).toMatchObject({ approved: false, veto_reason: 'test probes an unrelated element' });
});
it('judge API error on an automated job fails closed; on a human job the run proceeds without a report', ...);
it('AC2.11: a human run with a diff gets a judge report at ANY tier; verdict never changes status', ...);
it('the old diff-judge explanation no longer appears in reason_message (templated copy)', ...);
it('the judge record names the authorization decision id (AC2.8 judge half)', ...);
```

  In `pipeline.test.ts` and the ci-watch tests:

```ts
it('automated fix_ready results deliver as draft PRs (v1 terminal posture)', ...);
it('an automated needs_human WITHOUT draftEligible still opens no PR (candidate gate intact)', ...);
it('an automated job replaying a pre-cutover ready reservation creates a draft PR', ...);
it('human-triggered posture is unchanged', ...);
it('ci-watch does not promote an automated draft PR to ready on green CI', ...);
it('ci-watch still promotes a human-triggered draft as today', ...);
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement.**
- [ ] **Step 4: Run the full worker suite → PASS.**
- [ ] **Step 5: Commit.** `feat(worker): an instrument-reading judge gates every automated PR — fail-closed, probe-budgeted; automated PRs are drafts end-to-end (C2/W2.3)`

### Task 12: PR body — ledger-rendered verification with CI sub-markers, judge section

**Files:**
- Modify: `packages/worker/src/pr.ts` — `buildVerificationSection` (:354-384) renders from the ledger roles when present, wrapping its external-CI lines in **CI sub-markers**; new `buildJudgeSection`; `PRInput` gains `ledger?`, `ledgerRoles?`, `tierRecord?`, `judge?`
- Modify: `packages/worker/src/ci-watch.ts` — rewrites **only** the CI sub-block: it replaces the text between `CI_STATUS_START`/`CI_STATUS_END` inside the verification markers, never the whole section (the persisted `EvidenceRecord` cannot reconstruct the ledger body — no commit shas, counts, or role map survive in `checks` — so the ledger body must be written once at PR creation and left alone)
- Modify: `packages/worker/src/pipeline.ts` — thread the new fields into `PRInput` (:230-340)
- Test: extend `packages/worker/src/__tests__/pr.test.ts`, plus the ci-watch test file (locate it; create `ci-watch-verification.test.ts` if none exists)

**Interfaces:**
- Verification section (still inside the `VERIFICATION_START`/`VERIFICATION_END` markers, :351-352), **templates over ledger/evidence fields only**, with the CI lines isolated in their own sub-markers:

```
### Verification (executed)
Tier: reproduced — the declared test failed on the unfixed code and passed with the fix.
- ✅ `pnpm vitest run src/select.test.ts -t "keeps selection on options rebuild"` — failed as declared on base `a1b2c3d` (assertion matched)
- ✅ same test green with the fix on `e4f5a6b`
- ✅ suite: 668 passed, 0 new failures (baseline compared)
- ✅ build passed
Not run: (none)
<!-- CI_STATUS_START -->
External CI: not yet observed.
<!-- CI_STATUS_END -->
```

  Every line is computed from `LedgerEntry` + `ledgerRoles` + `TierRecord` fields; the not-run list renders at equal prominence (never collapsed when non-empty; the union of entries' `notRun`). Tier `checked` renders the declared-impossible reason (`TierRecord.reproductionImpossibleReason` — recorded model text rendered under the tier line as a quoted declaration, labeled as the agent's claim); tier `attempted` bodies don't arise on automated PRs (no PR), but human-triggered PRs may carry any tier — the section renders whatever the ledger holds. A ledger-less input (legacy replay) falls back to today's `buildEvidenceLines` (:337-349) unchanged, wrapped in the same CI sub-markers. Judge section, only when a verdict exists: `### Judge review` + the assessment prose explicitly labeled as the judge's own report + probe count when > 0.

- [ ] **Step 1: Failing tests:** substring assertions (not full-body snapshots — the body has volatile sections): reproduced ledger → body contains the tier line, the base-red line with the command and commit, the zero-new-failures line, `Not run: (none)`, and both CI sub-markers; a run whose final entry carries `notRun: ['repro_red','repro_green']` → both named in the not-run line; judge verdict present → labeled section with the assessment; **no judge prose between the verification markers**; ledger-less input → legacy evidence lines plus sub-markers; **ci-watch surgery**: take a ledger-built body, run the ci-watch replacement with a green-CI status → the tier/red/green lines are byte-identical before and after, only the sub-block changed.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS** including existing `pr.test.ts` snapshots (update only what this section legitimately changes; pre-existing sections must survive — C5's AC5.6 diffs a human-triggered body against a pre-branch capture).
- [ ] **Step 5: Commit.** `feat(worker): PR bodies carry the executed-checks ledger and the judge's review; ci-watch touches only its sub-block (C2/W2.2-W2.3)`

### Task 13: `digest_readiness` for fix outcomes

**Files:**
- Modify: `packages/worker/src/db.ts` — `updateGroupStatus` (:738-828) and `finalizeDelivery` (:985 area) gain `readiness?: ReadinessWrite`, upserted via the existing `upsertDigestReadiness` helper; `updateGroupStatus` wraps its UPDATE + upsert in one transaction (it is a single statement today)
- Modify: `packages/worker/src/index.ts` — fix-result persistence (:1314-1393) passes the reason per outcome
- Test: extend `packages/worker/src/__tests__/digest-readiness.integration.test.ts` (C1's file), handler-level

**Interfaces:**
- Reason mapping (the frozen strings from Global Constraints), written only by fix-job persistence paths: `pr_created`/`pr_draft` (incl. `finalizeDelivery`) → `('eligible','fix_pr_opened')`; terminal `needs_human` from a fix job → `('eligible', candidateDiff ? 'fix_attempt_failed_with_diff' : 'fix_attempt_failed_no_diff')`. Non-fix callers of `updateGroupStatus` pass nothing and write nothing (the single-writer discipline holds: all writes still flow through `upsertDigestReadiness`). Receipt-eligible means C4's gate can render these as receipts without a backfill — the "no orphaned receipts" clause of the program plan.

- [ ] **Step 1: Failing handler-level tests** (real DB, `vi.mock('../pipeline.js')`): scripted `runPipeline` results driven through `processFixJob` — (a) PR-opened result → readiness `('eligible','fix_pr_opened')`; (b) needs_human with diff → `('eligible','fix_attempt_failed_with_diff')`; (c) needs_human without diff → `('eligible','fix_attempt_failed_no_diff')`; (d) a non-fix `updateGroupStatus` caller leaves readiness untouched.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: DB-gated suite → PASS.**
- [ ] **Step 5: Commit.** `feat(worker): fix outcomes write their receipt-eligible readiness states (C2/W2.4)`

### Task 14: CP2 verification run

New production code: none. Checked-in artifacts: the fixture repo and one new integration test file. Prove the CP2 criteria from the program plan, then the repository gate. Deterministic witnesses come from the real harness with scripted agents; live-model runs prove the chain end-to-end where the criterion demands it and are recorded honestly where model nondeterminism makes them advisory.

- [ ] **Step 1: Build the fixture** `test-fixtures/fix-target-app/`: a minimal Vite+Vitest package with a planted bug (an unkeyed list rebuild dropping selection — the spike's shape) whose existing suite **passes on the base commit**, a README stating the planted bug and its file/line, and a git-initializable layout (the CP run initializes a throwaway git repo from it; nothing in `test-fixtures/wire/` is touched). Include one seeded-data SQL snippet (or extend `scripts/seed-e2e.sql`) that attaches **2 identified users** to the target group.
- [ ] **Step 2: Full gate.** `pnpm install --frozen-lockfile && pnpm -r build && pnpm test` with `DATABASE_URL` exported (read skip counts); `(cd packages/ingestion && go build ./... && go test ./...)` → zero skips; `docker compose config --quiet`.
- [ ] **Step 3: AC2.1/AC2.2 drivable — the no-click chain, real model, real PR.** Stack up (worktree port block from root `AGENTS.md` if defaults are taken); worker env: `OPSLANE_SANDBOX_BACKEND=local`, `OPSLANE_RELIABILITY_HARNESS=1` (real model, local sandbox so the fixture repo is clonable by path), and a **real GitHub test repository** as the PR target (push the fixture there first; a mocked PR seam does not witness AC2.1 — the criterion's deliverable is an open draft PR). **Sequence, race-free:** start the stack with the worker **stopped**; send the fixture's crash event (the group and jobs are created by ingestion); seed the 2 identified users onto the now-existing group; start the worker; **click nothing**. Wait for `investigate → fix` to terminate. Assert with read-only SQL and the GitHub API: a fix job ran with `triggered_by='auto'`; a **draft** PR exists (record its URL) whose body contains the ledger-rendered verification section (red-then-green lines for the declared test) and a judge section; `digest_readiness` for the group is `('eligible','fix_pr_opened')`; `fix_run_ledger` rows for the job carry command/commit/dirty/counts/not-run with the red-run row naming the declared test and `failed >= 1` and the green/post rows showing zero new failures; the persisted `verification_evidence.checks` include `repro_red` with the expected assertion in `output_tail` (AC2.2 reads ledger + evidence, per the dependency-section note); one read-API response confirms the Go side passes the new evidence fields through untouched. Record every output in the CP2 note.
- [ ] **Step 4: AC2.3/AC2.4/AC2.5 — predicate and judge refusals, deterministic.** Check in `packages/worker/src/__tests__/fix-fail-first.integration.test.ts`: real local sandbox, real git, real Vitest inside the fixture, **scripted agent loop** (the `agent-fix.test.ts` mock seam) so the declaration is deterministic. (AC2.3) the scripted agent "writes" a test that also passes on base (the spike's wrong-DOM-probe shape, checked in as `test-fixtures/fix-target-app/variants/passes-on-base.patch`) and declares it → the harness's real red run observes a pass → tier `attempted`, no PR, `candidate_diff` saved, readiness `fix_attempt_failed_with_diff`. The harness predicates are the deliverable under test; the model is scripted precisely because AC2.3's witness must be the refusal, not model luck. (AC2.4) same rig, valid red/green fixture, judge model response mocked to veto (`test probes an unrelated element`) → no PR, templated reason on the group, prose under `evidence.judge`. A real-model AC2.4 attempt is also run and its verdict recorded in the CP note (advisory — the deterministic witness is the wiring, the semantic quality claim is rubric-level per the design's honesty note). (AC2.5) [gate] Task 11's structural test re-run and cited.
- [ ] **Step 5: AC2.6–AC2.9 drivable.** AC2.6: seed an investigation returning `needs_more_context` (stub `ANTHROPIC_BASE_URL` → `test-e2e/support/anthropic-stub.mjs`; add a `needs_more_context` mode flag to the stub — test support, not production code) → group `needs_human`/`insufficient_context`, readiness `('ineligible','no_usable_diagnosis')`, no fix job, and the incident page/digest render it as C1's honest state, never a receipt. AC2.7: fixture with 0 identified users + 1 anon session (worker-stopped seeding, as in Step 3) → no attempt; decision row has `policy_eligible=false` and basis `{v:1,identified_users:0,recent_anon_sessions:1}`. AC2.8/AC2.9 — **two separate witnesses, because a repointed pending job cannot also witness the source-pinned authorization:** (AC2.8) investigation 1 completes and its fix job F1 is **claimed** by a paused worker (claimed jobs are never repointed, Task 5); investigation 2 completes; resume F1 → its authorization record names investigation 1's decision id, not the newest. A second, NULL-source legacy job seeded directly → its record names the newest (fallback pinned). (AC2.9) a **pending** (unclaimed) fix job when investigation 2 completes → payload, `source_job_id`, and the authorization record after it runs all reference the new decision. Paste the SELECTs.
- [ ] **Step 6: AC2.10–AC2.12 drivable.** AC2.10: the deterministic witness is Task 7's scripted-agent path driven through `processFixJob` on the live DB (edit turn, then budget exhaustion → terminal group carries `candidate_diff`, and `GET` the incident API to confirm the response returns it); a live low-budget run is additionally attempted and recorded (advisory — a real model may exhaust budget before editing, which proves nothing either way). AC2.11: human-click a fix on the parked AC2.7 incident → runs regardless of `policy_eligible=false`; judge output present as a report in `verification_evidence`; PR opens per today's human posture. AC2.12: Task 6's fault-injection test re-run against the live DB, plus one reaper pass observed requeueing and the requeued run adopting.
- [ ] **Step 7: AC2.13/AC2.14 [gates].** Cite Task 3's behavioral-pair test and Task 11's session/probe tests from the Step 2 suite run (paste the test names and results into the CP note).
- [ ] **Step 8:** Run `/opslane-verify:verify` with the CP2 drivable criteria (AC2.1–AC2.4, AC2.6–AC2.12) as the pre-drafted half, per the program's verification method.

## CP2 criteria → task map

| AC | Covered by |
|---|---|
| AC2.1 (no-click chain → draft PR with ledger + judge sections) | Tasks 2–4, 9–13; Task 14 Step 3 (real model, real draft PR) |
| AC2.2 (ledger + evidence tell the red/green story) | Tasks 9–10; Task 14 Step 3 |
| AC2.3 (passes-on-base test → predicate refusal, diff saved) | Tasks 7, 9; Task 14 Step 4 (scripted agent, real harness) |
| AC2.4 (unrelated-element test → judge veto on the report) | Task 11; Task 14 Step 4 |
| AC2.5 [gate] (glowing verdict cannot rescue a failed predicate) | Task 11 (structural test) |
| AC2.6 (no usable diagnosis → needs_human + ineligible/no_usable_diagnosis) | Task 3; Task 14 Step 5 |
| AC2.7 (below the bar → no attempt, basis recorded) | Tasks 2–3; Task 14 Step 5 |
| AC2.8 (authorization names the source decision; NULL falls back pinned) | Tasks 1, 4, 11; Task 14 Step 5 (claimed-job witness) |
| AC2.9 (pending job repointed atomically; human/claimed never) | Task 5; Task 14 Step 5 |
| AC2.10 (budget death keeps the working diff, readable) | Task 7; Task 14 Step 6 |
| AC2.11 (human click runs regardless; judge advisory even on outage) | Tasks 4, 11; Task 14 Step 6 |
| AC2.12 (kill between writes → adoption, one attempt's artifacts) | Tasks 6, 10; Task 14 Step 6 |
| AC2.13 [gate] (confidence inert) | Task 3 (behavioral pair) |
| AC2.14 [gate] (separate session; 0 probes clean, 1–3 anomalous) | Task 11 |

## Execution notes

- **Deploy order inside the train:** PR1 (authorization) changes behavior for in-flight jobs the moment it deploys: legacy pending fix jobs whose decisions predate the policy stamp will be refused (`policy_eligible IS NULL` → strict false) and park `needs_human` — a deliberate, visible cutover recorded in the PR description, not a silent behavior change. The prod book should be checked pre-deploy: `SELECT count(*) FROM error_group_jobs WHERE job_type IN ('fix','error_fix') AND status IN ('pending','claimed')` (expected: ~0 at current volume). PR3 is the safety-critical release: tier predicate, judge gate, always-draft, and the ci-watch promotion disable land together; there is no intermediate deploy where tier-passing PRs open unjudged, undrafted, or get auto-promoted.
- The friction rung freeze (Task 3) is the plan's one flagged judgment call: C2 neither widens nor disables shipped friction auto-fix; C3's signal-session impact bar replaces the confidence check there. If the owner prefers a hard stop until C3, the rung becomes a refusal — one line, noted in the task.
- `EvidenceRecord` additions are append-only optional snake-case fields; Go readers of `verification_evidence` (read API) pass unknown fields through as JSONB untouched — verified with one read-API response in Task 14 Step 3.
- Deliberate C2 non-goals: no auto-merge machinery (drafts are terminal posture; the `repro_reversal` check E2 would need stays unwritten); no `auto_fix` opt-in wiring beyond what exists; no impact-first PR-body layout (C5); no digest receipt rendering (C4); no friction impact bar (C3); no eval-loop CI gate (W7.3, "after C2"); no retroactive conversion of already-open pre-cutover ready PRs (grandfathered, logged); commit-drift re-verification against a moved default branch is subsumed by fail-first running on the fix-time clone HEAD (the ledger records that commit per entry; a full citation re-check at fix time is deferred until C3+ unless the owner asks — the diagnosis payload travels with the job, so the attempt is internally consistent either way).
- Model stub: Task 14 extends `test-e2e/support/anthropic-stub.mjs` with a `needs_more_context` mode only; forcing whole scripted fix-agent conversations through the stub is out of scope (the harness predicates are exercised by integration tests with scripted agent loops instead).

## Revision log

**v1:** initial plan from the program plan §C2, the unified design decisions 3/4/5/7, receipts §5a/§5b, pipeline §6.3/§6.4, and a two-agent code map of the live branch (fix pipeline, C0/C1 contracts).

**v2 after Codex round 1 (30 findings: 20 P1, 10 P2; sandboxed from source — plan-internal analysis).** Accepted: `FailFirstInput.baseSha`; an explicit try/finally restoration contract with `extractDiff` ordered before the protocol; contract-string validation + one `shq` quoting helper (model-controlled `test_files`/`identifier` were shell-injectable); the PR predicate keeps `buildGatePassed && qualityConfirmed` alongside tier `reproduced` (the tier alone would have weakened existing gates — the receipts §2 non-goal); check-role rendering moved off the frozen ledger columns onto a worker-local `roles()` map plus the persisted `EvidenceRecord.checks`; judge probe safety re-argued as an ordering guarantee with probe commands audited; exhaustive judge failure semantics (fail closed on automated jobs, advisory-absent on human jobs, one corrective retry on malformed verdicts, usage-write failures non-fatal); `FixJudgeVerdict.usage/costUsd`; veto prose evicted from `reason_message` (templated sentence only; prose lives under `evidence.judge`); auto-only repoint with `pending_human_job` refusal; production ledger-deleter sweep (RESTRICT FK); recorder created in the pipeline and persisted in a `finally`; ci-watch routed through a shared builder (superseded in v3 by sub-markers); reservation-replay draft override; PR train re-cut so tier predicate + judge + draft enforcement ship in one release; CP2 witnesses de-mocked (AC2.1 requires a real draft PR; AC2.3 is a scripted-agent + real-harness integration test); impact-bar boundary tests with explicit `Number()` conversion; `test_files[]` (1–5) replacing the single `test_file`; `finalizeNotRun` at attempt end; judge verdict runtime validation with length caps; git identity + `--allow-empty` + agent-pre-commit handling; CP2 seeds impact data race-free; AC2.10's deterministic witness is the scripted-agent handler path; decision-id threading simplified to the read path only; `insertFixRunLedger([])` no-op; saved-diff extraction simplified to attempt-always-keep-nonempty. Rejected, with rationale recorded: (R1#11) friction: the rung is **frozen byte-for-byte** with the debt named in code and flagged for owner sign-off — neither wider nor disabled (C2 cannot compute a friction impact bar; C3 owns the signal-session arithmetic). (R1#12) the NULL-source newest-fallback stays: the parent program plan and receipts §5b specify it and AC2.8 pins it; it is bounded to legacy in-flight jobs, visibly stamped `newest_fallback`, and gated by the strict `policyEligible === true` predicate.

**v3 after Codex round 2 (25 findings: 17 P1, 7 P2, 1 P3; load-bearing sources embedded in the prompt — source-verified; 10 round-1 resolutions re-raised and re-fixed here).** Accepted: the draft-posture expression rebuilt to preserve the delivery candidate gate (`opensPR` unchanged in shape; posture forced draft for automated results only — the v2 expression would have marked every automated needs_human draft-publishable, bypassed `pipeline.ts:138-162`, crashed on diff-less refusals at the `fixResult.diff!` read, and let vetoed diffs open PRs); **ci-watch's draft→ready promotion disabled for automated PRs** (`ci-watch.ts:208-217` — auto-promotion contradicted "drafts always"); reservation-replay scope honestly bounded (creation-time force-to-draft; an already-open ready PR is grandfathered and logged, not converted); **fail-first repositioned after the retry cascade and the existing suite/build gates** (committing F before them would poison the tree resets at :958-960/:987-989/:763-765; the ledger is chronological and the PR body renders the logical story from roles); `runDeclaredTest` specified against reality — report-file parsing (not stdout), stale-report deletion mirroring `test-runner.ts:214-235`, vitest/jest `-t` filtering, pytest node ids passed positionally (`-k` is the wrong tool), `npm-script` plans not filterable → contract violation; declared-file trust bounded honestly (any repo path is declarable; non-test-pattern paths become a ledger anomaly arming the judge — the base-run-purity claim was false as stated); ledger completeness through real interfaces (`SuiteRun` gains optional `timedOut`/`truncated`; `withInfraRetry` takes the recorder so hidden first executions are recorded); ci-watch reconstruction dropped for **CI sub-markers** (the persisted evidence cannot rebuild the ledger body — shas, counts, and the role map don't survive; ci-watch now rewrites only its own sub-block); human-job detection split from the reuse query (a `triggered_by` filter alone would have made human jobs invisible and allowed duplicates; the check is a separate locked SELECT) and **claimed auto jobs excluded from repointing** (the reuse SELECT matches `claimed` too; mutating a claimed payload under a live lease is a race); `FixJudgeInput.diagnosis` nullable with an explicit no-diagnosis prompt block (human/legacy runs have no stored diagnosis); `harness/types.ts` added to Task 8 (AgentState lives there; strict TS); the false "E2 becomes reachable" claim corrected (`computeTier` also requires `repro_reversal`, which C2 does not run); authorization stamping made an every-exit finalizer (missing-key and clone-failure returns predate evidence creation); restoration hardened to `checkout && reset --hard <F> && git clean -fd` (red-run untracked artifacts leaked into later gates); the sandbox-death contradiction resolved to one semantic (`SandboxUnavailableError` rethrows → infra requeue; alive-but-timed-out records and violates); the pre-existing diff-judge prose interpolation (`agent-fix.ts:1195-1197`) brought under the computed-copy rule in Task 11; human-run judge semantics fixed (judge runs on any human run with a diff, so AC2.11 always has its report; automated runs stay PR-candidates-only); `testSource` concatenation/cap/labels specified; `ORDER BY decided_at DESC, id DESC` tie-breaker; `inputSchema` spelling matched to the tool bridge; purge-helper call sites named; AC2.8/AC2.9 given disjoint CP witnesses (a claimed job pins source-authorization; a pending job witnesses the repoint — one job cannot witness both); stale line-anchor rule added to Global Constraints (named symbols over line numbers; the `getErrorGroup` anchor was wrong). Round-2 re-raises of round-1 items (baseSha capture site, restoration artifacts, injection surface, ledger role rendering, judge failure edges, prose in `reason_message`, repoint provenance, ci-watch, reservation posture, test-file trust) are each covered by the entries above.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex` | Independent 2nd opinion | 2 | issues_found → addressed | R1: 20 P1 / 10 P2; R2: 17 P1 / 7 P2 / 1 P3 + 10 re-raises; 51 accepted, 2 rejected with recorded rationale |
| Eng Review | `/plan-eng-review` | Architecture & tests | 0 | not run | — |

**CODEX:** Two iterations. Round 1 (session `019fef36`, sandboxed from source — plan-internal): the fail-first API missing its own base commit, no restoration contract, shell injection through model-controlled test identifiers, a tier predicate that weakened the existing build/quality gates, a check-kind gap between the frozen ledger columns and the promised PR rendering, unspecified judge failure semantics, veto prose violating the plan's own copy rule, an unsafe PR-train ordering (tier PRs deployable before the judge), and mocked CP witnesses that passed by construction. Round 2 (session `019fef4d`, load-bearing sources embedded — source-verified): the v2 draft-posture expression destroying the delivery candidate gate, ci-watch auto-promoting drafts to ready against the terminal posture, fail-first's protocol colliding with the agent cascade's tree resets, the declared-test runner contradicting the suite runner's report-file parsing and pytest semantics, hidden retry executions escaping the ledger, the reuse query silently matching claimed and human jobs, nullable-diagnosis judge inputs, and the false E2-reachability claim. All P1/P2s folded into v2/v3 except two rejected with rationale in the revision log (friction rung frozen rather than policy-gated — C2 cannot compute a friction impact bar, C3 owns it; NULL-source newest-fallback kept — parent program plan and AC2.8 pin it, bounded by the strict policy predicate).

**VERDICT:** CODEX CLEARED after two iterations — eng review not yet run (recommended before execution, matching the parent program plan's own review posture).

**UNRESOLVED DECISIONS:**
- Friction auto-fix rung (Task 3): frozen byte-for-byte with the confidence check intact until C3's signal-session impact bar replaces it. Owner sign-off requested on freeze-vs-refuse; the refusal variant is a one-line change.
