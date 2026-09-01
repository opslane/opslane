# Verdict-Gated Investigation Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every promoted narrative incident gets exactly one automatic investigation; the investigation's verdict (not signal severity) gates whether an automatic fix PR follows; a diagnosis that needs human/product judgment becomes a reviewable, digest-visible finding instead of a terminal FYI insight.

**Architecture:** Four surgical changes to existing code, no new subsystems. (1) `promotion.ts` drops the high-severity branch: promoted incidents always enter status `queued` with one idempotent `investigate` job. (2) `processFrictionInvestigateJob`'s non-code-cause branch lands on `awaiting_approval` (already actionable — the DB lifecycle trigger renders it "Review the investigation." and it freezes into the digest) instead of the terminal-FYI `insight` status. (3) Migration 069 backfills incidents the old gate parked uninvestigated and adds `verification_reason`. (4) `finalizeVerification`'s non-ok states store a bounded, sanitized reason, surfaced through the narrative API and dashboard. The auto-fix path for deterministic code causes already exists and stays gated by the project's `friction_autonomy` ladder — enabling it for AMFJ is an ops step, not code.

**Tech Stack:** TypeScript worker (Vitest), one guarded migration (069: backfill + verification reason), one Go handler field, one dashboard panel line.

**Spec:** `docs/design/2026-08-31-session-narratives.md` (rev 5 + 2026-09-01 gate revision) and the verify report `.verify/runs/20260901-020035/report.md` (AC13 failure).

## Global Constraints

- Decision 2026-09-01: investigate ALL promoted incidents; fix pipeline gated on the investigation VERDICT (`verdict.codeCause`), never on signal severity. `severity` stays as data for display/ranking.
- Behavior change to note in the commit: medium/low promoted incidents previously parked as `awaiting_approval` *uninvestigated* (digest said "Review the investigation" with nothing investigated); now every promotion investigates first, so the digest card always carries a real diagnosis.
- Terminal-status and lease contracts unchanged. `needs_human` terminals keep non-empty `reason_code`/`reason_message`/`remediation`.
- ESM + strict TypeScript, `unknown` + narrowing, colocated Vitest tests.
- No new env vars; ONE new migration (069) for the backfill + verification reason column; wire contract untouched.
- `awaiting_approval` deliberately exposes the dashboard's "Generate fix" / `TriggerFix` on non-code-cause diagnoses: that IS the decided fix-on-demand path (a human reads the diagnosis and chooses). Acknowledge/dismiss uses the EXISTING resolve/snooze machinery on actionable incidents — no new transition.
- The `insight` status is not "invisible" (dashboard renders it; digest has receipt paths) — the change is semantic: product-judgment diagnoses move from terminal-FYI to recurring-until-acknowledged. Task 4 documents this consequence.

---

### Task 1: Promotion — every promoted incident is queued and investigated

**Files:**
- Modify: `packages/worker/src/friction/promotion.ts` (the promotion block around lines 100–145: `highSeverity` query, `promotedStatus`, conditional investigate insert)
- Test: the existing promotion suite file (find it: `grep -rln "promotes" packages/worker/src/friction/__tests__/`)

**Interfaces:**
- Consumes: existing `ensureCandidate`, `countEligibleSupport`, the idempotent investigate-insert SQL already present.
- Produces: promoted incidents always have `status='queued'` and exactly one `investigate` job; no code path reads signal severity for gating anymore.

- [ ] **Step 1: Write the failing test**

Add to the promotion suite (reuse its existing seeding helpers exactly as the neighboring tests do):

Each test seeds its OWN fingerprint (no shared fixtures — the suite may run tests in isolation):

