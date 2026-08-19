# Inquiry → Investigation Job Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stored `investigate` inquiry decision can never commit without an `investigate` job existing for its work round — created in the same database transaction, idempotent under retries, lease-lost writers, and pre-existing jobs.

**Architecture:** `persistInquiryDecision` in the worker already writes the decision under the durable job lease inside one transaction. This plan makes that transaction authoritative: it reads `error_group_id` and `input_version` from the locked job row (never from the caller), stores the decision, resolves the *effective* stored decision (an insert suppressed by the evidence-signature dedupe defers to the earlier row), and when that effective decision is `investigate` it inserts the job and then verifies an investigate job exists for the episode, rolling back if not. No schema change; no Go change; one writer.

**Tech Stack:** Node 22 + TypeScript (packages/worker), pg, Vitest (unit + DB-gated integration tests), Postgres (existing `error_group_jobs` queue — no new queue).

**Spec:** `docs/superpowers/specs/2026-08-16-pipeline-implementation-plan.md`, section "Slice 8: add the inquiry stage" — "The same transaction creates one investigate job only for `investigate`" and "A retry stores one decision and one investigation job." Verified failing in `.verify/runs/20260819-045333/report.md` (AC2). User hard requirement (2026-08-19): a stored yes-decision must never exist without its investigation job. Plan reviewed by Codex 2026-08-19; findings 1–3, 6, 7, 9, 11–13 adopted (effective-decision gating, post-insert existence check, row-authoritative ids, strict input_version, test fixes); 5 declined as out of scope (pre-existing `now()` lease pattern; `lease_generation` is the fence), 10 declined (no production inquiry decisions exist pre-cutover, and the Slice 11 backfill explicitly does not manufacture inquiry history).

## Global Constraints

- Postgres remains the queue; do not add another queue table or system (repo AGENTS.md guardrail).
- One writer per state transition: the decision-and-job pair has exactly one writer, `persistInquiryDecision`. Do not also create investigate jobs from the Go sweep.
- Preserve lease/terminal-status contracts: all writes stay behind the existing `FOR UPDATE` + `lease_generation` fencing check; a lost lease writes nothing and returns `false`.
- ESM + strict TypeScript; `unknown` plus narrowing, no `any`.
- Tests stay colocated in `packages/worker/src/__tests__/`.
- Do not touch `test-fixtures/wire/` or the public event contract (this change is worker-internal).
- DB-gated tests need `DATABASE_URL` exported; they skip silently without it, and a skip is not a pass. A disposable stack is available: `postgres://opslane:opslane_dev@localhost:5470/opslane?sslmode=disable` (verify8).

## Background for the implementer (read once)

- `error_group_jobs` has two partial unique indexes:
  - `uq_one_job_per_episode_type_version` on `(project_id, episode_id, job_type, input_version)` where both NOT NULL;
  - `uq_one_active_job_per_episode_type` on `(project_id, episode_id, job_type)` where status is pending/claimed.
  A targetless `ON CONFLICT DO NOTHING` suppresses violations from **all** unique indexes. That makes the insert safe but not sufficient: a suppression caused by the *active* index (an investigate job pending at a different `input_version`) still means a job exists for the round, while a suppression with **no** surviving job would silently break the guarantee. Hence the explicit existence check after a suppressed insert: any investigate job for the episode satisfies "the round's yes-decision has its job" (the architecture allows one investigation per work round; retries reclaim it rather than starting another).
