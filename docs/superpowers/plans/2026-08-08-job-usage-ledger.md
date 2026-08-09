# Job Usage Ledger + Outcome Scores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-phase token/cost spend for every error job in Postgres, push investigation and PR outcomes onto Langfuse traces as scores, and surface blended cost-per-merged-PR on the admin dashboard.

**Architecture:** An insert-only `job_usage` ledger (one row per job × execution × phase × model) written best-effort by the Node worker; a `score_sync` job enqueued transactionally by the Go PR-webhook handler and processed by the worker (which owns the Langfuse credentials) with normal queue retry semantics; two new aggregates on the existing `/api/v1/admin/overview`. Decisions and vocabulary: `docs/adr/0001-postgres-usage-ledger.md`, `CONTEXT.md` (Usage ledger, Phase, Outcome score).

**Tech Stack:** Postgres migrations (`packages/ingestion/db/migrations/`), Go 1.24 + pgx (ingestion), Node 22 + TypeScript ESM (worker), Vitest, Vue 3 (dashboard).

## Global Constraints

- The **ledger** is best-effort: a failed `job_usage` insert is logged and never fails or blocks the job (ADR-0001). The **score_sync job** is the opposite: a failed score push THROWS so the queue's retry/dead-letter machinery applies — it is an outbox, not fire-and-forget.
- Insert-only is **database-enforced**, copying `034_diagnosis_decisions_immutable.sql`'s exact idiom: each trigger swap wrapped in its own `BEGIN`/`COMMIT` (migrations reapply on every boot; a bare DROP-then-CREATE opens a mutable window each boot), and a separate statement-level TRUNCATE trigger (TRUNCATE does not fire row triggers).
- Unique key `(job_id, execution, phase, model)`; duplicate inserts dropped with `ON CONFLICT DO NOTHING`.
- **Execution number** = `error_group_jobs.attempts` as returned by `claimJob` (`ClaimedJob.attempts`, `packages/worker/src/db.ts:140`).
- `phase` is plain text validated by a TS union in the worker; **no CHECK on phase values** — new phases must not require a migration. CHECKs on *shape* (non-empty, non-negative) are fine and included.
- **Ledger `cost_usd` is recomputed from tokens at write time** via the pricing table — never trust an agent-returned `costUsd` (the truncated-turn path in `readonly-agent.ts:197-206` adds usage then returns a stale `costUsd`; tokens are the durable truth per ADR-0001).
- v1 phase coverage: `investigation` and `fix` for **error** jobs. Friction investigations (`packages/worker/src/friction/investigate-friction.ts`) call Anthropic directly and expose no usage today — they are **explicitly deferred**, not silently skipped; do not claim full coverage.
- v1 admin metric is **blended** cost per merged PR (total 7d ledger spend ÷ merged 7d) — no causal attribution join.
- Every worker DB helper is tenant-scoped: queries take and filter by `project_id` (`packages/ingestion/AGENTS.md`; same contract in the worker).
- Langfuse credentials stay in the worker only. The Go service never talks to Langfuse.
- Do not change existing log `msg` strings — `~/deploy` runbook queries match on them exactly.
- Do not edit or renumber existing migrations; the new migration is `043_job_usage_ledger.sql`. Migration verification follows `packages/ingestion/AGENTS.md`: apply to a **disposable clean database** and a **representative existing database**, then **reapply** to verify idempotency.
- `JobType` is a closed union in `shared/src/types.ts:376`. Adding `score_sync` means editing shared, rebuilding workspaces (`pnpm -r build`), and updating every job-type allowlist: `adminJobTypes` in `packages/ingestion/handler/admin.go:14` and the dashboard's `AdminJobType` in `packages/dashboard/src/types/api.ts:~337`.
- Worker DB tests are DATABASE_URL-gated integration tests in `packages/worker/src/__tests__/`; they skip (not fail) without `DATABASE_URL`. Tests that insert `job_usage` rows must clean up via the Task 2 purge helper **before** deleting their `error_group_jobs` fixtures (the FK blocks the delete and the trigger blocks a plain `DELETE FROM job_usage`).

---

### Task 1: Migration 041 — `job_usage` table, immutability triggers, `source_job_id`

**Files:**
- Create: `packages/ingestion/db/migrations/043_job_usage_ledger.sql`
- Test: applied-and-reapplied verification below + Task 2's integration test

**Interfaces:**
- Produces: table `job_usage` and column `error_group_jobs.source_job_id UUID NULL` — consumed by Tasks 2, 4, 8.

- [ ] **Step 1: Write the migration**

```sql
-- The worker computes token usage and cost per phase of every job but only
-- emitted them as Langfuse span attributes; Langfuse is optional, so spend
-- was unjoinable to outcomes. job_usage is the insert-only ledger of that
-- spend: one row per (job, execution, phase, model). Best-effort writes;
-- see docs/adr/0001-postgres-usage-ledger.md.

CREATE TABLE IF NOT EXISTS job_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES error_group_jobs(id),
  execution INTEGER NOT NULL CHECK (execution >= 0),
  phase TEXT NOT NULL CHECK (phase <> ''),
  model TEXT NOT NULL CHECK (model <> ''),
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens BIGINT NOT NULL CHECK (cache_write_tokens >= 0),
  cost_usd NUMERIC(12, 4) NOT NULL CHECK (cost_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, execution, phase, model)
);

-- The 7d spend aggregate scans by time.
CREATE INDEX IF NOT EXISTS idx_job_usage_created_at ON job_usage (created_at);

-- Insert-only, database-enforced. A ledger row records what a run spent at
-- the time; mutating it would rewrite history for spend that already happened.
CREATE OR REPLACE FUNCTION reject_job_usage_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'job_usage is insert-only: % rejected', TG_OP
    USING ERRCODE = '2F004';
END;
$$ LANGUAGE plpgsql;

-- One transaction per swap. run-migrations.sh invokes `psql -f`, which
-- autocommits each statement, and the compose migrate service re-runs every
-- file on every boot — so a bare DROP-then-CREATE would leave a window on
-- each boot where the table this migration exists to protect was fully
-- mutable. Same idiom as 034_diagnosis_decisions_immutable.sql.
BEGIN;
DROP TRIGGER IF EXISTS job_usage_immutable_row ON job_usage;
CREATE TRIGGER job_usage_immutable_row
  BEFORE UPDATE OR DELETE ON job_usage
  FOR EACH ROW EXECUTE FUNCTION reject_job_usage_mutation();
COMMIT;

-- TRUNCATE does not fire row-level triggers, so it needs a statement trigger.
BEGIN;
DROP TRIGGER IF EXISTS job_usage_immutable_truncate ON job_usage;
CREATE TRIGGER job_usage_immutable_truncate
  BEFORE TRUNCATE ON job_usage
  FOR EACH STATEMENT EXECUTE FUNCTION reject_job_usage_mutation();
COMMIT;

-- The investigate job that created a fix job. Nullable: pre-existing rows and
-- non-fix jobs have none. Unbackfillable, which is why it lands with the
-- ledger rather than later (ADR-0001, "Attribution boundary").
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS source_job_id UUID REFERENCES error_group_jobs(id);
```