```ts
function freshFp(tag: string) { return `vgi-${tag}-`.padEnd(32, '0'); }
async function promoteFresh(tag: string, severity: 'medium' | 'high') {
  const fp = freshFp(tag);
  for (const s of [`${tag}-1`, `${tag}-2`, `${tag}-3`]) {
    await seedSignal(s, { fingerprint: fp, severity });
  }
  await runPromotionCheckForTest(fp);
  return { fp, group: await getIncidentFor(fp) };
}

it('queues and investigates a promoted incident with only medium severity', async () => {
  const { group } = await promoteFresh('med', 'medium');
  expect(group.status).toBe('queued');
  expect(await investigationJobsFor(group.id)).toHaveLength(1);
});

it('a later promotion pass never enqueues a second investigation', async () => {
  const { fp, group } = await promoteFresh('dedupe', 'medium');
  await seedSignal('dedupe-4', { fingerprint: fp, severity: 'medium' });
  await runPromotionCheckForTest(fp);
  expect(await investigationJobsFor(group.id)).toHaveLength(1);
});
```

(`seedSignal`/`runPromotionCheckForTest` map to this suite's existing helper names; add a `severity` passthrough to the seeder if it lacks one.)

**Retry semantics, stated honestly:** the investigate insert fires only on the candidate→promoted transition (`if (!wasCandidate) continue;` guards everything after it), so promotion passes can never re-enqueue — dedup needs no status-list gymnastics beyond what exists. A dead-lettered investigation (e.g. sandbox misconfiguration) is recovered by the EXISTING manual investigation trigger from the dashboard/API, or by re-running the migration 069 backfill (whose predicate matches a queued group with only dead-lettered jobs). Do NOT claim promotion-pass retries.

- [ ] **Step 2: Run to verify the first test fails**

Run: `cd packages/worker && DATABASE_URL="$DATABASE_URL" pnpm vitest run src/friction/__tests__/ -t "medium severity"`
Expected: FAIL — status is `awaiting_approval` and zero investigation jobs (current high-only gate).

- [ ] **Step 3: Implement**

In `promotion.ts`, delete the `highSeverity` query and the conditional, making promotion unconditional:

```ts
// Decision 2026-09-01: every promoted incident is investigated. The verdict
// (processFrictionInvestigateJob) gates any fix, not signal severity.
const promotedStatus = 'queued';
```

and run the investigate insert unconditionally (it sits inside the `wasCandidate` transition, so it executes exactly once per incident lifetime; keep the existing `NOT EXISTS ... status IN ('pending','claimed')` guard verbatim as a belt against a concurrent transition). Remove the now-unused severity lookup; do not remove the `severity` column usage anywhere else (display/ranking keeps it).

- [ ] **Step 4: Run the promotion suite**

Run: `cd packages/worker && DATABASE_URL="$DATABASE_URL" pnpm vitest run src/friction/__tests__/`
Expected: PASS, including the pre-existing test that asserted the high-severity behavior — update that test's expectation to the new contract (`queued` + 1 job for high too; the *absence* test for sub-threshold fingerprints stays untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/friction/promotion.ts packages/worker/src/friction/__tests__/
git commit -m "feat(worker): investigate every promoted incident; severity no longer gates"
```

---

### Task 1b: Migration 069 — backfill parked incidents, verification reason column

**Files:**
- Create: `packages/ingestion/db/migrations/069_verdict_gated_investigation.sql`
- Test: apply + re-apply on the dev DB (the runner replays every migration file on every boot — see the comment block in `066_pr_actionable.sql` — so every statement must be guarded/idempotent)

**Interfaces:**
- Produces: existing friction incidents parked as *uninvestigated* `awaiting_approval` re-enter the queue with an investigation job; `session_narratives.verification_reason TEXT` exists for Task 3.

- [ ] **Step 1: Write the migration**

```sql
-- 069_verdict_gated_investigation.sql
BEGIN;
-- The runner replays every file on every boot with no ledger and no global
-- lock; concurrent ingestion boots must not double-insert backfill jobs.
SELECT pg_advisory_xact_lock(hashtext('069_verdict_gated_investigation'));
-- Decision 2026-09-01: every promoted friction incident is investigated.
-- Backfill: incidents the old severity gate parked as awaiting_approval
-- WITHOUT ever being investigated (no root cause, no diff) go back to the
-- queue with one investigation job. Idempotent under the replay-every-boot
-- runner: once investigated, root_cause is set and the predicate is false;
-- while still queued, the re-run is a no-op UPDATE and the job guard holds.
UPDATE error_groups
SET status = 'queued', updated_at = now()
WHERE kind = 'friction' AND status = 'awaiting_approval'
  AND root_cause IS NULL
  AND NULLIF(btrim(COALESCE(candidate_diff, '')), '') IS NULL;

INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status, triggered_by)
SELECT eg.id, eg.project_id, 'investigate', 'pending', 'auto'
FROM error_groups eg
WHERE eg.kind = 'friction' AND eg.status = 'queued'
  AND eg.root_cause IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM error_group_jobs j
    WHERE j.error_group_id = eg.id AND j.project_id = eg.project_id
      AND j.job_type = 'investigate'
      AND j.status IN ('pending','claimed','completed'));