- `issue_inquiry_decisions` inserts use `ON CONFLICT (project_id,episode_id,prompt_version,evidence_signature) DO NOTHING`. So a retry with identical evidence is suppressed — and the *stored* row's decision, not this attempt's, is the truth. Job creation must gate on the stored decision or a `wait` round could get a job (and an earlier `investigate` row missing its job — possible only from pre-fix code paths — gets healed on the next same-signature persist).
- `ClaimedJob` (packages/worker/src/db.ts:398) does **not** carry `input_version`, and the caller's `errorGroupId` is not authoritative. The lease-check SELECT inside `persistInquiryDecision` already locks the job row `FOR UPDATE`; extend it to return `error_group_id` and `input_version` and use those values. This means **no signature changes** to `runInquiry`, `InquiryPersistInput`, or the unit-test persist seam.
- The current code deliberately skips the insert: the comment on `persistInquiryDecision` (db.ts:2050) says "no investigation job is created here", and two tests pin the absence — `inquiry-job.test.ts:41` ("records an investigate decision without creating investigation work") and `inquiry-job.integration.test.ts:77` ("stores one decision across retries and creates no investigation job", asserting `investigations.count === 0`). Flipping those tests is part of the work, not collateral damage.
- Postgres note: `now()` is fixed at transaction start. The lease-expiry comparison therefore has a millisecond-scale stale window, but the `lease_generation` fencing token — not the clock — is what actually prevents a reclaimed job's old worker from writing. This pre-existing pattern is intentionally left unchanged.

---

### Task 1: Same-transaction, verified investigate job insert (integration-test driven)

**Files:**
- Modify: `packages/worker/src/db.ts` (function `persistInquiryDecision`, lines ~2050–2118 — the whole function body between `BEGIN` and `COMMIT` is restructured as shown)
- Test: `packages/worker/src/__tests__/inquiry-job.integration.test.ts`

**Interfaces:**
- Consumes: existing `persistInquiryDecision(args): Promise<boolean>` and `runInquiry(job, signal, dependencies)`; existing `InquiryPersistInput` (unchanged).
- Produces: unchanged public signature. Behavior contract for later tasks: after `persistInquiryDecision` resolves `true` and the stored decision for `(project, episode, prompt_version, evidence_signature)` is `investigate`, at least one `error_group_jobs` row with `job_type='investigate'` exists for `(project_id, episode_id)`; the function throws (transaction rolled back) if that cannot be made true, and throws if the locked job row's `input_version` or `error_group_id` is NULL.

- [ ] **Step 1: Rewrite the integration tests to pin the new contract**

In `packages/worker/src/__tests__/inquiry-job.integration.test.ts`, replace the single `it('stores one decision across retries and creates no investigation job', ...)` block with the four tests below. Keep the surrounding `describeDb`, `beforeAll`, `afterAll`, `evidence`, and `job` scaffolding exactly as they are. Note the existing seeded inquiry job row has `input_version=1` and stays `status='claimed'` throughout (persist does not complete jobs), so every test can write under the same lease.