- [ ] **Step 2: Verify per the ingestion package contract (disposable + representative + reapply)**

`packages/ingestion/AGENTS.md` requires all three. Use a unique disposable name so an interrupted earlier run can't collide, and a trap so the drop always happens:

```bash
docker compose up -d postgres
_MIG_DB="opslane_mig_check_$$"
psql "$DATABASE_URL" -c "CREATE DATABASE ${_MIG_DB};"
trap 'psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS ${_MIG_DB};"' EXIT
_MIG_URL="${DATABASE_URL%/*}/${_MIG_DB}?sslmode=disable"

# 1. Disposable clean database: all migrations from scratch.
for f in packages/ingestion/db/migrations/*.sql; do psql "$_MIG_URL" -v ON_ERROR_STOP=1 -f "$f"; done

# 2. Representative existing database: the dev DB, which already has data.
docker compose run --rm migrate

# 3. Reapply for idempotency: run the new file again against both.
psql "$_MIG_URL" -v ON_ERROR_STOP=1 -f packages/ingestion/db/migrations/043_job_usage_ledger.sql
docker compose run --rm migrate
```

Expected: zero errors on all three passes.

- [ ] **Step 3: Prove the trigger rejects mutation (with a real fixture — an empty table proves nothing)**

On the disposable database, the complete fixture chain (columns per `001_baseline.sql`: `orgs(name)`, `projects(org_id, name, github_repo)`, `error_groups(project_id, fingerprint, title, first_seen, last_seen)`, `error_group_jobs(error_group_id, project_id)`):

```bash
psql "$_MIG_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO orgs (id, name)
  VALUES ('00000000-0000-4000-8000-00000000000a', 'mig-check');
INSERT INTO projects (id, org_id, name, github_repo)
  VALUES ('00000000-0000-4000-8000-00000000000b',
          '00000000-0000-4000-8000-00000000000a', 'mig-check', 'mig/check');
INSERT INTO error_groups (id, project_id, fingerprint, title, first_seen, last_seen)
  VALUES ('00000000-0000-4000-8000-00000000000c',
          '00000000-0000-4000-8000-00000000000b', 'fp-mig-check', 'mig check', now(), now());
INSERT INTO error_group_jobs (id, error_group_id, project_id)
  VALUES ('00000000-0000-4000-8000-00000000000d',
          '00000000-0000-4000-8000-00000000000c',
          '00000000-0000-4000-8000-00000000000b');
INSERT INTO job_usage (job_id, execution, phase, model, input_tokens, output_tokens,
                       cache_read_tokens, cache_write_tokens, cost_usd)
  VALUES ('00000000-0000-4000-8000-00000000000d', 0, 'investigation', 'claude-sonnet-5', 1, 1, 0, 0, 0.0001);
SQL
# The last INSERT must report INSERT 0 1 — a zero-row insert makes the next checks vacuous.
psql "$_MIG_URL" -c "UPDATE job_usage SET cost_usd = 0;"     # expect: job_usage is insert-only: UPDATE rejected
psql "$_MIG_URL" -c "DELETE FROM job_usage;"                  # expect: job_usage is insert-only: DELETE rejected
psql "$_MIG_URL" -c "TRUNCATE job_usage;"                     # expect: job_usage is insert-only: TRUNCATE rejected
# The EXIT trap drops the disposable database.
```

- [ ] **Step 4: Commit**

```bash
git add packages/ingestion/db/migrations/043_job_usage_ledger.sql
git commit -m "feat(db): job_usage ledger, immutability triggers, source_job_id"
```

---

### Task 2: Worker `recordJobUsage` + test purge helper

**Files:**
- Modify: `packages/worker/src/db.ts` (new exports near `recordDiagnosisDecision`, ~line 125)
- Create: `packages/worker/src/__tests__/purge-job-usage.ts`
- Test: `packages/worker/src/__tests__/job-usage.integration.test.ts`

**Interfaces:**
- Consumes: `job_usage` table (Task 1), `getPool()`, `logger`/`safeErrorMessage`.
- Produces (Task 3 depends on these exact names):

```ts
export type UsagePhase = 'investigation' | 'fix';
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export async function recordJobUsage(entry: {
  jobId: string; execution: number; phase: UsagePhase; model: string;
  usage: TokenUsage; costUsd: number;
}): Promise<void>  // never throws
// test-only:
export async function purgeJobUsage(pool: pg.Pool, jobIds: string[]): Promise<void>
```

- [ ] **Step 1: Write the test purge helper**

`job_usage` rows FK-block deleting their `error_group_jobs` fixtures, and the trigger blocks a plain DELETE. Mirror `packages/worker/src/__tests__/purge-diagnosis-decisions.ts` (read it first; match its shape exactly — if it disables the trigger by name, do the same with `job_usage_immutable_row`):

```ts
import type pg from 'pg';

/**
 * Test-only: job_usage is insert-only by trigger (migration 041), but tests
 * must delete their fixtures. Disable the row trigger, delete, re-enable.
 * Never ship this pattern in product code.
 */
export async function purgeJobUsage(pool: pg.Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE job_usage DISABLE TRIGGER job_usage_immutable_row');
    await client.query('DELETE FROM job_usage WHERE job_id = ANY($1::uuid[])', [jobIds]);
  } finally {
    try {
      // Do NOT swallow this error (the existing purge-diagnosis-decisions helper
      // doesn't either): a silent failure here leaves the shared dev database
      // mutable, which is worse than a loud test failure.
      await client.query('ALTER TABLE job_usage ENABLE TRIGGER job_usage_immutable_row');
    } finally {
      client.release();
    }
  }
}
```

- [ ] **Step 2: Write the failing integration test**

Copy the DATABASE_URL gating and fixture pattern from `packages/worker/src/__tests__/db.test.ts` (including its cleanup ordering — purge `job_usage` first, then the jobs):