-- Task 3's storage: reason for a non-ok frames-verification terminal.
-- (Migration 068's CHECK constrains `verification` non-null ONLY for state
-- 'ok', so the reason needs its own column.)
ALTER TABLE session_narratives ADD COLUMN IF NOT EXISTS verification_reason TEXT;
COMMIT;
```

(`root_cause` is the confirmed `error_groups` column name. The job INSERT's column list mirrors `promotion.ts`'s investigate insert exactly — it carries no `episode_id`, same as promotion's.)

- [ ] **Step 2: Write the backfill test** (Go, beside the existing migration tests in `packages/ingestion/db/` — follow `migration_064_test.go`'s harness):

```go
func TestMigration069Backfill(t *testing.T) {
    // seed three friction groups: (a) awaiting_approval, root_cause NULL, no diff -> must move to queued + get one investigate job
    // (b) awaiting_approval with root_cause set -> untouched
    // (c) awaiting_approval with candidate_diff set -> untouched
    // apply the migration file twice; assert (a) transitioned exactly once with exactly one pending job,
    // (b) and (c) unchanged both times.
}
```

(Write the seeding with the harness's existing group-insert helpers; the assertions are the four counts.)

- [ ] **Step 3: Apply to the dev DB, then apply AGAIN** — both clean; then `cd packages/ingestion && go build ./... && go test ./db/...` — PASS including the new backfill test.
- [ ] **Step 4: Commit**

```bash
git add packages/ingestion/db/migrations/069_verdict_gated_investigation.sql
git commit -m "feat(db): backfill uninvestigated parked incidents; verification reason column"
```

---

### Task 2: Verdict routing — human-judgment diagnoses become reviewable

**Files:**
- Modify: `packages/worker/src/index.ts` (the `else` branch of `processFrictionInvestigateJob`'s verdict handling, ~line 1115: `updateGroupInvestigation(..., 'insight', ...)`)
- Test: the suite covering `processFrictionInvestigateJob` verdicts (find it: `grep -rln "insight\|classify_friction" packages/worker/src/__tests__ packages/worker/src/friction/__tests__`)

**Interfaces:**
- Consumes: existing `updateGroupInvestigation`, the verdict object (`verdict.codeCause`, `verdict.reason`, `verdict.confidence`), the DB lifecycle trigger (`error_groups_action_class`) which already classifies `awaiting_approval`-without-diff as "Review the investigation." and stamps `actionable_since`.
- Produces: non-code-cause verdicts → `status='awaiting_approval'` (actionable, digest-visible) with the diagnosis attached; the recorded `decision.outcome` stays `'not_actionable'` (the decision ledger's meaning is unchanged — what changed is where the human sees it).

- [ ] **Step 1: Write the failing test**

```ts
it('routes a non-code-cause verdict to awaiting_approval (reviewable diagnosis)', async () => {
  // stub investigateFriction to return a verdict with codeCause: false
  const updates = await runFrictionInvestigationWithVerdict({
    codeCause: false,
    reason: 'Users expect the support email to be clickable; product decision, not a code defect',
    confidence: 'high',
    evidence: [{ path: 'src/LicenseWall.vue', excerpt: 'plain text email' }],
    agentTaskBrief: null,
  });
  expect(updates.status).toBe('awaiting_approval');
  expect(updates.rootCause).toContain('support email');
});
```

(Follow the file's existing stubbing pattern for `investigateFriction` — the suite already stubs it for the code-cause paths; mirror that setup and capture the `updateGroupInvestigation` call.)

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — current branch records status `'insight'`.

- [ ] **Step 3: Implement**

```ts
    } else {
      // Decision 2026-09-01: a diagnosis that needs human or product judgment
      // is a reviewable finding rather than a terminal FYI. awaiting_approval
      // without a candidate diff renders as "Review the investigation." and
      // enters the digest's actionable lane via the lifecycle trigger.
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'awaiting_approval', {
        rootCause: verdict.reason,
        confidence: verdict.confidence,
        decision,
      }, job);
      logger.info('Friction investigation: diagnosis awaiting review (no code cause)', {
        job_id: job.id,
        confidence: verdict.confidence,
      });
    }