```typescript
  it('stores one decision and one investigation job across retries', async () => {
    const dependencies = {
      loadEvidence: async () => evidence,
      prepareRepository: async () => ({ repoPath: '/tmp/repo', cleanup: async () => undefined }),
      askModel: async () => ({
        raw: { decision: 'investigate', reason: 'real failed write', brief: 'check delete path' },
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.001,
      }),
      persist: persistInquiryDecision,
      recordUsage: async () => undefined,
    };
    await runInquiry(job, new AbortController().signal, dependencies);
    await runInquiry(job, new AbortController().signal, dependencies);

    const decisions = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM issue_inquiry_decisions
        WHERE project_id=$1 AND episode_id=$2`, [projectId, episodeId],
    );
    const investigations = await pool.query<{ count: number; input_version: number | null; error_group_id: string }>(
      `SELECT count(*)::int AS count, min(input_version)::int AS input_version,
              min(error_group_id::text) AS error_group_id
         FROM error_group_jobs
        WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'`, [projectId, episodeId],
    );
    expect(decisions.rows[0]!.count).toBe(1);
    expect(investigations.rows[0]!.count).toBe(1);
    // Both values come from the locked inquiry-job row, not the caller.
    expect(investigations.rows[0]!.input_version).toBe(1);
    expect(investigations.rows[0]!.error_group_id).toBe(issueId);
  });

  it('a conflicting later attempt defers to the stored decision and creates no job', async () => {
    // Same signature + prompt version as an existing wait decision, but this
    // attempt says investigate: the decision insert is suppressed, the stored
    // wait row is the effective decision, and no investigate job may appear.
    const waitEpisode = await seedEpisodeWithClaimedJob('conflict');
    const base = {
      projectId, episodeId: waitEpisode.episodeId, jobId: waitEpisode.jobId,
      workerId: 'inquiry-test-worker', leaseGeneration: waitEpisode.leaseGeneration,
      reason: 'r', brief: null, relatedIssues: [] as string[], affectedUnits: 3,
      evidenceSignature: 'sig-conflict-1', productUnderstandingVersion: null,
      model: 'test-model', promptVersion: 1,
    };
    expect(await persistInquiryDecision({ ...base, decision: 'wait_for_more_evidence' })).toBe(true);
    expect(await persistInquiryDecision({ ...base, decision: 'investigate' })).toBe(true);

    const stored = await pool.query<{ decision: string; count: number }>(
      `SELECT min(decision) AS decision, count(*)::int AS count FROM issue_inquiry_decisions
        WHERE project_id=$1 AND episode_id=$2`, [projectId, waitEpisode.episodeId],
    );
    const investigations = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM error_group_jobs
        WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'`, [projectId, waitEpisode.episodeId],
    );
    expect(stored.rows[0]!.count).toBe(1);
    expect(stored.rows[0]!.decision).toBe('wait_for_more_evidence');
    expect(investigations.rows[0]!.count).toBe(0);
  });

  it('creates no investigation job for a non-investigate decision and stores it', async () => {
    const waitEpisode = await seedEpisodeWithClaimedJob('refusal');
    const waitJob: ClaimedJob = {
      id: waitEpisode.jobId, workerId: 'inquiry-test-worker', leaseGeneration: waitEpisode.leaseGeneration,
      errorGroupId: waitEpisode.issueId, eventId: null, episodeId: waitEpisode.episodeId, sourceId: null,
      projectId, jobType: 'issue_inquiry', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: null,
    };
    await runInquiry(waitJob, new AbortController().signal, {
      loadEvidence: async () => evidence,
      prepareRepository: async () => ({ repoPath: '/tmp/repo', cleanup: async () => undefined }),
      askModel: async () => ({
        raw: { decision: 'wait_for_more_evidence', reason: 'single unit, no replay' },
        usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.001,
      }),
      persist: persistInquiryDecision,
      recordUsage: async () => undefined,
    });

    const stored = await pool.query<{ decision: string }>(
      `SELECT decision FROM issue_inquiry_decisions
        WHERE project_id=$1 AND episode_id=$2`, [projectId, waitEpisode.episodeId],
    );
    const investigations = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM error_group_jobs
        WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'`, [projectId, waitEpisode.episodeId],
    );
    expect(stored.rows[0]?.decision).toBe('wait_for_more_evidence');
    expect(investigations.rows[0]!.count).toBe(0);
  });

  it('a stale lease generation writes nothing at all', async () => {
    const staleEpisode = await seedEpisodeWithClaimedJob('stale');
    const wrote = await persistInquiryDecision({
      projectId, episodeId: staleEpisode.episodeId, jobId: staleEpisode.jobId,
      workerId: 'inquiry-test-worker', leaseGeneration: '999999',
      decision: 'investigate', reason: 'r', brief: 'b', relatedIssues: [], affectedUnits: 3,
      evidenceSignature: 'sig-stale-1', productUnderstandingVersion: null,
      model: 'test-model', promptVersion: 1,
    });
    expect(wrote).toBe(false);
    const decisions = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM issue_inquiry_decisions
        WHERE project_id=$1 AND episode_id=$2`, [projectId, staleEpisode.episodeId],
    );
    const investigations = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM error_group_jobs
        WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'`, [projectId, staleEpisode.episodeId],
    );
    expect(decisions.rows[0]!.count).toBe(0);
    expect(investigations.rows[0]!.count).toBe(0);
  });