```ts
import { describe, expect, it } from 'vitest';
import { recordJobUsage, getPool } from '../db.js';
import { purgeJobUsage } from './purge-job-usage.js';
// + fixture/gating imports copied from db.test.ts

describe.skipIf(!process.env['DATABASE_URL'])('recordJobUsage', () => {
  it('inserts one row and is idempotent per (job, execution, phase, model)', async () => {
    const jobId = await createFixtureJob(); // fixture pattern from db.test.ts
    try {
      const entry = {
        jobId, execution: 0, phase: 'investigation' as const, model: 'claude-sonnet-5',
        usage: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 200 },
        costUsd: 0.0731,
      };
      await recordJobUsage(entry);
      await recordJobUsage(entry); // duplicate — must not throw, must not double-count

      const { rows } = await getPool().query(
        `SELECT execution, phase, model, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, cost_usd::float8 AS cost_usd
         FROM job_usage WHERE job_id = $1`,
        [jobId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        execution: 0, phase: 'investigation', model: 'claude-sonnet-5',
        input_tokens: '1200', output_tokens: '340',
        cache_read_tokens: '9000', cache_write_tokens: '200',
        cost_usd: 0.0731,
      });
    } finally {
      await purgeJobUsage(getPool(), [jobId]);
      // then the suite's normal job/group/project cleanup
    }
  });

  it('swallows insert failures instead of throwing', async () => {
    await expect(recordJobUsage({
      jobId: '00000000-0000-4000-8000-000000000000', // violates the FK
      execution: 0, phase: 'fix', model: 'claude-sonnet-5',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.0001,
    })).resolves.toBeUndefined();
  });
});
```

Note: pg returns BIGINT columns as strings — hence `'1200'`; `cost_usd::float8` makes NUMERIC come back as a number. If `getPool` is not exported from `db.ts`, use whatever pool accessor `db.test.ts` uses.

- [ ] **Step 3: Run the test, verify it fails**

```bash
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"  # adjust port per worktree block in AGENTS.md
pnpm --filter @opslane/worker test -- job-usage
```

Expected: FAIL — `recordJobUsage` is not exported.

- [ ] **Step 4: Implement `recordJobUsage` in `db.ts`**