```

Do not touch the `insight` status value itself (legacy rows keep meaning; the enum stays).

- [ ] **Step 4: Add the lifecycle-consequence test (DB-gated)**

The worker call alone does not prove digest visibility. Add to the DB-gated suite:

```ts
it('awaiting_approval without a diff stamps actionable_since via the lifecycle trigger', async () => {
  const groupId = await seedFrictionGroup({ status: 'queued' }); // existing seeding helper
  await getPool().query(`UPDATE error_groups SET status='awaiting_approval' WHERE id=$1`, [groupId]);
  const row = await getPool().query(
    `SELECT actionable_since, error_groups_action_class(status::text, candidate_diff, pr_url) AS klass
     FROM error_groups WHERE id=$1`, [groupId]);
  expect(row.rows[0].actionable_since).not.toBeNull();
  expect(row.rows[0].klass).toBe('Review the investigation.');
});
```

- [ ] **Step 4b: Freeze-admission test (Go)** — the consequence AC13 actually needs. Beside the existing freeze tests in `packages/ingestion/digest/` (follow `freeze` test harness conventions):

```go
func TestFreezeAdmitsDiagnosedFrictionIncident(t *testing.T) {
    // seed a friction group: status awaiting_approval, root_cause set, no candidate_diff,
    // actionable_since stamped (the trigger does this on the status write)
    // run FreezeCandidates for a window containing now
    // assert the group id is among the frozen candidates and its action text is "Review the investigation."
}
```

- [ ] **Step 5: Run the suite**

Run: `cd packages/worker && DATABASE_URL="$DATABASE_URL" pnpm vitest run src/__tests__/ src/friction/__tests__/ -t "verdict|lifecycle"` and `cd packages/ingestion && go test ./digest/ -run TestFreezeAdmitsDiagnosed`
Expected: PASS with the DB up (the DB-gated test must RUN, not skip — check the reported skip count); any test asserting `'insight'` for this branch gets its expectation updated to `'awaiting_approval'`.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/index.ts packages/worker/src
git commit -m "feat(worker): non-code-cause diagnoses become reviewable, digest-visible"
```

---

### Task 3: Frames verification failure carries a reason

**Files:**
- Modify: `packages/worker/src/narrative/verify.ts` (every `finalizeVerification(... state: 'failed' ...)` call site) and `packages/worker/src/db.ts` (`finalizeVerification` accepts and stores the reason)
- Test: `packages/worker/src/narrative/__tests__/verify.test.ts`

**Interfaces:**
- Consumes: `session_narratives.verification_reason` (Task 1b's migration — 068's CHECK forbids a non-null `verification` on non-ok states, so the reason has its own column).
- Produces: `finalizeVerification` args gain `reason?: string`; every non-ok terminal writes `verification_reason` — sanitized with the same control-character strip used for `raw_response` and truncated to 500 characters (provider/Chromium errors can carry paths and huge messages). The ingestion DB narrative model (`packages/ingestion/db/session_narratives.go`) SELECTs the new column, and the narrative API response (`session_read.go`) gains a `verificationReason` field; the dashboard panel shows it as plain text next to the ungraded observations. (MCP is unchanged in this plan.) Clearing: `finalizeVerification` with `state:'ok'` — and the re-claim to `verifying` — set `verification_reason = NULL`, so a later success never shows a stale failure.