```

Add the shared seeding helper inside the `describeDb` block (above the tests, after `beforeAll`):

```typescript
  async function seedEpisodeWithClaimedJob(tag: string): Promise<{
    issueId: string; episodeId: string; jobId: string; leaseGeneration: string;
  }> {
    const newIssueId = (await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id,fingerprint,title,first_seen,last_seen,status)
       VALUES ($1,$2,$3,now(),now(),'candidate') RETURNING id`,
      [projectId, `inquiry-${tag}-${crypto.randomUUID()}`, `Inquiry ${tag} issue`],
    )).rows[0]!.id;
    const newEpisodeId = (await pool.query<{ id: string }>(
      `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
       VALUES ($1,$2,1) RETURNING id`,
      [projectId, newIssueId],
    )).rows[0]!.id;
    const row = (await pool.query<{ id: string; lease_generation: string }>(
      `INSERT INTO error_group_jobs
         (error_group_id,project_id,episode_id,job_type,status,worker_id,
          claimed_at,lease_expires_at,lease_generation,input_version)
       VALUES ($1,$2,$3,'issue_inquiry','claimed','inquiry-test-worker',
               now()-interval '10 years',now()+interval '5 minutes',1,1)
       RETURNING id,lease_generation::text AS lease_generation`,
      [newIssueId, projectId, newEpisodeId],
    )).rows[0]!;
    return { issueId: newIssueId, episodeId: newEpisodeId, jobId: row.id, leaseGeneration: row.lease_generation };
  }
```

- [ ] **Step 2: Run the integration tests to verify they fail**

Run:
```bash
cd packages/worker
DATABASE_URL='postgres://opslane:opslane_dev@localhost:5470/opslane?sslmode=disable' \
  pnpm vitest run src/__tests__/inquiry-job.integration.test.ts
```
Expected: FAIL on the first test's assertion `expect(investigations.rows[0]!.count).toBe(1)` receiving `0`. (Tests 2–4 pass against the current code — they pin behavior that must survive the change.) If the suite reports SKIPPED, `DATABASE_URL` is missing; a skip is not a valid signal — fix the environment and re-run.

- [ ] **Step 3: Restructure `persistInquiryDecision`**

In `packages/worker/src/db.ts`, rewrite the function body (the `args` type is unchanged) so the transaction becomes: lock-and-read the job row → insert decision → resolve the stored decision → conditionally insert the job → verify → commit.

```typescript
/**
 * Append an inquiry decision under the durable job lease. The unique evidence
 * key makes a retry idempotent. When the STORED decision for this evidence is
 * investigate, the same transaction guarantees the round's investigate job
 * exists — inserting it idempotently and verifying it survived — so a
 * committed yes-decision can never exist without investigation work.
 */
export async function persistInquiryDecision(args: {
  projectId: string;
  episodeId: string;
  jobId: string;
  workerId: string;
  leaseGeneration: string;
  decision: 'investigate' | 'wait_for_more_evidence' | 'do_not_pursue';
  reason: string;
  brief: string | null;
  relatedIssues: string[];
  affectedUnits: number;
  evidenceSignature: string;
  productUnderstandingVersion: number | null;
  model: string;
  promptVersion: number;
}): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const lease = await client.query<{ error_group_id: string | null; input_version: number | null }>(
      `SELECT error_group_id, input_version
         FROM error_group_jobs
        WHERE id=$1 AND project_id=$2 AND episode_id=$3
          AND worker_id=$4 AND lease_generation=$5::bigint
          AND job_type='issue_inquiry' AND status='claimed'
          AND lease_expires_at > now()
        FOR UPDATE`,
      [args.jobId, args.projectId, args.episodeId, args.workerId, args.leaseGeneration],
    );
    if ((lease.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const errorGroupId = lease.rows[0]?.error_group_id;
    const inputVersion = lease.rows[0]?.input_version;
    if (!errorGroupId || inputVersion === null || inputVersion === undefined) {
      // A job row without its issue or round version cannot satisfy the
      // one-job-per-round invariant; fail the attempt rather than guess.
      throw new Error(`Inquiry job ${args.jobId} missing error_group_id or input_version`);
    }
    const inserted = await client.query(
      `INSERT INTO issue_inquiry_decisions
         (project_id,episode_id,decision,reason,brief,related_issues,
          evaluated_units,evidence_signature,product_understanding_version,model,prompt_version)
       VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11)
       ON CONFLICT (project_id,episode_id,prompt_version,evidence_signature)
       DO NOTHING
       RETURNING decision`,
      [
        args.projectId,
        args.episodeId,
        args.decision,
        args.reason,
        args.brief,
        args.relatedIssues,
        args.affectedUnits,
        args.evidenceSignature,
        args.productUnderstandingVersion,
        args.model,
        args.promptVersion,
      ],
    );
    // A suppressed insert defers to the row that beat it there: the stored
    // decision, not this attempt's, decides whether investigation work exists.
    let effectiveDecision = inserted.rows[0]?.decision as string | undefined;
    if (effectiveDecision === undefined) {
      const existing = await client.query<{ decision: string }>(
        `SELECT decision FROM issue_inquiry_decisions
          WHERE project_id=$1 AND episode_id=$2 AND prompt_version=$3 AND evidence_signature=$4`,
        [args.projectId, args.episodeId, args.promptVersion, args.evidenceSignature],
      );
      effectiveDecision = existing.rows[0]?.decision;
      if (effectiveDecision === undefined) {
        throw new Error(`Inquiry decision for job ${args.jobId} neither inserted nor found`);
      }
    }
    if (effectiveDecision === 'investigate') {
      await client.query(
        `INSERT INTO error_group_jobs
           (error_group_id,project_id,episode_id,job_type,status,input_version,triggered_by)
         VALUES ($1,$2,$3,'investigate','pending',$4,'auto')
         ON CONFLICT DO NOTHING`,
        [errorGroupId, args.projectId, args.episodeId, inputVersion],
      );
      // The targetless conflict clause swallows every unique-index violation,
      // so prove the invariant instead of assuming it: some investigate job
      // must now exist for this round, whatever its version or status.
      const jobExists = await client.query(
        `SELECT 1 FROM error_group_jobs
          WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'
          LIMIT 1`,
        [args.projectId, args.episodeId],
      );
      if ((jobExists.rowCount ?? 0) === 0) {
        throw new Error(
          `Investigate decision for episode ${args.episodeId} has no investigation job after insert`,
        );
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
```