```ts
export type UsagePhase = 'investigation' | 'fix';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Best-effort append to the job_usage ledger. Never throws: a billing-analytics
 * row must not fail a job that is otherwise landing. The unique key plus
 * ON CONFLICT DO NOTHING makes a replayed phase idempotent per execution;
 * the mutation triggers (migration 041) make rows immutable once written.
 * See docs/adr/0001-postgres-usage-ledger.md.
 */
export async function recordJobUsage(entry: {
  jobId: string;
  execution: number;
  phase: UsagePhase;
  model: string;
  usage: TokenUsage;
  costUsd: number;
}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO job_usage
         (job_id, execution, phase, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (job_id, execution, phase, model) DO NOTHING`,
      [
        entry.jobId,
        entry.execution,
        entry.phase,
        entry.model,
        Math.round(entry.usage.input),
        Math.round(entry.usage.output),
        Math.round(entry.usage.cacheRead),
        Math.round(entry.usage.cacheWrite),
        Math.max(0, entry.costUsd).toFixed(4),
      ],
    );
  } catch (err: unknown) {
    logger.error('job_usage insert failed', {
      job_id: entry.jobId,
      phase: entry.phase,
      error: safeErrorMessage(err),
    });
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
pnpm --filter @opslane/worker test -- job-usage
```

Expected: PASS (2 tests, 0 skipped — confirm `DATABASE_URL` is exported).

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/__tests__/purge-job-usage.ts \
        packages/worker/src/__tests__/job-usage.integration.test.ts
git commit -m "feat(worker): best-effort job_usage ledger writer + test purge helper"
```

---

### Task 3: Record investigation and fix spend

**Files:**
- Modify: `packages/worker/src/index.ts` (investigate processor ~lines 630-690; fix dispatch calls `processFixJob` at ~line 372 — find where `processFixJob` builds the `runPipeline` input)
- Modify: `packages/worker/src/pipeline.ts` (`PipelineInput`, ~line 21 — forward `usageContext` to the agent-fix input)
- Modify: `packages/worker/src/agent-fix.ts` (input type; tier loop ~lines 700-1000)
- Modify: `packages/worker/src/harness/agent-loop.ts` (export a pricing lookup)
- Test: `packages/worker/src/__tests__/job-usage-wiring.test.ts` (unit, mocked — no DB)

**Interfaces:**
- Consumes: `recordJobUsage`, `UsagePhase`, `TokenUsage` (Task 2); `ClaimedJob.attempts`/`.id`; `INVESTIGATION_MODEL` (`packages/worker/src/investigate.ts:22`); the investigation result's `usage` field (`investigate.ts:87-91`, carried on every return path); `agentState.tokenUsage` and `tier.model` in `agent-fix.ts`; `calculateCost` (`@opslane/agent-core`, `packages/agent-core/src/tool-loop.ts:242`).
- Produces: `pricingFor(model: string): ModelPricing` exported from `harness/agent-loop.ts`; `usageContext?: { jobId: string; execution: number }` threaded `index.ts → PipelineInput → AgentFixInput`.

- [ ] **Step 1: Export the pricing lookup from `agent-loop.ts`**

`MODEL_PRICING` and `DEFAULT_PRICING` are module-private at `packages/worker/src/harness/agent-loop.ts:8-19`. Below them add:

```ts
export function pricingFor(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}
```

(`ModelPricing` comes from `@opslane/agent-core`; import the type if not already imported.)

**Also add the missing Sonnet 5 entry** to this file's `MODEL_PRICING` map — it has no `claude-sonnet-5` key today, so `pricingFor('claude-sonnet-5')` would silently price at the $3/$15 default instead of the introductory $2/$10. Copy the entry AND its expiry comment from `investigate.ts:41-46` verbatim:

```ts
  // Sonnet 5's introductory rate, $2/$10, runs through 2026-08-31. List is
  // $3/$15. Keep in sync with the table in investigate.ts.
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.50, cacheRead: 0.20 },
```

- [ ] **Step 2: Fix the investigation cost at its source, then record the phase**

The investigation result's `costUsd` is stale on the truncated path: `readonly-agent.ts:197-206` adds the final turn's usage and returns a `costUsd` computed before it. Fix it where the accurate `pricing` is already in scope rather than duplicating pricing knowledge downstream — in `investigate.ts`, after the run returns (~line 262), replace the trust in `run.costUsd`:

```ts
// investigate.ts — pricing (line 238) is already the resolved table for INVESTIGATION_MODEL.
const costUsd = Number(calculateCost(run.usage, pricing).toFixed(4));
```

(`calculateCost` from `@opslane/agent-core`; `run.usage` is complete on every return path per the comment at `investigate.ts:264-266`. `run.costUsd` remains the loop's budget-enforcement value; the returned/persisted figure is the recomputed one.)

Then in the `index.ts` investigate processor, immediately after `triage` is available and before the outcome branching:

```ts
await recordJobUsage({
  jobId: job.id,
  execution: job.attempts,
  phase: 'investigation',
  model: INVESTIGATION_MODEL,
  usage: triage.usage,
  costUsd: triage.costUsd, // now recomputed-from-tokens at the source
});
```

Imports: `recordJobUsage` (`./db.js`), `INVESTIGATION_MODEL` (`./investigate.js`).

**Friction investigations are deferred**: `friction/investigate-friction.ts` calls Anthropic directly and returns no usage. Do not touch it; the deferral is recorded in this plan and in the coverage constraint above.

- [ ] **Step 3: Thread `usageContext` through the pipeline**

The fix path is `index.ts processFixJob → runPipeline (pipeline.ts) → agent-fix`. Three edits, same shape:

1. `agent-fix.ts`: add `usageContext?: { jobId: string; execution: number };` to the fix input interface (the type of the `input` used at lines 708-712).
2. `pipeline.ts`: add the same optional field to `PipelineInput` (~line 21) and pass it through where the pipeline builds the agent-fix input.
3. `index.ts`: in `processFixJob`, set `usageContext: { jobId: job.id, execution: job.attempts }` on the pipeline input.

TypeScript will excess-property-error any missed hop — follow the compiler.

- [ ] **Step 4: Record each fix tier's spend, covering exception exits**

In `agent-fix.ts`, spend must be recorded even when a tier dies mid-flight (`raiseSandboxGone`, a thrown gate, an abort): the two `addTokenUsage(totalTokenUsage, agentState.tokenUsage)` sites (~869, ~999) do NOT cover those exits. Wrap each tier's body in `try`/`finally` and record in the `finally`, where `agentState.tokenUsage` still holds this tier's accumulation:

```ts
// per-tier, inside the tier loop:
try {
  // ...existing tier body (agent loop, gates, escalation logic)...
} finally {
  const u = agentState.tokenUsage;
  if (input.usageContext && (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0)) {
    await recordJobUsage({
      jobId: input.usageContext.jobId,
      execution: input.usageContext.execution,
      phase: 'fix',
      model: tier.model,
      usage: { ...agentState.tokenUsage },
      costUsd: calculateCost(agentState.tokenUsage, pricingFor(tier.model)),
    });
  }
}
```

Placement rules for the implementer:
- The `finally` must run **before** the per-tier state reset (`agent-fix.ts:765-768` zeroes `agentState` for the next tier) — i.e. the try wraps one tier's execution, and the reset happens after the finally on the next loop iteration, which is already the current order.
- `recordJobUsage` never throws (Task 2), so the `finally` cannot mask the original exception's type; still, do not add further logic there.
- The existing `addTokenUsage` calls stay where they are — they feed `totalTokenUsage` for spans; the ledger write is independent.
- The zero-usage guard keeps tiers that never made a model call from writing empty rows.
- If both the normal path and the finally could fire for one tier, the unique key `(job, execution, 'fix', tier.model)` collapses them — record ONLY in the finally, nowhere else.

- [ ] **Step 5: Write the wiring test (mocked, no DB)**

`packages/worker/src/__tests__/job-usage-wiring.test.ts` — mock `recordJobUsage` (`vi.mock('../db.js', ...)` following the file-mocking idiom used by the existing unit tests in `__tests__`) and assert:

```ts
// 1. investigation: processing an investigate job calls recordJobUsage once with
//    { phase: 'investigation', jobId: job.id, execution: job.attempts } and a
//    costUsd equal to calculateCost(triage.usage, pricingFor(INVESTIGATION_MODEL)).
// 2. fix tier: driving the agent-fix tier loop with a stubbed agent that throws
//    after consuming tokens still yields exactly one recordJobUsage call with
//    phase 'fix' and that tier's model (the finally-path guarantee).
```

Write both cases with the same stubbing depth the neighboring unit tests use for the investigate processor and the fix loop; if the fix loop is not unit-testable without a sandbox stub, cover case 2 at the smallest function that owns the tier loop.

- [ ] **Step 6: Run the worker suites**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
```

Expected: PASS, including the new wiring tests.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/index.ts packages/worker/src/pipeline.ts packages/worker/src/agent-fix.ts \
        packages/worker/src/harness/agent-loop.ts packages/worker/src/__tests__/job-usage-wiring.test.ts
git commit -m "feat(worker): record investigation and fix-tier spend to job_usage"
```

---

### Task 4: `source_job_id` on fix-job creation (both paths)

**Files:**
- Modify: `packages/worker/src/db.ts` (`updateGroupAndCreateFixJob`, line 1770: the reuse path at ~1827 and the INSERT path at ~1888)
- Modify: `packages/worker/src/index.ts` (both callers, lines 651 and 772)
- Test: extend the suite covering `updateGroupAndCreateFixJob`

**Interfaces:**
- Consumes: column `error_group_jobs.source_job_id` (Task 1).
- Produces: `fields.sourceJobId?: string` on `updateGroupAndCreateFixJob`.

- [ ] **Step 1: Write the failing tests — one per path**

```ts
it('stores the investigate job as source_job_id on a newly created fix job', async () => {
  const result = await updateGroupAndCreateFixJob(groupId, projectId, {
    rootCause: 'x', confidence: 'high', platform: 'javascript',
    sourceJobId: investigateJobId,
  }, job);
  expect(result.created).toBe(true);
  const { rows } = await getPool().query(
    'SELECT source_job_id FROM error_group_jobs WHERE id = $1', [result.fixJobId],
  );
  expect(rows[0].source_job_id).toBe(investigateJobId);
});

it('backfills source_job_id on a reused pending fix job only when it is null', async () => {
  // fixture: an existing pending fix job for the group with source_job_id NULL
  const result = await updateGroupAndCreateFixJob(groupId, projectId, {
    rootCause: 'x', confidence: 'high', platform: 'javascript',
    sourceJobId: investigateJobId,
  }, job);
  expect(result.created).toBe(true); // reuse path also reports created per existing contract — verify against the function's actual return
  const { rows } = await getPool().query(
    'SELECT source_job_id FROM error_group_jobs WHERE id = $1', [result.fixJobId],
  );
  expect(rows[0].source_job_id).toBe(investigateJobId);
  // second investigate run must NOT overwrite the first attribution:
  await updateGroupAndCreateFixJob(groupId, projectId, {
    rootCause: 'x', confidence: 'high', platform: 'javascript',
    sourceJobId: otherInvestigateJobId,
  }, job);
  const again = await getPool().query(
    'SELECT source_job_id FROM error_group_jobs WHERE id = $1', [result.fixJobId],
  );
  expect(again.rows[0].source_job_id).toBe(investigateJobId);
});
```

Before writing, read the reuse path (`db.ts:~1820-1865`) and align the `result.created` expectations with what it actually returns for an existing fix.

- [ ] **Step 2: Run them, verify they fail**

```bash
pnpm --filter @opslane/worker test -- db
```

- [ ] **Step 3: Implement**

Add `sourceJobId?: string` to the `fields` type. On the **INSERT path** (~1888):

```ts
`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by, platform, payload, source_job_id)
 VALUES ($1, $2, 'fix', 'auto', $3, $4::jsonb, $5)
 RETURNING id`,
[ errorGroupId, projectId, fields.platform ?? 'javascript',
  fields.diagnosis === undefined ? null : JSON.stringify({ diagnosis: fields.diagnosis }),
  fields.sourceJobId ?? null ]
```

On the **reuse path** (after the existing-fix SELECT at ~1827 finds a row), preserve first attribution — set only when currently null:

```ts
if (fields.sourceJobId) {
  await client.query(
    `UPDATE error_group_jobs SET source_job_id = $2
     WHERE id = $1 AND source_job_id IS NULL`,
    [existingFix.rows[0].id, fields.sourceJobId],
  );
}
```

In `index.ts`, both callers (651, 772) add `sourceJobId: job.id`.

- [ ] **Step 4: Run, verify pass; commit**

```bash
pnpm --filter @opslane/worker test -- db
git add packages/worker/src/db.ts packages/worker/src/index.ts packages/worker/src/__tests__/
git commit -m "feat(worker): link fix jobs to their investigate job via source_job_id"
```

---

### Task 5: `job_type` on job lifecycle log lines

**Files:**
- Modify: `packages/worker/src/poller.ts` (lines 96, 148, 159)
- Test: extend `packages/worker/src/__tests__/poller.integration.test.ts`

**Interfaces:**
- Consumes: `ClaimedJob.jobType` (`packages/worker/src/db.ts:139`).

- [ ] **Step 1: Add the field to the three log sites**

Do **not** change the `msg` strings — `~/deploy/docs/runbooks/log-queries.md` filters on them verbatim. Add `job_type: job.jobType` to the structured fields of `Claimed job` (96), `Completed job` (148), and `Job failed` (159).

- [ ] **Step 2: Assert the log contract**

In `poller.integration.test.ts`, spy on the logger (import `logger` and `vi.spyOn(logger, 'info')` / `'error'` — match how any existing test in the suite observes logs; if none does, add the spy in a focused new test) and assert all three changed sites: a processed job produced a `Claimed job` and a `Completed job` call, and a failing job produced a `Job failed` call, each whose second argument includes `job_type` equal to the fixture job's type. Without these assertions a dropped field passes silently — and the failure path is exactly the one the runbook queries filter on.

- [ ] **Step 3: Run, verify, commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test -- poller
git add packages/worker/src/poller.ts packages/worker/src/__tests__/poller.integration.test.ts
git commit -m "feat(worker): stamp job_type on job lifecycle log lines"
```

---

### Task 6: Langfuse score client + diagnosis scores after the durable write

**Files:**
- Create: `packages/worker/src/scores.ts`
- Modify: `packages/worker/src/index.ts` (investigate processor outcome branches)
- Test: `packages/worker/src/__tests__/scores.test.ts` (unit, no DB)

**Interfaces:**
- Consumes: `resolveTracingConfig` (`packages/worker/src/tracing-config.ts:62`) — read the file first and align property access with the real `TracingConfig` type (discriminant, `baseUrl`, nested credentials); `getActiveTraceId` (`packages/worker/src/tracing.ts:339`).
- Produces:

```ts
export async function pushScore(input: {
  traceId: string;
  name: string;
  value: string | number;
  dataType: 'CATEGORICAL' | 'NUMERIC' | 'BOOLEAN';
  id?: string;        // Langfuse idempotency key — same id upserts, never duplicates
  comment?: string;
}, deps?: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }): Promise<boolean>
// resolves false (never throws) when tracing is disabled; THROWS on HTTP/network
// failure so callers with retry semantics (score_sync) can rely on the queue —
// callers that want best-effort catch it themselves.
```

- [ ] **Step 1: Write the failing unit test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { pushScore } from '../scores.js';

const ENABLED_ENV = {
  LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_PROJECT_ID: 'proj',
};

describe('pushScore', () => {
  it('POSTs a score with basic auth, id, and a bounded timeout', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const ok = await pushScore(
      { traceId: 't1', name: 'pr_outcome', value: 'merged', dataType: 'CATEGORICAL', id: 'pr-outcome-d1' },
      { env: ENABLED_ENV, fetchImpl },
    );
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://us.cloud.langfuse.com/api/public/scores');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe(
      'Basic ' + Buffer.from('pk-lf-test:sk-lf-test').toString('base64'),
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toMatchObject({
      id: 'pr-outcome-d1', traceId: 't1', name: 'pr_outcome', value: 'merged', dataType: 'CATEGORICAL',
    });
  });

  it('resolves false without calling fetch when tracing is disabled', async () => {
    const fetchImpl = vi.fn();
    const ok = await pushScore(
      { traceId: 't1', name: 'x', value: 'y', dataType: 'CATEGORICAL' },
      { env: {}, fetchImpl },
    );
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response (callers with queues retry; others catch)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(pushScore(
      { traceId: 't1', name: 'x', value: 'y', dataType: 'CATEGORICAL' },
      { env: ENABLED_ENV, fetchImpl },
    )).rejects.toThrow('Langfuse score rejected: 401');
  });
});
```