- [ ] **Step 1: Failing test** — the capture-throws fallback records the thrown message:

```ts
it('stores the failure reason on fallback', async () => {
  capMock.captureFrames.mockRejectedValue(new Error('chromium crashed: SIGTRAP'));
  await processFrameVerification(job, deps('{}'), abort);
  const call = dbMock.finalizeVerification.mock.calls[0]![1];
  expect(call.state).toBe('failed');
  expect(call.reason).toContain('chromium crashed');
});
```

- [ ] **Step 2: Run, expect FAIL** (no `reason` in the call).
- [ ] **Step 3: Implement** — thread the caught error's message (and the vision-validation rejection reason) into `finalizeVerification({ ..., reason })`; sanitize + bound (500 chars), write `verification_reason`; add the field to `session_read.go`'s response and the dashboard panel's ungraded state.
- [ ] **Step 3b: Persistence + API tests** — (a) DB-gated worker test: drive `finalizeVerification` with a 2,000-char reason containing control characters; read the row back; assert stored value is sanitized and exactly 500 chars, and that a subsequent `state:'ok'` finalize NULLs it. (b) Go handler test beside the existing session_read tests: a narrative row with `verification_reason` set returns the `verificationReason` field; one without it omits/nulls the field.
- [ ] **Step 4: Run `DATABASE_URL="$DATABASE_URL" pnpm vitest run src/narrative/__tests__/verify.test.ts` and `cd packages/ingestion && go test ./handler/ -run TestSessionNarrative`** — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/narrative/verify.ts packages/worker/src/db.ts packages/ingestion/db/session_narratives.go packages/ingestion/handler/session_read.go packages/dashboard/src/views/SessionDetail.vue packages/worker/src/narrative/__tests__/verify.test.ts
git commit -m "feat(worker): frames verification failures store their reason"
```

---

### Task 4: Documentation alignment

**Files:**
- Modify: `docs/design/2026-08-31-session-narratives.md` (cross-project read expectation; rollout note)
- Modify: `docs/reference/environment-variables.md` only if it documents the old severity gate (grep `severity` there first)

**Interfaces:** none (prose).

- [ ] **Step 1:** In the design doc's MCP/API section, amend the cross-tenant expectation: reads from another organization return **403** at the org-membership layer (repo convention, verified in run 20260901-020035); in-org wrong project returns 404. Neither leaks session data.
- [ ] **Step 1b:** Document the two accepted consequences: (a) "Generate fix" is available on non-code-cause diagnoses by design — that is the fix-on-demand path; (b) product-judgment diagnoses now recur in the digest until resolved or snoozed (the existing acknowledge machinery), where `insight` was previously a one-time FYI.
- [ ] **Step 2:** In the rollout section, add the ops step: to enable automatic fix PRs for deterministic code causes on AMFJ, set `projects.friction_autonomy = 'auto_fix'` for the AMFJ project (default is `ask_first`, which parks even code-cause verdicts for approval — the decision ledger records both the same way).
- [ ] **Step 3:** Run `pnpm --filter dashboard build` is NOT needed for docs; just commit.

```bash
git add docs/design/2026-08-31-session-narratives.md docs/reference/environment-variables.md
git commit -m "docs: verdict-gated investigation decisions and 403 convention"
```

---

## Verification after all tasks

1. `cd packages/worker && pnpm build && DATABASE_URL="$DATABASE_URL" pnpm vitest run` (with the dev DB URL exported) — full worker suite green, and the reported SKIP count must not include the promotion/lifecycle DB-gated tests.
2. `cd packages/ingestion && go build ./... && go test ./...` — full ingestion suite including `./handler/...` (TriggerFix paths touch handler code reading these statuses).
3. `pnpm --filter dashboard build && pnpm --filter dashboard test` — the panel change and any fix-button gating.
4. The AC13 re-verify (separate step, run by the verifier with E2B wired): promoted incidents → investigations complete → `awaiting_approval`/fix statuses → digest freeze admits them → "Review the investigation." cards render with the diagnosis.