No changes to `packages/worker/src/inquiry/job.ts` — `runInquiry` and `InquiryPersistInput` keep their current shapes; the authoritative ids come from the locked row.

- [ ] **Step 4: Run the integration tests to verify they pass**

Run:
```bash
cd packages/worker
DATABASE_URL='postgres://opslane:opslane_dev@localhost:5470/opslane?sslmode=disable' \
  pnpm vitest run src/__tests__/inquiry-job.integration.test.ts
```
Expected: PASS, 4 tests, 0 skipped.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/__tests__/inquiry-job.integration.test.ts
git commit -m "fix(worker): guarantee the investigate job in the inquiry decision transaction"
```

---

### Task 2: Flip the unit test that pins the old behavior

**Files:**
- Modify: `packages/worker/src/__tests__/inquiry-job.test.ts` (first test's title only, line 41)

**Interfaces:**
- Consumes: nothing new — `InquiryPersistInput` is unchanged by Task 1.
- Produces: nothing — this removes the false claim from the test name.

- [ ] **Step 1: Rename the pinning test**

The unit test mocks `persist`, so it observes the seam, not the database; its body stays valid. Only its title asserts the wrong contract. Change:

```typescript
  it('records an investigate decision without creating investigation work', async () => {
```

to:

```typescript
  it('records an investigate decision through the persist seam', async () => {
```

The second test ("stores do_not_pursue and creates no work itself") remains accurate — `runInquiry` itself never creates work; the transaction inside `persistInquiryDecision` does — leave it unchanged.

- [ ] **Step 2: Run the unit tests to verify they pass**

Run:
```bash
cd packages/worker
pnpm vitest run src/__tests__/inquiry-job.test.ts
```
Expected: PASS, all tests.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/__tests__/inquiry-job.test.ts
git commit -m "test(worker): stop pinning the absence of the investigate handoff"
```

---

### Task 3: Package gate and live smoke of the fixed handoff

**Files:**
- No source changes. Verification only.

**Interfaces:**
- Consumes: Tasks 1–2 committed.
- Produces: evidence that AC2 from `.verify/runs/20260819-045333` now holds on the running system. The deterministic proof is Task 1's integration suite; this live pass is a smoke against the assembled stack, not the acceptance test.

- [ ] **Step 1: Run the worker package gate**

Run:
```bash
cd packages/worker
pnpm build
DATABASE_URL='postgres://opslane:opslane_dev@localhost:5470/opslane?sslmode=disable' pnpm test
```
Expected: build clean; tests pass; the inquiry integration suite ran (check the skip count in the summary — a green run with these suites skipped is a failure signal).

- [ ] **Step 2: Rebuild the worker image and smoke the handoff on the verify8 stack**

The verify8 stack from run 20260819-045333 is still up (ingestion :8099, Postgres :5470). Its env lives in `.verify/runs/20260819-045333/stack.env`.

```bash
cd "$(git rev-parse --show-toplevel)"
set -a; source .verify/runs/20260819-045333/stack.env
export $(grep -E "^ANTHROPIC_API_KEY" ~/opslane-oss/.env | xargs); set +a
docker compose build worker && docker compose up -d worker
# The twin repo lives in the container filesystem and is lost on recreate — rebuild it:
docker cp test-fixtures/fix-target-app verify8-worker-1:/tmp/twin-src
docker exec -u root verify8-worker-1 sh -c 'chown -R opslane:opslane /tmp/twin-src && mkdir -p /twin-github/opslane && chown -R opslane:opslane /twin-github'
docker exec verify8-worker-1 sh -c 'cd /tmp/twin-src && rm -rf .git && git init -q -b main && git -c user.email=rig@local -c user.name=rig add -A && git -c user.email=rig@local -c user.name=rig commit -qm twin && git clone -q --bare /tmp/twin-src /twin-github/opslane/defender-test-fixture.git'
```

Then send two events for a fresh issue (new message text, two distinct `context.user.id` values, distinct `session_id`s, no `debug_meta`, and a failed request to bias toward investigate: `network_timings: [{transport:"fetch",method:"POST",url:"https://app.example.com/api/orders",started_at_ms:1787000000000,duration_ms:40,outcome:"http_error",status:500}]`) to `http://localhost:8099/api/v1/events` with header `X-API-Key: opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq`. Poll until the episode's `issue_inquiry` job is terminal, then check:

```sql
SELECT decision FROM issue_inquiry_decisions WHERE episode_id='<EP>' ORDER BY decided_at DESC LIMIT 1;
SELECT count(*) FROM error_group_jobs WHERE episode_id='<EP>' AND job_type='investigate';
```

Expected: if the live decision is `investigate`, the count is exactly 1 the moment the inquiry job is terminal — never 0-then-1 later. If the live model declines to investigate, that smoke leg is inconclusive (the model is nondeterministic); the integration suite from Task 1 remains the proof, and the smoke may be retried once with a richer issue. Do not weaken the check to "eventually".

- [ ] **Step 3: Commit the plan document**

```bash
git add docs/superpowers/plans/2026-08-19-inquiry-investigate-job-handoff.md
git commit -m "docs: plan for inquiry investigate-job handoff fix"
```

(`.verify/` is gitignored; the verify-run artifacts stay local.)

---

## Self-Review

1. **Spec coverage:** "same transaction creates one investigate job only for investigate" → Task 1 Step 3 (conditional insert + existence check before COMMIT, gated on the *stored* decision); "a retry stores one decision and one investigation job" → Task 1 Step 1 first test (double `runInquiry`, counts 1/1); "only for investigate" refusal side → third test (decision stored, zero jobs); conflicting-attempt safety → second test; lease fencing → fourth test; user hard requirement → the existence check makes a yes-decision commit impossible without a job, and the thrown error rolls both back so the durable job retries.
2. **Placeholder scan:** every step carries exact code, commands, and expected output; no TBDs, no "handle edge cases".
3. **Type consistency:** `persistInquiryDecision`'s public args type is unchanged (verified against `InquiryPersistInput` in inquiry/job.ts — same field set); the new locals (`errorGroupId`, `inputVersion`, `effectiveDecision`) exist only inside the function; test helper `seedEpisodeWithClaimedJob` returns the exact fields the tests destructure.