- [ ] **Step 2: Run it, verify it fails; implement `scores.ts`**

```ts
import { resolveTracingConfig } from './tracing-config.js';

interface ScoreInput {
  traceId: string;
  name: string;
  value: string | number;
  dataType: 'CATEGORICAL' | 'NUMERIC' | 'BOOLEAN';
  id?: string;
  comment?: string;
}

interface ScoreDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

const SCORE_TIMEOUT_MS = 5_000;

/**
 * Push a score onto a Langfuse trace (POST /api/public/scores). Resolves false
 * when tracing is not enabled (no-op); THROWS on HTTP or network failure so a
 * queued caller (score_sync) gets queue retries. Pass `id` for idempotency —
 * Langfuse upserts on id, so a retried job cannot duplicate the score. The
 * request carries a bounded timeout: a stalled push must not hold a job lease.
 */
export async function pushScore(input: ScoreInput, deps: ScoreDeps = {}): Promise<boolean> {
  const config = resolveTracingConfig(deps.env ?? process.env);
  if (config.status !== 'enabled') return false;
  const doFetch = deps.fetchImpl ?? fetch;
  const auth = Buffer.from(
    `${config.credentials.publicKey}:${config.credentials.secretKey}`,
  ).toString('base64');
  const res = await doFetch(`${config.baseUrl}/api/public/scores`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Langfuse score rejected: ${res.status}`);
  }
  return true;
}
```

Align `config.status` / `config.baseUrl` / `config.credentials.*` and the test's env var names with the real `tracing-config.ts` before running.

- [ ] **Step 3: Run, verify pass**

```bash
pnpm --filter @opslane/worker test -- scores
```

- [ ] **Step 4: Push diagnosis scores AFTER the durable outcome write**

A score sent before the outcome commits can outlive a rolled-back decision (lease lost mid-branch → Langfuse scored, Postgres never accepted it). So the push goes after each outcome branch's DB write in the `index.ts` investigate processor — after the `updateGroupInvestigation(...)` / `updateGroupAndCreateFixJob(...)` call in each branch, while the job trace is still active. Add ONE helper call at the end of the branching (all branches converge before the processor returns — place it after the last write, before `lastJobAt` is set):

```ts
const traceId = getActiveTraceId();
if (traceId) {
  try {
    await pushScore({
      traceId, name: 'diagnosis_outcome', value: triage.outcome, dataType: 'CATEGORICAL',
      id: `diagnosis-outcome-${job.id}-${job.attempts}`,
    });
    if (triage.confidence) {
      await pushScore({
        traceId, name: 'diagnosis_confidence', value: triage.confidence, dataType: 'CATEGORICAL',
        id: `diagnosis-confidence-${job.id}-${job.attempts}`,
      });
    }
  } catch (err: unknown) {
    logger.warn('diagnosis score push failed', { job_id: job.id, error: safeErrorMessage(err) });
  }
}
```

Best-effort here (catch, warn) — the investigate job's success must not depend on Langfuse; the deterministic ids make an eventual retry (job re-run) converge instead of duplicate.

- [ ] **Step 5: Build + full worker suite; commit**

```bash
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
git add packages/worker/src/scores.ts packages/worker/src/__tests__/scores.test.ts packages/worker/src/index.ts
git commit -m "feat(worker): Langfuse score client; diagnosis scores pushed after durable write"
```

---

### Task 7: `score_sync` outbox — Go enqueue + worker processor

**Files:**
- Modify: `shared/src/types.ts` (`JobType` union, line 376 — add `'score_sync'`)
- Modify: `packages/ingestion/handler/admin.go` (`adminJobTypes` allowlist, line 14)
- Modify: `packages/dashboard/src/types/api.ts` (`AdminJobType`, ~line 337)
- Modify: `packages/ingestion/db/queries.go` (PR-webhook tx: normal path ~1695, recovered-merge path ~1821)
- Create: `packages/worker/src/score-sync.ts`
- Modify: `packages/worker/src/index.ts` (`processJobInner` dispatch, alongside `route_map` at ~362)
- Test: `packages/ingestion/db/queries_test.go`; `packages/worker/src/__tests__/score-sync.test.ts`

**Interfaces:**
- Consumes: `pushScore` (Task 6); `error_group_jobs.trace_url`; tx locals `groupID`, `projectID`, `fixJobID`, `outcome`, `deliveryID` at both insert sites.
- Produces: jobs with `job_type='score_sync'`, `payload = {"fix_job_id","outcome","delivery_id"}`; `processScoreSyncJob(job: ClaimedJob): Promise<void>`.

- [ ] **Step 1: Widen the type + every allowlist**

1. `shared/src/types.ts:376`: append `| 'score_sync'` to `JobType`.
2. `packages/ingestion/handler/admin.go:14`: add `"score_sync": {}` to `adminJobTypes`.
3. `packages/ingestion/db/admin.go:96`: add `"score_sync": 0` to the zero-filled `ByType` initializer map — the existing admin tests assert every known type appears at zero; extend that assertion to `score_sync` too.
4. `packages/dashboard/src/types/api.ts:~337`: add `'score_sync'` to `AdminJobType`.
5. Rebuild so the worker sees the shared change: `pnpm -r build` (AGENTS.md: after touching shared types, rebuild with dists removed if in doubt).

- [ ] **Step 2: Write the failing Go tests — all webhook paths**

In `queries_test.go`, using the file's existing webhook fixtures (reopened-merge coverage exists at ~line 979 — reuse its helpers):

```go
// TestPRWebhookEnqueuesScoreSync: merged webhook with fix_job_id →
//   exactly one error_group_jobs row with job_type='score_sync', status='pending',
//   payload->>'fix_job_id' = fix job id, payload->>'outcome' = 'merged',
//   payload->>'delivery_id' = delivery id.
// Same function, closed (merged=false) → one row with outcome='closed'.
// Duplicate delivery id → still exactly one score_sync row.
// fixJobID nil (no fix job matched) → zero score_sync rows.
// Recovered reopened-merge path → one score_sync row with outcome='merged'.
```

Write these as real tests against the exported `PRWebhookResult`-returning function; copy fixture setup from the neighboring tests rather than inventing new helpers.

- [ ] **Step 3: Run (fail), implement the Go enqueue**

At **both** sites, immediately after the `ct.RowsAffected() == 0` duplicate early-return, add — only when `fixJobID != nil`:

```go
if fixJobID != nil {
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, payload)
		 VALUES ($1, $2, 'score_sync', jsonb_build_object(
		   'fix_job_id', $3::text, 'outcome', $4::text, 'delivery_id', $5::text,
		   'occurred_at', to_char($6::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
		groupID, projectID, *fixJobID, outcome, deliveryID, occurredAt,
	); err != nil {
		return PRWebhookResult{}, fmt.Errorf("enqueue score_sync: %w", err)
	}
}
```

At the recovered-merge site the outcome literal is `'merged'`. Idempotency: the enqueue shares the tx with the `pr_outcomes` insert, and duplicate deliveries exit early before reaching it. `occurred_at` (the PR event's stable timestamp, already a local at both sites) rides along so a retried score push carries the same event time instead of minting a new one on each attempt.

Run: `cd packages/ingestion && go test ./db/ -run TestPRWebhook -v` → PASS.

- [ ] **Step 4: Write the failing worker test**

`packages/worker/src/__tests__/score-sync.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { syncScoresForPrOutcome } from '../score-sync.js';

describe('syncScoresForPrOutcome', () => {
  it('resolves the fix job trace tenant-scoped and pushes an idempotent categorical score', async () => {
    const loadTraceUrl = vi.fn().mockResolvedValue(
      'https://us.cloud.langfuse.com/project/cm3s8yi1m0005u94purzszfts/traces/abc123',
    );
    const push = vi.fn().mockResolvedValue(true);
    await syncScoresForPrOutcome(
      { fixJobId: 'fj1', projectId: 'p1', outcome: 'merged', deliveryId: 'd1' },
      { loadTraceUrl, push },
    );
    expect(loadTraceUrl).toHaveBeenCalledWith('fj1', 'p1');
    expect(push).toHaveBeenCalledWith({
      traceId: 'abc123', name: 'pr_outcome', value: 'merged',
      dataType: 'CATEGORICAL', id: 'pr-outcome-d1',
    });
  });

  it('throws when the fix job has no trace_url yet (queue retries the race)', async () => {
    const push = vi.fn();
    await expect(syncScoresForPrOutcome(
      { fixJobId: 'fj1', projectId: 'p1', outcome: 'closed', deliveryId: 'd2' },
      { loadTraceUrl: vi.fn().mockResolvedValue(null), push },
    )).rejects.toThrow('no trace_url yet');
    expect(push).not.toHaveBeenCalled();
  });

  it('propagates push failures so the queue retries', async () => {
    const push = vi.fn().mockRejectedValue(new Error('Langfuse score rejected: 503'));
    await expect(syncScoresForPrOutcome(
      { fixJobId: 'fj1', projectId: 'p1', outcome: 'merged', deliveryId: 'd3' },
      {
        loadTraceUrl: vi.fn().mockResolvedValue('https://x/traces/t9'),
        push,
      },
    )).rejects.toThrow('503');
  });
});
```

- [ ] **Step 5: Implement `score-sync.ts`**

```ts
import { getPool } from './db.js';
import { pushScore } from './scores.js';
import { logger } from './logger.js';
import type { ClaimedJob } from './db.js';

interface PrOutcomePayload {
  fixJobId: string;
  projectId: string;
  outcome: 'merged' | 'closed';
  deliveryId: string;
}

interface SyncDeps {
  loadTraceUrl: (fixJobId: string, projectId: string) => Promise<string | null>;
  push: typeof pushScore;
}

/** The trace id is the last path segment of the stored trace_url. */
function traceIdFromUrl(url: string): string | null {
  const last = url.split('/').filter(Boolean).pop();
  return last && last.length > 0 ? last : null;
}

export async function syncScoresForPrOutcome(
  payload: PrOutcomePayload,
  deps: SyncDeps,
): Promise<void> {
  const traceUrl = await deps.loadTraceUrl(payload.fixJobId, payload.projectId);
  const traceId = traceUrl ? traceIdFromUrl(traceUrl) : null;
  if (!traceId) {
    // trace_url is written fire-and-forget by processJobInner, so a score_sync
    // job racing that write (or a transient persistence failure) can observe
    // null even though a trace exists. THROW so the queue's backoff retries;
    // max_attempts dead-letters with this self-describing error if the trace
    // genuinely never existed. Do not treat null as permanent.
    throw new Error(`score_sync: no trace_url yet for fix job ${payload.fixJobId}`);
  }
  // Throws on failure — the queue's retry/backoff/dead-letter machinery is the
  // durability story of this outbox. The deterministic id makes retries upsert.
  await deps.push({
    traceId,
    name: 'pr_outcome',
    value: payload.outcome,
    dataType: 'CATEGORICAL',
    id: `pr-outcome-${payload.deliveryId}`,
  });
}

/** Tenant-scoped per the worker DB contract: id alone is never a sufficient key. */
async function loadTraceUrlFromDb(fixJobId: string, projectId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ trace_url: string | null }>(
    `SELECT trace_url FROM error_group_jobs
     WHERE id = $1 AND project_id = $2 AND job_type IN ('fix', 'error_fix')`,
    [fixJobId, projectId],
  );
  return rows[0]?.trace_url ?? null;
}

