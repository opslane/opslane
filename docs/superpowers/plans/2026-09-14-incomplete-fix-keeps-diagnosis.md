# Incomplete Fix Keeps the Diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a fix run stops before it produces a result (turn or spend limit, failed model call, harness crash), it no longer replaces the completed diagnosis with `needs_human`, and no `reason_message` it writes contains the agent's own text.

**Architecture:** `reason-codes.ts` gets a fixed-copy table for the two "incomplete" reason codes the fix agent returns. `processFixJob` substitutes that copy. For non-ticket jobs it then calls a new `db.restoreDiagnosisAfterIncompleteFix`. In one leased transaction, that function reads the fix job's own source decision. When that decision is `code_fix`, it appends an `incomplete` decision row and moves the group from `fixing` back to the state a person can trigger a fix from (`investigated` for errors, `awaiting_approval` for friction). It leaves root cause, candidate diff, evidence, confidence and reason fields alone. Without a `code_fix` source decision, the job takes today's `needs_human` path, now with fixed copy. One inbox mapping in ingestion treats `incomplete` like `needs_human`, so the restored issue reads "Needs you" rather than "investigating".

**Tech Stack:** Node 22, TypeScript (strict, ESM), `pg`, Vitest; Go 1.24 for the single inbox mapping.

**Spec:** GitHub issue opslane/opslane#501 ("A failed later investigation overwrites a completed diagnosis and shows agent notes as the reason"). There is no separate design doc; the background and decisions below are the spec as refined against production data and two Codex review rounds.

## Background (read before Task 1)

Production group `0622e256-0a45-4082-b534-ac6d4adce47e` (project `5a64d496…`, queried read-only on 2026-09-14) shows the real sequence. The issue calls the second run a "later investigation", but it was the automatic **fix** job:

| Time (UTC) | Job | Row written |
|---|---|---|
| 08-27 13:33:47 | `investigate` 2b3dcddc (auto, completed) | decision `code_fix`, model `claude-sonnet-5`; group → `fixing` |
| 08-27 13:52:40 | `fix` 7f0973f0 (auto, `source_job_id` = 2b3dcddc) | decision `needs_human`, model `deterministic-fix-verification`, reason "The filesystem appears to be very slow. Let me try a simpler approach: Required action: …"; group → `needs_human`, `reason_code = budget_exhausted`, `candidate_diff` = 2,731 bytes of the agent's partial working tree |

The chatter comes from `packages/worker/src/agent-fix.ts:1217` (`reason_message: result?.summary ?? 'Agent could not complete'`). When the agent loop hits its turn limit, `summary` is the agent's last assistant text (`packages/agent-core/src/tool-loop.ts:252`). `processFixJob` (`packages/worker/src/index.ts:1767-1789`) writes that text to `error_groups.reason_message` and into the decision row as `"<message> Required action: <remediation>"`. A second prod group, `129b807a…`, carries the same defect ("Now let me check how `reqparse` defaults work…").

## Decisions

1. **Incomplete reason codes are `budget_exhausted` and `worker_runtime_error`, as returned by the fix agent through `runPipeline`.** In `runAgentFix`, `budget_exhausted` means the final tier's agent loop returned `success: false`, and the loop returns that for the turn limit, the spend limit, a failed model call, and cancellation (`tool-loop.ts:108-137, 252`). `worker_runtime_error` is the harness catch (`agent-fix.ts:1599-1608`) or the unreachable cascade fallback (`agent-fix.ts:1527-1535`). Neither code reaches delivery: `pipeline.ts:160-173` returns early unless the result is `fix_ready` or `draftEligible`, and neither incomplete path sets `draftEligible`. The fixed `budget_exhausted` copy covers every `success: false` cause.
2. **`verification_infra_error` is not incomplete here.** Its final-attempt path (`index.ts:458-484`) stays `needs_human`. Its remediation promises "It will be retried on recurrence", and only `needs_human` is requeue-eligible (`packages/ingestion/db/queries.go:1083-1087`). Its message is our own copy, not model text.
3. **The generic "Fix job error" catch in `processJobInner` (`index.ts:485-504`) is unchanged.** It also fires after delivery (for example "Delivery result … is missing PR identity"), and a restore there could strand an opened PR. Its message is exception text, not model output.
4. **"Completed diagnosis" means the fix job's own source decision.** `runAgentFix` authorizes the fix from the decision whose `job_id` is the fix job's `source_job_id` (`agent-fix.ts:457-468`, `db.ts:227-242`), so the restore reads the same row. It locks the job row, takes its `source_job_id`, and selects the newest decision for that job, skipping `outcome = 'incomplete'` and `model = 'deterministic-fix-verification'`. Only when `source_job_id` is NULL (friction human fixes, historical jobs) does it fall back to the newest such decision for the group, the same fallback `loadDiagnosisDecisionForSource` uses.
5. **Only `code_fix` restores.** A decision with `outcome = 'needs_human'` is ambiguous. `not_actionable` writes it while setting the group to `insight` (`index.ts:887-902`), and a parked `code_fix` writes it while setting `investigated` (`index.ts:930-938`). Restoring on it could put an explicitly non-fixable diagnosis behind a "Find fix" button (`packages/dashboard/src/components/incident-kind.ts:31-37`). The parked case is rare (a human fix already pending when the investigation finished), so it takes the fallback.
6. **Restore target by kind:** `investigated` for errors, `awaiting_approval` for friction. These are the only statuses the human fix endpoint accepts (`queries.go:2122-2129`) and the only ones that show fix controls (`incident-kind.ts:34-36`), so a person can retry from the dashboard. **How this reads the acceptance criterion "leaves the group status unchanged":** the `code_fix` handoff moves the group to `fixing` (`db.ts:3418-3425`), which only means "a fix job is running". Leaving `fixing` after the job ends strands the incident with no live work, the failure `index.ts:498-501` already warns about. So "unchanged" means the group settles where the completed diagnosis puts it when no fix is running (`investigated`) and never becomes `needs_human`. The PR description must state this interpretation.
7. **The group's diagnosis columns are not written.** `root_cause`, `suggested_mitigation`, `candidate_diff`, `verification_evidence`, `confidence`, `reason_code`, `reason_message`, `remediation` and `pr_*` keep their values. The agent's partial diff is not saved on the group.
8. **`terminal_fix_job_id` is stamped with the fix job id on restore.** `processFixJob` checks that marker first (`index.ts:1371`), so if the job loses its lease between commit and `completeJob`, the reclaim adopts the restore instead of paying for a second fix run. The human fix endpoint clears the marker (`queries.go:2123`).
9. **If the status moved away from `fixing` during the run** (a person archived or resolved the group), append the `incomplete` row and leave the status alone. A reclaim in the crash window can run the fix again and append a second row. Appending a row per attempt is the ledger's documented design (`db.ts:95-103`). A reclaimed fix job already runs against `resolved` and `archived` groups today, since only `pr_created`, `pr_draft` and `needs_human` are refused (`index.ts:1379`). This change adds no new rerun path.
10. **Ticket fix jobs (`job.ticketId`) keep their current flow** through `updateGroupStatus` → `attemptFailed` (`db.ts:1615-1622`), which owns ticket state. They get the fixed copy only.
11. **The fallback (no `code_fix` source decision) keeps today's `needs_human` write and `needs_human` decision row**, with fixed copy.
12. **The agent's decline path is out of scope.** `agent-fix.ts:1013-1051` writes `deriveOutcome(...).reason`, which interpolates the adjudication's reasoning (`classify.ts:85-110`). That is a validated, submitted verdict, the same class of text an investigation writes for `not_actionable` (`index.ts:895`). The issue asks for fixed copy "when no validated reason exists".
13. **Ingestion readers:**
    - `ChosenDiagnosis` (`queries.go:153-160`), the digest's `diagnosisValidationLateralSQL` and `diagnosis_decided_at` (`digest/build.go:19-48`), `GetLatestAgentTaskBrief` (`queries.go:1966-1975`), `ticket_fix.go:40` and `friction/fix-attempts.ts:110` all exclude fix-verification rows or filter by outcome, so the completed diagnosis stays the chosen one.
    - `LatestPipelineResult` (MCP, `queries.go:98-118`) reports the `incomplete` row and its fixed copy, which is accurate.
    - The inbox (`inbox.go:57-61` → `read_api.go:349-374`) selects the newest decision in the episode and would map `incomplete` to "investigating". Task 4 maps it to `needs_you`, as `needs_human` already is. In an error episode, `incomplete` can only come from this change: the investigation's invalid-verdict path throws without a row (`index.ts:818-824`), and friction has no episodes.
    - The legacy receipts lane includes `investigated` (`digest/build.go:81`), keyed on `diagnosis_decided_at`, which ignores fix-verification rows. A restored group therefore publishes as an ordinary `report_ready` receipt ("Review issue" plus its verified root cause) in the window where its diagnosis was decided, and the `incomplete` row does not resurface it. The ON card lane excludes `investigated` (`digest/actionable.go:106-110`).