export async function processScoreSyncJob(job: ClaimedJob): Promise<void> {
  // Tracing disabled is the ONE permanent no-op: no config means no scores can
  // ever be delivered, and retrying cannot change configuration. Check it
  // explicitly here rather than relying on pushScore's `false` return being
  // silently ignored downstream.
  if (resolveTracingConfig(process.env).status !== 'enabled') {
    logger.info('score_sync: tracing disabled, score not delivered', { job_id: job.id });
    return;
  }
  const payload = (job.payload ?? {}) as {
    fix_job_id?: string; outcome?: string; delivery_id?: string; occurred_at?: string;
  };
  if (
    !payload.fix_job_id || !payload.delivery_id ||
    (payload.outcome !== 'merged' && payload.outcome !== 'closed')
  ) {
    // Malformed payloads are permanent: complete instead of dead-lettering forever.
    logger.warn('score_sync: malformed payload, dropping', { job_id: job.id });
    return;
  }
  await syncScoresForPrOutcome(
    {
      fixJobId: payload.fix_job_id,
      projectId: job.projectId,
      outcome: payload.outcome,
      deliveryId: payload.delivery_id,
    },
    { loadTraceUrl: loadTraceUrlFromDb, push: pushScore },
  );
}
```

Import `resolveTracingConfig` from `./tracing-config.js`. `payload.occurred_at` is carried for score-time determinism: during implementation, check the Langfuse scores API for a supported timestamp field and pass it through if one exists; if the API rejects unknown fields, drop it from the request but keep it in the payload (it costs nothing and a later API version can use it).

Check `ClaimedJob` for the payload field's actual name/type in `db.ts` and adjust the cast.

- [ ] **Step 6: Dispatch in `processJobInner`**

```ts
if (job.jobType === 'score_sync') {
  await processScoreSyncJob(job);
  return;
}
```

Place it with the other early dispatches (~362), **before** the `errorGroupId` requirement check if score_sync jobs always carry `error_group_id` (they do — the enqueue sets it); placement next to `route_map` is fine either way.

- [ ] **Step 7: Run everything; commit**

```bash
pnpm -r build && pnpm --filter @opslane/worker test
cd packages/ingestion && go build ./... && go test ./db/ ./handler/
git add shared/src/types.ts packages/ingestion/handler/admin.go packages/dashboard/src/types/api.ts \
        packages/ingestion/db/queries.go packages/ingestion/db/queries_test.go \
        packages/worker/src/score-sync.ts packages/worker/src/__tests__/score-sync.test.ts \
        packages/worker/src/index.ts
git commit -m "feat: score_sync outbox — PR outcomes pushed to Langfuse as trace scores"
```

---

### Task 8: Admin spend aggregates + dashboard tiles

**Files:**
- Modify: `packages/ingestion/db/admin.go` (`AdminOutcomeOverview` struct line 41; after the PR-outcomes scan ~line 318)
- Modify: `packages/dashboard/src/types/api.ts` (outcomes type ~line 381)
- Modify: `packages/dashboard/src/views/AdminView.vue` (Incident outcomes card ~line 255)
- Test: `packages/ingestion/db/admin_test.go`; `packages/dashboard/src/views/__tests__/admin-view.test.ts`

**Interfaces:**
- Consumes: `job_usage` (Task 1); `Merged7D` scanned in the same function.
- Produces JSON under `outcomes`: `spend_usd_7d: number`, `cost_per_merged_pr_7d: number | null`.

- [ ] **Step 1: Write the failing Go test on a disposable database**

`AdminOverviewData` is intentionally cross-tenant, so a fixture in the shared test DB cannot create a zero-merge scenario and parallel tests contaminate sums. Use the `disposableDB` pattern already in this file (`admin_test.go:~12`: `admin := testPool(t)`, `pool, dsn := disposableDB(t, admin)`, apply `migrationFiles(t)`). Cleanup semantics: rely **solely on dropping the disposable database** — do NOT register `cleanupTenant`-style row deletion, because `job_usage` rows FK-block deleting their jobs and the immutability trigger blocks deleting the usage rows first:

```go
func TestAdminOverviewSpendAggregates(t *testing.T) {
	// disposableDB + migrations, then fixtures: org → project → error_group →
	// one job with two job_usage rows (0.50 + 0.25) inside the 7d window.
	// Scenario A (no merges): AdminOverviewData → SpendUSD7D == 0.75,
	//   CostPerMergedPR7D == nil.
	// Then add a pr_outcomes row outcome='merged' in the window.
	// Scenario B: SpendUSD7D == 0.75, *CostPerMergedPR7D == 0.75.
}
```

Write it fully with the file's real helpers.

- [ ] **Step 2: Run (fail), implement**

Struct (`admin.go:41`):

```go
SpendUSD7D        float64  `json:"spend_usd_7d"`
CostPerMergedPR7D *float64 `json:"cost_per_merged_pr_7d"`
```

In `AdminOverviewData`, after the PR-outcomes scan:

```go
if err := q.pool.QueryRow(ctx, `
	SELECT COALESCE(SUM(cost_usd), 0)::float8
	FROM job_usage
	WHERE created_at >= now() - interval '7 days'`).Scan(&result.Outcomes.SpendUSD7D); err != nil {
	return nil, fmt.Errorf("admin spend aggregate: %w", err)
}
if result.Outcomes.Merged7D > 0 {
	unit := result.Outcomes.SpendUSD7D / float64(result.Outcomes.Merged7D)
	result.Outcomes.CostPerMergedPR7D = &unit
}
```

Run: `cd packages/ingestion && go test ./db/ -run TestAdminOverviewSpendAggregates -v` → PASS.

- [ ] **Step 3: Extend the dashboard type, tiles, and test**

`packages/dashboard/src/types/api.ts` (~381, next to `merged_7d`):

```ts
spend_usd_7d: number;
cost_per_merged_pr_7d: number | null;
```

`AdminView.vue` (Incident outcomes grid, ~255):

```html
<div class="rounded-md bg-surface-subtle p-3">
  <p class="text-xs text-muted">Spend 7d</p>
  <p class="mt-1 text-xl font-semibold tabular-nums">${{ overview.outcomes.spend_usd_7d.toFixed(2) }}</p>