Accepted consequence: a restored `investigated` group is not requeued on recurrence (only `resolved`, `needs_human` and `merged` are), so a recurrence no longer pays for another investigation and fix that would likely stop the same way. A person retries from the dashboard.

## Global Constraints

- Every terminal `needs_human` write keeps non-empty `reason_code`, `reason_message` and `remediation` (packages/worker/AGENTS.md).
- Lease contract: every new write checks `worker_id`, `lease_generation`, `status = 'claimed'` and `lease_expires_at > clock_timestamp()` inside the same transaction, and throws `LeaseLostError` when the lease is gone.
- `diagnosis_decisions` is insert-only. Never `UPDATE` or `DELETE` it.
- No migrations, no new dependencies, no dashboard changes. The only Go change is the `inboxState` arm in `packages/ingestion/handler/read_api.go` and its test. Migration 054's `diagnosis_decisions_outcome_check` already allows the `incomplete` outcome.
- Fixed copy, verbatim:
  - `budget_exhausted`: `The fix attempt stopped before it produced a result: it reached its turn or spend limit, or a model call failed.`
  - `worker_runtime_error`: `The fix attempt stopped on an internal error before it produced a result.`
  - Remediation for both comes from the existing `DEFAULT_REMEDIATION`.
- ESM, strict TypeScript, `unknown` plus narrowing instead of `any`. Tests stay colocated in `packages/worker/src/__tests__`.
- Commits use `abhishek@opslane.com` (check `git config user.email`) and end with `Claude-Session: https://claude.ai/code/session_01BUMHiNpdZgQNvcyaoKZcJk`.
- Do not push, open a PR, or touch production.
- Database tests need `DATABASE_URL`. Without it `db.test.ts` is skipped, not failed. Export the full worktree port block from the root `AGENTS.md` and confirm the suite reports **0 skipped** before counting a pass. Run verification pipelines under `set -o pipefail`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/worker/src/reason-codes.ts` | Add `INCOMPLETE_REASON_MESSAGES`, `IncompleteReasonCode`, `isIncompleteReasonCode`, `incompleteReason`. |
| `packages/worker/src/__tests__/reason-codes.test.ts` | Pin the fixed copy for every incomplete code. |
| `packages/worker/src/agent-fix.ts` | The final-tier failure return uses fixed copy; `summary` goes to the log only. |
| `packages/worker/src/__tests__/agent-fix.test.ts` | Assert the budget result carries fixed copy, not the summary. |
| `packages/worker/src/db.ts` | Add `restoreDiagnosisAfterIncompleteFix` and `IncompleteFixOutcome`. |
| `packages/worker/src/__tests__/db.test.ts` | Postgres tests for the restore. |
| `packages/worker/src/index.ts` | `processFixJob` routes incomplete results through fixed copy and the restore. |
| `packages/worker/src/__tests__/index.test.ts` | Routing tests; add the new db function to the module mock. |
| `packages/ingestion/handler/read_api.go` | Map `incomplete` to `needs_you`. |
| `packages/ingestion/handler/read_api_test.go` | Pin the mapping. |

---

### Task 1: Fixed copy for incomplete fix reasons

**Files:**
- Modify: `packages/worker/src/reason-codes.ts` (append after `buildReason`, currently ending at line 118)
- Modify: `packages/worker/src/agent-fix.ts:18` (import) and `:1209-1223`
- Test: `packages/worker/src/__tests__/reason-codes.test.ts`
- Test: `packages/worker/src/__tests__/agent-fix.test.ts:824-832`

**Interfaces:**
- Consumes: `buildReason(code, message?, remediation?, platform?)` and `DEFAULT_REMEDIATION` from `reason-codes.ts`; `NeedsHumanReason`, `ReasonCode` from `@opslane/shared`.
- Produces:
  - `export const INCOMPLETE_REASON_MESSAGES: { readonly budget_exhausted: string; readonly worker_runtime_error: string }`
  - `export type IncompleteReasonCode = 'budget_exhausted' | 'worker_runtime_error'`
  - `export function isIncompleteReasonCode(code: string | null | undefined): code is IncompleteReasonCode`
  - `export function incompleteReason(code: IncompleteReasonCode): NeedsHumanReason`

- [ ] **Step 1: Write the failing reason-codes tests**

In `packages/worker/src/__tests__/reason-codes.test.ts`, replace the import on line 3 with:

```ts
import {
  DEFAULT_REMEDIATION,
  INCOMPLETE_REASON_MESSAGES,
  buildReason,
  incompleteReason,
  isIncompleteReasonCode,
  reasonCodeForDecision,
} from '../reason-codes.js';
import type { IncompleteReasonCode } from '../reason-codes.js';
```

Append at the end of the file:

```ts
describe('incomplete fix reasons', () => {
  it('has fixed copy for exactly the incomplete codes', () => {
    expect(Object.keys(INCOMPLETE_REASON_MESSAGES).sort()).toEqual([
      'budget_exhausted',
      'worker_runtime_error',
    ]);
  });

  it('builds every incomplete reason from fixed copy and the default remediation', () => {
    for (const code of Object.keys(INCOMPLETE_REASON_MESSAGES) as IncompleteReasonCode[]) {
      expect(incompleteReason(code)).toEqual({
        reason_code: code,
        reason_message: INCOMPLETE_REASON_MESSAGES[code],
        remediation: DEFAULT_REMEDIATION[code],
      });
    }
  });

  it('pins the copy a reader sees', () => {
    expect(incompleteReason('budget_exhausted').reason_message).toBe(
      'The fix attempt stopped before it produced a result: it reached its turn or spend limit, or a model call failed.',
    );
    expect(incompleteReason('worker_runtime_error').reason_message).toBe(
      'The fix attempt stopped on an internal error before it produced a result.',
    );
  });

  it('recognizes only incomplete codes', () => {
    expect(isIncompleteReasonCode('budget_exhausted')).toBe(true);
    expect(isIncompleteReasonCode('worker_runtime_error')).toBe(true);
    expect(isIncompleteReasonCode('verification_infra_error')).toBe(false);
    expect(isIncompleteReasonCode('low_confidence_fix')).toBe(false);
    expect(isIncompleteReasonCode('toString')).toBe(false);
    expect(isIncompleteReasonCode(undefined)).toBe(false);
    expect(isIncompleteReasonCode(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Make the agent-fix budget test assert fixed copy**

In `packages/worker/src/__tests__/agent-fix.test.ts`, add below line 111 (`import { logger } from '../logger.js';`):

```ts
import { INCOMPLETE_REASON_MESSAGES } from '../reason-codes.js';
```

Replace the test at lines 824-832 with:

```ts
  it('returns needs_human with budget_exhausted when budget exceeded', async () => {
    const chatter = 'The filesystem appears to be very slow. Let me try a simpler approach:';
    vi.mocked(runAgentLoop).mockResolvedValue(makeAgentResult({ success: false, summary: chatter, turnCount: 5, toolCallCount: 10, tokenUsage: { input: 1000000, output: 500000, cacheRead: 0, cacheWrite: 0 } }));

    const result = await runAgentFix(makeInput());
    expect(result.status).toBe('needs_human');
    expect(result.reason?.reason_code).toBe('budget_exhausted');
    // The agent's last message is progress chatter, never a reason.
    expect(result.reason?.reason_message).toBe(INCOMPLETE_REASON_MESSAGES.budget_exhausted);
    expect(JSON.stringify(result.reason)).not.toContain('filesystem');
    // Haiku fails → escalate to Sonnet → also fails
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 3: Run both files to verify they fail**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/reason-codes.test.ts src/__tests__/agent-fix.test.ts`
Expected: FAIL. Both suites fail at module load because `reason-codes.js` does not yet export `INCOMPLETE_REASON_MESSAGES` (Vitest reports a missing-export or `undefined` access error for the file, not individual assertion failures). This is the expected red state for a new export.

- [ ] **Step 4: Implement the copy table**

Append to `packages/worker/src/reason-codes.ts`:

```ts
/**
 * Fix-run reason codes that mean the run stopped before it produced a result:
 * the agent loop ended without success (turn or spend limit, a failed model
 * call), or the harness crashed. Such a run proves nothing about the diagnosis
 * it started from, so it must not replace that diagnosis, and its message is
 * fixed copy: at a turn limit the agent's last message is progress chatter
 * ("Let me try a simpler approach:"), not a reason anyone can act on.
 */
export const INCOMPLETE_REASON_MESSAGES = {
  budget_exhausted:
    'The fix attempt stopped before it produced a result: it reached its turn or spend limit, or a model call failed.',
  worker_runtime_error:
    'The fix attempt stopped on an internal error before it produced a result.',
} as const satisfies Partial<Record<ReasonCode, string>>;

export type IncompleteReasonCode = keyof typeof INCOMPLETE_REASON_MESSAGES;

export function isIncompleteReasonCode(
  code: string | null | undefined,
): code is IncompleteReasonCode {
  return code != null && Object.prototype.hasOwnProperty.call(INCOMPLETE_REASON_MESSAGES, code);
}

/** The only reason an incomplete fix run may write. */
export function incompleteReason(code: IncompleteReasonCode): NeedsHumanReason {
  return buildReason(code, INCOMPLETE_REASON_MESSAGES[code]);
}
```

- [ ] **Step 5: Stop agent-fix from writing the summary as the reason**

In `packages/worker/src/agent-fix.ts`, replace the import on line 18 with:

```ts
import { buildReason, incompleteReason, reasonCodeForDecision, reproductionRemediation } from './reason-codes.js';
```

Replace lines 1209-1223 (the `// Last tier — return failure` block through its closing `}`) with:

```ts
        // Last tier — return failure
        if (!result?.success) {
          const retained = await retainWorkingDiff();
          // At a turn limit the summary is the agent's last message, usually
          // mid-task chatter. Keep it for operators; the reason is fixed copy.
          logger.warn('Fix agent stopped before a result', {
            model: tier.model,
            summary: result?.summary ?? null,
          });
          return {
            status: 'needs_human',
            ...(retained ?? {}),
            reason: incompleteReason('budget_exhausted'),
            evidence: evidence.record(),
            tokenUsage: totalTokenUsage,
          };
        }
```

`logger` is already imported in `agent-fix.ts` (used at lines 469 and 1056).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/reason-codes.test.ts src/__tests__/agent-fix.test.ts`
Expected: PASS, both files, 0 failed.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @opslane/worker build`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/reason-codes.ts packages/worker/src/agent-fix.ts \
  packages/worker/src/__tests__/reason-codes.test.ts packages/worker/src/__tests__/agent-fix.test.ts
git commit -m "fix(worker): write fixed copy when the fix agent stops early

The final-tier failure result used the agent's last message as the
reason, so incidents showed mid-task chatter such as \"Let me try a
simpler approach:\". Add fixed copy for the incomplete fix reason codes
and log the summary instead.

Refs #501

Claude-Session: https://claude.ai/code/session_01BUMHiNpdZgQNvcyaoKZcJk"
```

---

### Task 2: Restore the completed diagnosis in the database

**Files:**
- Modify: `packages/worker/src/db.ts`. Add the new function directly after `recordFixTerminalDecision`, which ends at line 395.
- Test: `packages/worker/src/__tests__/db.test.ts`. Extend the import list at lines 13-44 and add a `describe` inside `describeDb('db.ts integration tests', …)`, directly after the `investigation handoff decisions` block that ends at line 789.

**Interfaces:**
- Consumes: `insertDiagnosisDecision(client, errorGroupId, projectId, row: DecisionRow)` (db.ts:104, module-private), `JobLease` (db.ts:541), `LeaseLostError` (db.ts:551), `getPool()`.
- Produces:
  - `export type IncompleteFixOutcome = 'restored' | 'status_changed' | 'no_completed_diagnosis'`
  - `export async function restoreDiagnosisAfterIncompleteFix(lease: JobLease & { errorGroupId: string }, args: { reason: string }): Promise<IncompleteFixOutcome>`
  - Semantics: reads `source_job_id` and `episode_id` from the locked job row. `'no_completed_diagnosis'` writes nothing. `'status_changed'` appends the `incomplete` row only. `'restored'` appends the row, moves `fixing` → `investigated` / `awaiting_approval`, and stamps `terminal_fix_job_id`. A lost lease throws `LeaseLostError` and writes nothing.

- [ ] **Step 1: Write the failing database tests**

In `packages/worker/src/__tests__/db.test.ts`, add `LeaseLostError,` and `restoreDiagnosisAfterIncompleteFix,` to the `from '../db.js'` import list (lines 13-44).

After the `describe('investigation handoff decisions', …)` block (ends line 789), add:

```ts
  describe('incomplete fix restore', () => {
    const codeFix = {
      outcome: 'code_fix' as const,
      decisionReason: 'The cause is at forge-adapter.ts',
      diagnosis: null,
      model: 'claude-sonnet-5',
      promptVersion: 'diagnosis-v1',
      basis: 'local_defect' as const,
      confidence: 'high' as const,
      policyEligible: true,
      policyBasis: null,
    };
    const reason = 'The fix attempt stopped before it produced a result: it reached its turn or spend limit, or a model call failed. Required action: Review the error manually.';
    const evidence = { version: 1, tier: null, checks: [] };

    /**
     * Mirrors production: a completed investigate job that owns the decision,
     * and a claimed fix job whose source_job_id points at it. The fix job is
     * the one seedErrorGroupAndJob creates, so claimJob picks it.
     */
    async function seedFixing(options: { kind?: 'error' | 'friction'; linkSource?: boolean } = {}) {
      const seeded = await seedErrorGroupAndJob();
      const episode = await testPool.query<{ id: string }>(
        `INSERT INTO issue_episodes (project_id, canonical_issue_id, sequence)
         VALUES ($1, $2, 1) RETURNING id`,
        [testProjectId, seeded.errorGroupId],
      );
      const episodeId = episode.rows[0]!.id;
      const source = await testPool.query<{ id: string }>(
        `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status, episode_id)
         VALUES ($1, $2, 'investigate', 'completed', $3) RETURNING id`,
        [seeded.errorGroupId, testProjectId, episodeId],
      );
      const sourceJobId = source.rows[0]!.id;
      await testPool.query(
        `UPDATE error_group_jobs SET job_type = 'fix', source_job_id = $2, episode_id = $3 WHERE id = $1`,
        [seeded.jobId, options.linkSource === false ? null : sourceJobId, episodeId],
      );
      const claim = await claimJob(`restore-worker-${crypto.randomUUID()}`, 60_000);
      expect(claim?.id).toBe(seeded.jobId);
      await testPool.query(
        `UPDATE error_groups
            SET status = 'fixing', kind = $2,
                root_cause = 'refresh() runs unconditionally',
                suggested_mitigation = 'guard the refresh call',
                candidate_diff = 'diff --git a/kept.ts b/kept.ts',
                confidence = 'high',
                verification_evidence = $3::jsonb,
                reason_code = 'low_confidence_fix',
                reason_message = 'earlier reason',
                remediation = 'earlier remediation',
                pr_url = 'https://github.com/octocat/hello/pull/3',
                pr_number = 3,
                pr_fix_job_id = $4
          WHERE id = $1`,
        [seeded.errorGroupId, options.kind ?? 'error', JSON.stringify(evidence), sourceJobId],
      );
      return { ...seeded, episodeId, sourceJobId, lease: { ...claim!, errorGroupId: seeded.errorGroupId } };
    }

    async function groupRow(errorGroupId: string) {
      return (await testPool.query(
        `SELECT status, root_cause, suggested_mitigation, candidate_diff, confidence,
                verification_evidence, reason_code, reason_message, remediation,
                pr_url, pr_number, pr_fix_job_id, terminal_fix_job_id
           FROM error_groups WHERE id = $1`,
        [errorGroupId],
      )).rows[0] as Record<string, unknown>;
    }

    /** Sorted by outcome: decided_at ties break on a random UUID, so insertion order is not recoverable. */
    async function decisionRows(errorGroupId: string) {
      return (await testPool.query<{
        outcome: string; decision_reason: string; model: string; job_id: string | null; episode_id: string | null;
      }>(
        `SELECT outcome, decision_reason, model, job_id, episode_id
           FROM diagnosis_decisions WHERE error_group_id = $1
          ORDER BY outcome, decision_reason`,
        [errorGroupId],
      )).rows;
    }

    it('returns an error group to investigated, keeps every diagnosis column, and records an incomplete row', async () => {
      const { errorGroupId, jobId, episodeId, sourceJobId, lease } = await seedFixing();
      await recordDiagnosisDecision(errorGroupId, testProjectId, { ...codeFix, jobId: sourceJobId, episodeId });

      await expect(restoreDiagnosisAfterIncompleteFix(lease, { reason })).resolves.toBe('restored');

      expect(await groupRow(errorGroupId)).toEqual({
        root_cause: 'refresh() runs unconditionally',
        suggested_mitigation: 'guard the refresh call',
        candidate_diff: 'diff --git a/kept.ts b/kept.ts',
        confidence: 'high',
        verification_evidence: evidence,
        reason_code: 'low_confidence_fix',
        reason_message: 'earlier reason',
        remediation: 'earlier remediation',
        pr_url: 'https://github.com/octocat/hello/pull/3',
        pr_number: 3,
        pr_fix_job_id: sourceJobId,
        status: 'investigated',
        terminal_fix_job_id: jobId,
      });
      expect(await decisionRows(errorGroupId)).toEqual([
        { outcome: 'code_fix', decision_reason: codeFix.decisionReason, model: 'claude-sonnet-5', job_id: sourceJobId, episode_id: episodeId },
        { outcome: 'incomplete', decision_reason: reason, model: 'deterministic-fix-verification', job_id: jobId, episode_id: episodeId },
      ]);
    });

    it('reads the fix job source decision, not a newer decision from another job', async () => {
      const { errorGroupId, sourceJobId, lease } = await seedFixing();
      await recordDiagnosisDecision(errorGroupId, testProjectId, { ...codeFix, jobId: sourceJobId });
      await recordDiagnosisDecision(errorGroupId, testProjectId, {
        ...codeFix, outcome: 'needs_human', decisionReason: 'unrelated newer verdict', jobId: null,
      });

      await expect(restoreDiagnosisAfterIncompleteFix(lease, { reason })).resolves.toBe('restored');
    });

    it('does not restore when the source decision is not code_fix', async () => {
      const { errorGroupId, sourceJobId, lease } = await seedFixing();
      await recordDiagnosisDecision(errorGroupId, testProjectId, {
        ...codeFix, outcome: 'needs_human', decisionReason: 'not actionable', jobId: sourceJobId,
      });

      await expect(restoreDiagnosisAfterIncompleteFix(lease, { reason })).resolves.toBe('no_completed_diagnosis');

      expect((await groupRow(errorGroupId)).status).toBe('fixing');
      expect(await decisionRows(errorGroupId)).toHaveLength(1);
    });

    it('falls back to the newest completed group decision when the job has no source', async () => {
      const { errorGroupId, lease } = await seedFixing({ linkSource: false });
      await recordDiagnosisDecision(errorGroupId, testProjectId, codeFix);

      await expect(restoreDiagnosisAfterIncompleteFix(lease, { reason })).resolves.toBe('restored');
    });

    it('never counts earlier incomplete or fix-verification rows as the completed diagnosis', async () => {
      const { errorGroupId, lease } = await seedFixing({ linkSource: false });
      await recordDiagnosisDecision(errorGroupId, testProjectId, codeFix);
      await recordDiagnosisDecision(errorGroupId, testProjectId, {
        ...codeFix, outcome: 'incomplete', decisionReason: 'earlier incomplete run',
      });
      await recordDiagnosisDecision(errorGroupId, testProjectId, {
        ...codeFix,
        outcome: 'needs_human',
        decisionReason: 'earlier fix verdict',
        model: 'deterministic-fix-verification',
        promptVersion: 'fix-terminal-v1',
      });

      await expect(restoreDiagnosisAfterIncompleteFix(lease, { reason })).resolves.toBe('restored');
    });

    it('returns a friction group to awaiting_approval', async () => {
      const { errorGroupId, sourceJobId, lease } = await seedFixing({ kind: 'friction' });
      await recordDiagnosisDecision(errorGroupId, testProjectId, { ...codeFix, jobId: sourceJobId });

      await expect(restoreDiagnosisAfterIncompleteFix(lease, { reason })).resolves.toBe('restored');

      expect((await groupRow(errorGroupId)).status).toBe('awaiting_approval');
    });

    it('records the run but leaves a status that moved away from fixing', async () => {
      const { errorGroupId, jobId, sourceJobId, lease } = await seedFixing();
      await recordDiagnosisDecision(errorGroupId, testProjectId, { ...codeFix, jobId: sourceJobId });
      await testPool.query(`UPDATE error_groups SET status = 'resolved' WHERE id = $1`, [errorGroupId]);

      await expect(restoreDiagnosisAfterIncompleteFix(lease, { reason })).resolves.toBe('status_changed');

      expect(await groupRow(errorGroupId)).toMatchObject({ status: 'resolved', terminal_fix_job_id: null });
      expect(await decisionRows(errorGroupId)).toContainEqual(expect.objectContaining({ outcome: 'incomplete', job_id: jobId }));
    });

    it('writes nothing when the lease is gone', async () => {
      const { errorGroupId, jobId, sourceJobId, lease } = await seedFixing();
      await recordDiagnosisDecision(errorGroupId, testProjectId, { ...codeFix, jobId: sourceJobId });
      await testPool.query(
        `UPDATE error_group_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [jobId],
      );

      await expect(restoreDiagnosisAfterIncompleteFix(lease, { reason })).rejects.toBeInstanceOf(LeaseLostError);

      expect((await groupRow(errorGroupId)).status).toBe('fixing');
      expect(await decisionRows(errorGroupId)).toHaveLength(1);
    });
  });
```

If a seed statement violates a constraint (for example `resolved` needing a column, or a job-type index), read the constraint in `packages/ingestion/db/migrations/` and satisfy it in the seed. Do not drop the test.

- [ ] **Step 2: Run the tests to verify they fail**

Start Compose Postgres, export the worktree env block from the root `AGENTS.md` (`DATABASE_URL` in particular), and apply migrations the way the root `AGENTS.md` describes. Then:

Run: `set -o pipefail; pnpm --filter @opslane/worker exec vitest run src/__tests__/db.test.ts 2>&1 | tail -30`
Expected: FAIL. The file fails to load, or every new test throws, because `restoreDiagnosisAfterIncompleteFix` is not exported yet. If the output says `skipped`, `DATABASE_URL` is not reaching the test: fix the environment before moving on.

- [ ] **Step 3: Implement the restore**

In `packages/worker/src/db.ts`, directly after `recordFixTerminalDecision` (after line 395), add:

```ts
export type IncompleteFixOutcome = 'restored' | 'status_changed' | 'no_completed_diagnosis';

/**
 * A fix run that stopped before a result (turn or spend limit, failed model
 * call, harness crash) proves nothing about the diagnosis it started from.
 * Record it as its own `incomplete` decision and return the group to the state
 * that diagnosis left it in — the one a human can trigger a fix from — instead
 * of replacing the diagnosis with a terminal needs_human.
 *
 * The completed diagnosis is the one that authorized this fix: the newest
 * decision of the job's source_job_id (the group's newest when the job has no
 * source, matching loadDiagnosisDecisionForSource), never an incomplete run or
 * a fix-verification row. Only code_fix restores: needs_human rows are also
 * written for not_actionable verdicts. root_cause, candidate_diff, evidence,
 * confidence and the reason fields are deliberately left as they are.
 *
 * terminal_fix_job_id is stamped so a reclaim of this same job adopts the
 * restore instead of paying for the fix run again; the human fix endpoint
 * clears it when a person retries.
 */
export async function restoreDiagnosisAfterIncompleteFix(
  lease: JobLease & { errorGroupId: string },
  args: { reason: string },
): Promise<IncompleteFixOutcome> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query<{ source_job_id: string | null; episode_id: string | null }>(
      `SELECT source_job_id, episode_id FROM error_group_jobs
        WHERE id = $1 AND worker_id = $2 AND lease_generation = $3::bigint
          AND project_id = $4 AND error_group_id = $5
          AND status = 'claimed' AND lease_expires_at > clock_timestamp()
        FOR UPDATE`,
      [lease.id, lease.workerId, lease.leaseGeneration, lease.projectId, lease.errorGroupId],
    );
    const job = owned.rows[0];
    if (!job) throw new LeaseLostError(lease.id);

    const group = await client.query<{ status: string }>(
      `SELECT status FROM error_groups
        WHERE id = $1 AND project_id = $2
        FOR UPDATE`,
      [lease.errorGroupId, lease.projectId],
    );
    const status = group.rows[0]?.status;
    if (status === undefined) {
      throw new Error(`Error group ${lease.errorGroupId} not found`);
    }

    const completed = await client.query<{ outcome: string }>(
      `SELECT outcome FROM diagnosis_decisions
        WHERE error_group_id = $1 AND project_id = $2
          AND ($3::uuid IS NULL OR job_id = $3::uuid)
          AND outcome <> 'incomplete'
          AND model <> 'deterministic-fix-verification'
        ORDER BY decided_at DESC, id DESC
        LIMIT 1`,
      [lease.errorGroupId, lease.projectId, job.source_job_id],
    );
    if (completed.rows[0]?.outcome !== 'code_fix') {
      await client.query('COMMIT');
      return 'no_completed_diagnosis';
    }

    await insertDiagnosisDecision(client, lease.errorGroupId, lease.projectId, {
      outcome: 'incomplete',
      decisionReason: args.reason,
      diagnosis: null,
      model: 'deterministic-fix-verification',
      promptVersion: 'fix-terminal-v1',
      jobId: lease.id,
      episodeId: job.episode_id,
      basis: 'local_defect',
      confidence: 'low',
      policyEligible: true,
      policyBasis: null,
    });

    if (status !== 'fixing') {
      await client.query('COMMIT');
      return 'status_changed';
    }

    await client.query(
      `UPDATE error_groups
          SET status = (CASE WHEN kind = 'friction' THEN 'awaiting_approval'
                             ELSE 'investigated' END)::error_group_status,
              terminal_fix_job_id = $3,
              updated_at = now()
        WHERE id = $1 AND project_id = $2`,
      [lease.errorGroupId, lease.projectId, lease.id],
    );
    await client.query('COMMIT');
    return 'restored';
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
```

`JobLease` and `LeaseLostError` are declared further down the file (lines 541-551). Hoisting makes that fine, and `recordFixTerminalDecision` at line 345 already relies on it. If `error_group_jobs.source_job_id` is not a `uuid` column, check its type in the migrations and adjust the `$3::uuid` casts to match.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `set -o pipefail; pnpm --filter @opslane/worker exec vitest run src/__tests__/db.test.ts 2>&1 | tail -15`
Expected: PASS, `0 failed`, **no skipped tests** in `db.test.ts`.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @opslane/worker build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/__tests__/db.test.ts
git commit -m "feat(worker): restore the completed diagnosis after an incomplete fix

Add restoreDiagnosisAfterIncompleteFix. Under the job lease it reads the
fix job's source decision; when that is code_fix it appends an incomplete
decision row and moves the group from fixing back to investigated
(friction: awaiting_approval), leaving root cause, candidate diff,
evidence and reason fields as they were.

Refs #501

Claude-Session: https://claude.ai/code/session_01BUMHiNpdZgQNvcyaoKZcJk"
```

---

### Task 3: Route incomplete fix results in processFixJob

**Files:**
- Modify: `packages/worker/src/index.ts:27` (import) and `:1767-1789` (the `else` branch of `processFixJob`)
- Test: `packages/worker/src/__tests__/index.test.ts`. Extend the `vi.mock('../db.js', …)` factory (lines 18-80) and the `describe('processFixJob — preserves writeup on failure (no revert/null)', …)` block (lines 922-1229).

**Interfaces:**
- Consumes: `isIncompleteReasonCode`, `incompleteReason` (Task 1); `db.restoreDiagnosisAfterIncompleteFix(lease, { reason }): Promise<'restored' | 'status_changed' | 'no_completed_diagnosis'>` (Task 2); existing `db.recordFixTerminalDecision` and `updateGroupStatus`.
- Produces: no new exports. Behavior: when a non-ticket fix job's pipeline returns `needs_human` with `budget_exhausted` or `worker_runtime_error`, the job calls only `restoreDiagnosisAfterIncompleteFix`. Only if that returns `'no_completed_diagnosis'` do the existing `needs_human` writes run, with fixed copy. Ticket jobs always take the existing writes, with fixed copy.

- [ ] **Step 1: Add the new function to the db mock**

In `packages/worker/src/__tests__/index.test.ts`, inside the `vi.mock('../db.js', async () => ({ … }))` factory, add after `recordFixTerminalDecision: vi.fn(),` (line 64):

```ts
  restoreDiagnosisAfterIncompleteFix: vi.fn(),
```

Below line 225 (`const { emitUsageEvent } = await import('../usage-events.js');`) add:

```ts
const { DEFAULT_REMEDIATION, INCOMPLETE_REASON_MESSAGES } = await import('../reason-codes.js');
```

- [ ] **Step 2: Write the failing routing tests**

In the `processFixJob — preserves writeup on failure` describe, add this line just before the closing `});` of the existing test `terminates as needs_human with all reason fields + confidence when the fix is below floor` (lines 1051-1074):

```ts
    expect(db.restoreDiagnosisAfterIncompleteFix).not.toHaveBeenCalled();
```

Add these tests before the describe's closing `});` (line 1229):

```ts
  const chatter = 'The filesystem appears to be very slow. Let me try a simpler approach:';
  const budgetDecisionReason =
    `${INCOMPLETE_REASON_MESSAGES.budget_exhausted} Required action: ${DEFAULT_REMEDIATION.budget_exhausted}`;

  function budgetExhausted() {
    return {
      status: 'needs_human' as const,
      confidence: 'low' as const,
      candidateDiff: 'diff --git a/partial.ts b/partial.ts',
      reason: {
        reason_code: 'budget_exhausted' as const,
        reason_message: chatter,
        remediation: 'Review the error manually — the agent could not complete within budget/turn limits',
      },
    };
  }

  it('keeps the completed diagnosis when the fix agent stops early', async () => {
    vi.mocked(db.restoreDiagnosisAfterIncompleteFix).mockResolvedValue('restored');
    mockRunPipeline.mockResolvedValue(budgetExhausted());

    await processFixJob(fixJob(), new AbortController().signal);

    expect(db.restoreDiagnosisAfterIncompleteFix).toHaveBeenCalledWith(fixJob(), { reason: budgetDecisionReason });
    expect(mockUpdateGroupStatus).not.toHaveBeenCalled();
    expect(db.recordFixTerminalDecision).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(db.restoreDiagnosisAfterIncompleteFix).mock.calls)).not.toContain('filesystem');
  });

  it('restores on a harness crash with fixed copy, not the exception text', async () => {
    vi.mocked(db.restoreDiagnosisAfterIncompleteFix).mockResolvedValue('restored');
    mockRunPipeline.mockResolvedValue({
      status: 'needs_human',
      reason: {
        reason_code: 'worker_runtime_error',
        reason_message: 'Agent harness error: git checkout exploded',
        remediation: 'Review the error manually — the agent harness encountered an unexpected error',
      },
    });

    await processFixJob(fixJob(), new AbortController().signal);

    expect(db.restoreDiagnosisAfterIncompleteFix).toHaveBeenCalledWith(fixJob(), {
      reason: `${INCOMPLETE_REASON_MESSAGES.worker_runtime_error} Required action: ${DEFAULT_REMEDIATION.worker_runtime_error}`,
    });
    expect(mockUpdateGroupStatus).not.toHaveBeenCalled();
  });

  it('writes nothing more when the group left fixing during the run', async () => {
    vi.mocked(db.restoreDiagnosisAfterIncompleteFix).mockResolvedValue('status_changed');
    mockRunPipeline.mockResolvedValue(budgetExhausted());

    await processFixJob(fixJob(), new AbortController().signal);

    expect(mockUpdateGroupStatus).not.toHaveBeenCalled();
    expect(db.recordFixTerminalDecision).not.toHaveBeenCalled();
  });

  it('falls back to needs_human with fixed copy when no completed diagnosis exists', async () => {
    vi.mocked(db.restoreDiagnosisAfterIncompleteFix).mockResolvedValue('no_completed_diagnosis');
    mockRunPipeline.mockResolvedValue(budgetExhausted());

    await processFixJob(fixJob(), new AbortController().signal);

    expect(db.recordFixTerminalDecision).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'needs_human',
      reason: budgetDecisionReason,
    }));
    expect(mockUpdateGroupStatus).toHaveBeenCalledWith('g1', 'p1', 'needs_human', expect.objectContaining({
      reason: {
        reason_code: 'budget_exhausted',
        reason_message: INCOMPLETE_REASON_MESSAGES.budget_exhausted,
        remediation: DEFAULT_REMEDIATION.budget_exhausted,
      },
      terminalFixJobId: 'j1',
    }), fixJob());
  });

  it('keeps the ticket attempt flow for ticket fix jobs, with fixed copy', async () => {
    mockRunPipeline.mockResolvedValue(budgetExhausted());
    const ticketJob = { ...fixJob(), ticketId: 'ticket-1', fixAttemptId: 'attempt-1', publicationGeneration: 1 };

    await processFixJob(ticketJob, new AbortController().signal);

    expect(db.restoreDiagnosisAfterIncompleteFix).not.toHaveBeenCalled();
    expect(mockUpdateGroupStatus).toHaveBeenCalledWith('g1', 'p1', 'needs_human', expect.objectContaining({
      reason: expect.objectContaining({ reason_message: INCOMPLETE_REASON_MESSAGES.budget_exhausted }),
    }), ticketJob);
  });

  it('adopts a restored diagnosis when the same fix job is reclaimed', async () => {
    mockGetErrorGroup.mockResolvedValue({
      ...makeGroup({ id: 'g1', status: 'investigated' }),
      terminal_fix_job_id: 'j1',
    });

    await processFixJob(fixJob(), new AbortController().signal);

    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
```

The ticket fields are spelled `ticketId`, `fixAttemptId` and `publicationGeneration` on `ClaimedJob` (`db.ts:532-535`).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/index.test.ts -t "processFixJob"`
Expected: FAIL on the five new routing tests: `restoreDiagnosisAfterIncompleteFix` is never called, and `updateGroupStatus` receives the chatter. The reclaim-adoption test passes already, because it pins existing behavior.

- [ ] **Step 4: Implement the routing**

In `packages/worker/src/index.ts`, replace the import on line 27 with:

```ts
import { buildReason, incompleteReason, isIncompleteReasonCode, reasonCodeForDecision, reproductionRemediation } from './reason-codes.js';
```

Replace lines 1767-1789 (from `} else {` through the closing `}` of that `else`, just before `} finally {`) with:

```ts
    } else {
      // Fix did not clear the precision floor (or failed) — terminate as needs_human,
      // preserving the full writeup (reason + confidence). root_cause is untouched.
      // An incomplete run (the agent stopped early, or the harness crashed) is the
      // exception: it proves nothing about the diagnosis, so it writes fixed copy
      // and, when its source diagnosis is a code_fix, returns the group to it.
      const pipelineCode = result.reason?.reason_code;
      const incomplete = isIncompleteReasonCode(pipelineCode) ? incompleteReason(pipelineCode) : null;
      const terminalReason = incomplete
        ?? result.reason
        ?? buildReason('worker_runtime_error', 'Fix pipeline failed without a reason');
      const decisionReason = `${terminalReason.reason_message} Required action: ${terminalReason.remediation}`;

      if (incomplete && !job.ticketId) {
        const restore = await db.restoreDiagnosisAfterIncompleteFix(job, { reason: decisionReason });
        if (restore !== 'no_completed_diagnosis') {
          jobsFailed++;
          lastJobAt = new Date().toISOString();
          logger.warn('Fix job incomplete: completed diagnosis kept', {
            job_id: job.id,
            duration_ms: durationMs,
            reason_code: terminalReason.reason_code,
            restore,
          });
          return;
        }
      }

      await db.recordFixTerminalDecision({
        lease: job,
        episodeId: job.episodeId ?? null,
        outcome: 'needs_human',
        reason: decisionReason,
        confidence: result.confidence ?? 'low',
      });
      await updateGroupStatus(job.errorGroupId, job.projectId, 'needs_human', {
        reason: terminalReason,
        confidence: result.confidence,
        candidate_diff: result.candidateDiff,
        evidence: result.evidence,
        terminalFixJobId: job.id,
      }, job);
      jobsFailed++;
      logger.warn('Fix job completed: needs_human (writeup preserved)', {
        job_id: job.id, duration_ms: durationMs, reason_code: terminalReason.reason_code, confidence: result.confidence,
      });
    }
```

The `return` sits inside the `try` whose `finally` runs `cleanup()`, so the clone is still removed. `lastJobAt` is set before returning because the function's last line (`lastJobAt = …`) is skipped. `job` is `ClaimedJob & { errorGroupId: string }`, which satisfies `JobLease & { errorGroupId: string }`. If the compiler disagrees, read the `ClaimedJob` declaration and adjust the call, not the db signature.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/index.test.ts`
Expected: PASS, 0 failed.

- [ ] **Step 6: Typecheck and run the whole worker suite**

Run: `pnpm --filter @opslane/worker build && set -o pipefail && pnpm --filter @opslane/worker test 2>&1 | tail -20`
Expected: build exit 0; tests `0 failed`. With `DATABASE_URL` exported, the skip count must not exceed a run of `main` in the same environment.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/index.ts packages/worker/src/__tests__/index.test.ts
git commit -m "fix(worker): keep the completed diagnosis when a fix run is incomplete

A fix job whose agent stopped early or whose harness crashed wrote
needs_human over a completed code_fix diagnosis, with the agent's last
message as the reason. Route those results through the fixed copy and
restoreDiagnosisAfterIncompleteFix; fall back to needs_human only when
the fix has no code_fix source diagnosis. Ticket fix jobs keep their
attempt flow.

Refs #501

Claude-Session: https://claude.ai/code/session_01BUMHiNpdZgQNvcyaoKZcJk"
```

---

### Task 4: Inbox reads an incomplete fix as waiting on a person

**Files:**
- Modify: `packages/ingestion/handler/read_api.go:361-362`
- Test: `packages/ingestion/handler/read_api_test.go:13-22`

**Interfaces:**
- Consumes: `inboxState(identity, filterDecision, inquiryDecision, diagnosisOutcome, groupStatus string) (state, reason string)`.
- Produces: `inboxState(…, "incomplete", …)` returns `"needs_you"` for an investigated round.

- [ ] **Step 1: Write the failing test rows**

In `packages/ingestion/handler/read_api_test.go`, add these rows to the table in `TestInboxStateVocabulary`, after the `"fix"` row (line 20):

```go
		{"incomplete fix", "settled", "open_inquiry", "investigate", "incomplete", "investigated", "needs_you"},
		{"fix decision", "settled", "open_inquiry", "investigate", "needs_human", "needs_human", "needs_you"},
		{"code fix", "settled", "open_inquiry", "investigate", "code_fix", "fixing", "investigating"},
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/ingestion && go test ./handler -run TestInboxStateVocabulary -v`
Expected: FAIL: `incomplete_fix: state="investigating" … want "needs_you"`.

- [ ] **Step 3: Implement the mapping**

In `packages/ingestion/handler/read_api.go`, replace lines 361-362:

```go
	case inquiryDecision == "investigate" && diagnosisOutcome == "needs_human":
		return "needs_you", "your input is needed to continue"
```

with:

```go
	// An incomplete fix run keeps the completed diagnosis and waits for a
	// person to retry the fix, so it reads the same as a fix that needs review.
	case inquiryDecision == "investigate" && (diagnosisOutcome == "needs_human" || diagnosisOutcome == "incomplete"):
		return "needs_you", "your input is needed to continue"
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/ingestion && go test ./handler -run TestInboxStateVocabulary -v`
Expected: PASS for all rows.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/read_api.go packages/ingestion/handler/read_api_test.go
git commit -m "fix(ingestion): show an incomplete fix run as needing a person

The worker now records an incomplete decision when a fix run stops early
and keeps the completed diagnosis. The inbox mapped that outcome to
\"investigating\"; map it to needs_you, like a fix that needs review.

Refs #501

Claude-Session: https://claude.ai/code/session_01BUMHiNpdZgQNvcyaoKZcJk"
```

---

### Task 5: Repository gate

**Files:** none changed. This task proves the commits together.

- [ ] **Step 1: Confirm no model-text path remains in fix reasons**

Run: `grep -n "reason_message: result" packages/worker/src/agent-fix.ts packages/worker/src/index.ts || echo "none"`
Expected: `none`.

- [ ] **Step 2: Run the full gate from the repository root**

With the worktree env block from the root `AGENTS.md` exported and Compose Postgres and MinIO healthy:

```bash
set -euo pipefail
S="$(mktemp -d)"
pnpm install --frozen-lockfile
pnpm -r build
pnpm test 2>&1 | tee "$S/pnpm-test.log" | tail -40
go_status=0
(cd packages/ingestion && go build ./... && go test -json ./... > "$S/go-test.json") || go_status=$?
echo "go status $go_status"
echo "go fail events: $(grep -c '"Action":"fail"' "$S/go-test.json" || true)"
echo "go skip events: $(grep -c '"Action":"skip"' "$S/go-test.json" || true)"
test "$go_status" -eq 0
docker compose config --quiet
```

Expected: the script runs to the end with `set -e` active, and `go status` is 0. `"Action":"fail"` count is 0, and `"Action":"skip"` count is 0. If skips appear, list them with `grep '"Action":"skip"' "$S/go-test.json"` and fix the environment. Do not accept them. In the worker output, `db.test.ts` reports no skipped tests.

- [ ] **Step 3: Record known unrelated failures**

If the SDK `debug-id-browser` Firefox/WebKit test fails, confirm it also fails on `main` before treating it as unrelated. It is a known red on this host.

---

### Task 6: Live pipeline smoke

The root `AGENTS.md` requires a live smoke for pipeline changes. The verify phase runs it after Tasks 1-5, on a stack built from this branch.

- [ ] **Step 1: Baseline smoke.** Apply migrations, run `scripts/seed-e2e.sql`, rebuild `ingestion` and `worker`, send an event to `$INGESTION_URL/api/v1/events`, and confirm its job reaches its expected terminal state.
- [ ] **Step 2: Incomplete fix, end to end.** An error fix job needs frozen evidence (`index.ts:1413-1418`, `evidence/bundle.ts`), and the inbox needs a full pipeline round (`read_api.go:381-390`). So seed the whole chain: an error event, an `error_groups` row in `fixing`, an open `issue_episodes` row, an `issue_decisions` row with `open_inquiry`, an `issue_inquiry_decisions` row with `investigate`, the `issue_evidence_anchors` row for the event, a completed `investigate` job carrying `episode_id` and `input_version`, its `code_fix` decision (same `job_id` and `episode_id`), and a pending `fix` job with that `episode_id` and `source_job_id`. The best route is to let the real pipeline create these rows from an ingested event, then copy their shape; `scripts/seed-e2e.sql` and the verify rigs in memory are the reference. Point the worker's `ANTHROPIC_BASE_URL` at a stub that fails every model call, so the real agent loop returns `success: false` on both tiers. Let the real worker claim the job, then confirm in Postgres:
  - group `status = 'investigated'`
  - `root_cause`, `candidate_diff` and reason fields unchanged
  - `terminal_fix_job_id` = the fix job
  - one new `incomplete` decision row carrying the fixed copy
  - the job `completed`
  - `GET` the incident through the read API and confirm the inbox state is `needs_you`.
- [ ] **Step 3: If the fix sandbox cannot start here**, report Step 2 as blocked with the exact error. Do not claim it passed.

---

## Post-review changes (2026-09-14)

The pre-landing review (Claude specialists, a Claude adversarial pass and Codex) found gaps that the tasks above did not cover. They were fixed on the branch:

1. **Restore and completion are one transaction.** `restoreDiagnosisAfterIncompleteFix` marks the job `completed` inside its transaction, and `processFixJob` throws `JobCompletedInTransaction`, which the poller already treats as success. Before, a lease that expired between the restore commit and `completeJob` let the reaper dead-letter the job on its last attempt and write `needs_human`/`lease_lost` over the restore (`requeueStaleJobs`, `db.ts:1297`). It also let a "Find fix" click collide with the still-claimed job on `uq_one_active_job_per_episode_type` and return 500. `processJobInner` rethrows `JobCompletedInTransaction` instead of terminalizing it.
2. **Lock order is group, then job**, matching the investigation handoff (`updateGroupAndCreateFixJob`), and the transaction retries up to three times on `40P01`/`40001`.
3. **A stale run cannot reset a newer fix.** The group moves only when no other `fix`/`error_fix` job for it is pending or claimed; otherwise the run is recorded and `status_changed` is returned.
4. **Inbox:** `incomplete` maps to `needs_you` only while the group is `investigated` or `awaiting_approval`. A retried fix in `fixing` reads "investigating".
5. **Logs:** the agent's turn-limit summary is logged scrubbed and capped at 500 characters, and the harness catch now logs its scrubbed exception, because the stored reason is fixed copy.

Known consequences left for follow-up:
- A restored `investigated` error incident is not in the digest's card lane (`digest/actionable.go:106-110`) and is not requeued on recurrence.
- A `not_actionable` friction finding parked in `awaiting_approval` still falls back to `needs_human` (with fixed copy) when a person's fix on it stops early.