</div>
<div class="rounded-md bg-surface-subtle p-3">
  <p class="text-xs text-muted">Cost / merged PR 7d</p>
  <p class="mt-1 text-xl font-semibold tabular-nums">
    {{ overview.outcomes.cost_per_merged_pr_7d === null ? '—' : '$' + overview.outcomes.cost_per_merged_pr_7d.toFixed(2) }}
  </p>
</div>
```

`admin-view.test.ts` (~50): add `spend_usd_7d: 0, cost_per_merged_pr_7d: null` to the fixture and assert the two tiles render (follow the existing tile assertions), including the `—` placeholder for null.

- [ ] **Step 4: Run, verify, commit**

```bash
pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test
git add packages/ingestion/db/admin.go packages/ingestion/db/admin_test.go \
        packages/dashboard/src/types/api.ts packages/dashboard/src/views/AdminView.vue \
        packages/dashboard/src/views/__tests__/admin-view.test.ts
git commit -m "feat(admin): 7d spend and blended cost-per-merged-PR on the overview"
```

---

### Task 9: Full gate + live smoke

**Files:** none (verification only)

- [ ] **Step 1: Full repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Expected: PASS with `DATABASE_URL` exported (read skip counts, not just pass counts — AGENTS.md; Go storage tests must report zero skips).

- [ ] **Step 2: Pipeline live smoke (required — this plan touches the pipeline)**

Follow AGENTS.md exactly: apply migrations, run `scripts/seed-e2e.sql`, rebuild ingestion and worker images, send an event to `$INGESTION_URL/api/v1/events`, and confirm the job reaches its expected terminal state. Additionally:

```bash
psql "$DATABASE_URL" -c "SELECT job_id, execution, phase, model, cost_usd FROM job_usage ORDER BY created_at DESC LIMIT 10;"
```

Expected: at least one `investigation` row for the smoke job (a fix row only if the smoke reaches the fix phase). From a worktree, re-export the full port/URL block from AGENTS.md as a unit.

- [ ] **Step 3: Commit anything the smoke shook out; otherwise done**

---

## Self-review notes

- Spec coverage: ADR-0001 (ledger, key, triggers, best-effort, source_job_id, blended metric) → Tasks 1-4, 8. CONTEXT.md "Outcome score" → Tasks 6-7. Grill ride-along (`job_type` logs) → Task 5. Deferred by decision, stated explicitly: friction-investigation usage (no usage exposed today), judge/narrative phases, per-project COGS, product analytics, dogfooding.
- Durability split is deliberate: ledger writes best-effort (never fail the job); score_sync pushes throw (queue retries; deterministic score ids make retries upsert). Diagnosis-score pushes at decision time are best-effort with deterministic ids.
- Type consistency: `recordJobUsage`/`UsagePhase`/`TokenUsage` (Task 2) ↔ call sites (Task 3); `pushScore` signature incl. `id` (Task 6) ↔ `score-sync.ts` (Task 7); JSON keys `spend_usd_7d`/`cost_per_merged_pr_7d` ↔ Go tags ↔ TS ↔ Vue (Task 8); `JobType` widened in shared with both allowlists (Task 7).
- Verify-before-coding spots flagged inline: `TracingConfig` property names (Task 6), reuse-path return contract (Task 4), `ClaimedJob.payload` shape (Task 7), logger-spy idiom (Task 5), fixture chain for the migration proof (Task 1).

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | CLEAR (after revisions) | Round 1: 21 findings, 21 addressed. Round 2: 12 findings (1 confirmation of fixes + 11 issues), 11 addressed, 11/11 fixed in plan |

**CODEX:** Round 1 caught wrong call-site anchors (pipeline.ts threading, shared JobType), a real stale-cost bug in readonly-agent's truncated path, the 034 transactional-trigger idiom, test-cleanup deadlock with the immutable ledger, and outbox durability gaps. Round 2 caught the `orgs` table name, missing Sonnet-5 pricing in agent-loop's table, the trace_url fire-and-forget race, and allowlist/init-map completeness. All fixes are folded into the task steps above.

**VERDICT:** CODEX CLEARED after two revision rounds — ready to implement.

NO UNRESOLVED DECISIONS
