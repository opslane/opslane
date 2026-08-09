# Friction Promotion Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop friction buckets from forgetting their own evidence, so a problem that 32 real users hit is adjudicated once with all 32 rather than 45 times with 5.

**Architecture:** Today `countEligibleUsers` counts only `adjudication_status = 'pending'` signals, so every verdict permanently deletes its own evidence and the bucket refills from zero. This plan separates *evidence* (active signals in the window at the current rule version, excluding only `unchecked`) from *verdict*, and adds a per-bucket watermark so re-adjudication is triggered by genuine growth rather than by the pool refilling. It normalizes positional selectors out of the fingerprint so one UI defect is one bucket, records immutable generation-to-signal membership, and attaches that full evidence set to the incident on acceptance so the incident's impact matches what the model was shown.

**Tech Stack:** Node 22, TypeScript (ESM, strict), Vitest, Postgres via `pg`, migrations applied by `scripts/run-migrations.sh`.

## Global Constraints

- Migrations are append-only and idempotent: the runner re-applies every file on every start. Use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Next free number is `041`.
- Apply migrations with `MIGRATION_DIR=packages/ingestion/db/migrations ./scripts/run-migrations.sh`. The runner defaults `MIGRATION_DIR` to `/app/db/migrations`, which does not exist locally.
- Every SQL query touching tenant data filters `project_id` (`packages/ingestion/AGENTS.md`, issue #241).
- Use `unknown` plus narrowing, never `any`.
- Tests colocated in `__tests__`. DB suites gate on `DATABASE_URL` with `const describeDb = DATABASE_URL ? describe : describe.skip;`. Read the skip count, not just the pass count.
- Run Vitest with `pnpm --filter @opslane/worker exec vitest run <path>`. The bare `pnpm --filter @opslane/worker vitest run` form fails with `None of the selected packages has a "vitest" script`.
- Commit subjects are given verbatim in each task. Append the repository's required `Co-Authored-By` trailer to every commit; the task blocks omit it for brevity, they do not waive it.
- `tsc --noEmit` in the worker currently reports pre-existing errors for unbuilt workspace dependencies (`@opslane/sdk/build/debug-id`, `@opslane/agent-core`). Those are not yours. What matters is zero errors under `src/friction/`; run `pnpm -r build` first if you want a clean run.
- Worker DB suites need a freshly migrated database. A reused stack fails on leftover rows, in particular a stale `claimed` session_analysis job consuming a `SESSION_ANALYSIS_MAX_CONCURRENT` slot.
- `projects.github_repo` is `NOT NULL` (`001_baseline.sql:20`). Every test that seeds a project must supply it.
- **`unchecked` signals never count toward threshold** (`dead-letter.ts:14`). This is a terminal-status contract; do not relax it to make a test pass.
- Do not weaken lease contracts. Fix the implementation or the test setup.
- Changing `frictionFingerprint` changes bucket identity, so `RULE_VERSION` must be bumped in the same commit.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/worker/src/friction/fingerprint.ts` (modify) | Selector canonicalization; gains positional-index stripping |
| `packages/worker/src/friction/analyzer.ts` (modify) | `RULE_VERSION`, bumped to 3 |
| `packages/ingestion/db/migrations/041_friction_bucket_state.sql` (create) | Watermark and evidence-membership tables |
| `packages/worker/src/friction/promotion-db.ts` (modify) | Eligibility queries, watermark accessors, evidence membership, generation release |
| `packages/worker/src/friction/promotion.ts` (modify) | Watermark-gated trigger, claim/budget ordering with release-on-failure |
| `packages/worker/src/friction/adjudicator.ts` (modify) | Prompt version 3: acceptance rubric |
| `packages/worker/src/friction/__tests__/tenant-purge.ts` (modify) | Delete new tables before generations |
| `packages/worker/src/friction/__tests__/fingerprint.test.ts` (create) | Selector normalization units |
| `packages/worker/src/friction/__tests__/bucket-evidence.integration.test.ts` (create) | End-to-end proof through `processFrictionOutcomes` |

## Decisions this plan makes (do not re-litigate mid-task)

1. **Evidence excludes `unchecked` only.** `pending`, `accepted`, and `rejected` all count. `unchecked` means the owning job dead-lettered before a verdict and is contractually not evidence.
2. **The watermark expires with the window.** A bucket whose last evaluation is older than the 7-day evidence window is treated as never evaluated. Without this, a bucket evaluated at 100 users whose evidence later decays to 5 would need 150 users forever.
3. **The watermark is scoped by prompt version.** A new prompt version must be able to re-judge a bucket an old prompt already judged.
4. **On acceptance, the incident gets the full evidence set**, not only the rows that happened to be pending. Otherwise the model is shown 32 users and the incident reports 4.
5. **Rule-version-3 fingerprints will not supersede rule-version-2 rows** whose selectors carried positional indices, because supersession matches on fingerprint (`persist.ts:67`). Those old rows are retracted instead, which is correct, and their old-fingerprint candidates are left behind. Cleaning up orphaned v2 candidates is explicitly out of scope and tracked as a follow-up.

---

### Task 1: Normalize positional selectors in the bucket fingerprint

Production shows one unwired form label producing eleven separate buckets because the selector carries `:nth-of-type(n)`. Each fragment then has to independently reach five users. Stripping the index collapses 339 buckets to 238 and raises the largest finding from 33 to 52 distinct users.

**Files:**
- Modify: `packages/worker/src/friction/fingerprint.ts:38-51`
- Modify: `packages/worker/src/friction/analyzer.ts:8`
- Test: `packages/worker/src/friction/__tests__/fingerprint.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `frictionFingerprint(signalType: string, selector: string | null, pageUrl: string): string` — signature unchanged, behavior changes. `RULE_VERSION: number` becomes `3`.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/friction/__tests__/fingerprint.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { frictionFingerprint } from '../fingerprint.js';

describe('frictionFingerprint positional normalization', () => {
  it('collapses nth-of-type variants of the same element into one bucket', () => {
    const a = frictionFingerprint(
      'dead_click',
      'div:nth-of-type(4) > div.field-container.has-label',
      'https://app.example.com/assets',
    );
    const b = frictionFingerprint(
      'dead_click',
      'div:nth-of-type(3) > div.field-container.has-label',
      'https://app.example.com/assets',
    );
    expect(a).toBe(b);
  });

  it('collapses nth-child variants of the same element into one bucket', () => {
    const a = frictionFingerprint('rage_click', 'ul > li:nth-child(2) > button.save', '/x');
    const b = frictionFingerprint('rage_click', 'ul > li:nth-child(9) > button.save', '/x');
    expect(a).toBe(b);
  });

  it('keeps genuinely different elements in different buckets', () => {
    const save = frictionFingerprint('dead_click', 'div:nth-of-type(4) > button.save', '/x');
    const cancel = frictionFingerprint('dead_click', 'div:nth-of-type(4) > button.cancel', '/x');
    expect(save).not.toBe(cancel);
  });

  it('keeps the existing react-select canonicalization', () => {
    const a = frictionFingerprint('dead_click', '#react-select-3-option-1', '/x');
    const b = frictionFingerprint('dead_click', '#react-select-3-option-7', '/x');
    expect(a).toBe(b);
  });

  it('does not alter whitespace inside quoted attribute values', () => {
    const a = frictionFingerprint('dead_click', 'input[placeholder="First  Name"]', '/x');
    const b = frictionFingerprint('dead_click', 'input[placeholder="First Name"]', '/x');
    expect(a).not.toBe(b);
  });

  it('still separates signal types and pages', () => {
    expect(frictionFingerprint('dead_click', 'button.x', '/a'))
      .not.toBe(frictionFingerprint('rage_click', 'button.x', '/a'));
    expect(frictionFingerprint('dead_click', 'button.x', '/a'))
      .not.toBe(frictionFingerprint('dead_click', 'button.x', '/b'));
  });

  it('treats a null selector as an empty selector', () => {
    expect(frictionFingerprint('dead_click', null, '/x'))
      .toBe(frictionFingerprint('dead_click', '', '/x'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/fingerprint.test.ts`

Expected: the two collapse tests FAIL because the raw selector still carries the index. The other five PASS.

- [ ] **Step 3: Write the minimal implementation**

Replace `frictionFingerprint` in `packages/worker/src/friction/fingerprint.ts`. Note there is deliberately **no whitespace collapsing**: it would rewrite the inside of quoted attribute values and merge selectors that target different elements.

```typescript
/** Positional pseudo-classes make the same element at a different DOM index
 * hash to a different bucket, so one UI defect splits into many findings that
 * each have to independently clear the promotion threshold. Strip them. */
function canonicalizeSelector(selector: string | null): string {
  return (selector ?? '')
    .replace(/#react-select-(\d+)-[\w-]+/g, '#react-select-$1')
    .replace(/:nth-of-type\(\s*[^)]*\)/g, '')
    .replace(/:nth-child\(\s*[^)]*\)/g, '')
    .replace(/:nth-last-of-type\(\s*[^)]*\)/g, '')
    .replace(/:nth-last-child\(\s*[^)]*\)/g, '');
}

export function frictionFingerprint(
  signalType: string,
  selector: string | null,
  pageUrl: string,
): string {
  return createHash('sha256')
    .update(`${signalType}|${canonicalizeSelector(selector)}|${pageUrl}`)
    .digest('hex')
    .slice(0, 32);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/fingerprint.test.ts`

Expected: 7 passed.

- [ ] **Step 5: Bump the rule version**

In `packages/worker/src/friction/analyzer.ts:8`:

```typescript
export const RULE_VERSION = 3;
```

- [ ] **Step 6: Run the friction unit suites**

Run: `pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/analyzer.test.ts src/friction/__tests__/persist.test.ts src/friction/__tests__/fingerprint.test.ts`

Expected: all pass. No existing test asserts a literal fingerprint hash, so no fixture updates should be needed. If one fails on a hash literal, update the literal rather than reverting the canonicalization.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/friction/fingerprint.ts packages/worker/src/friction/analyzer.ts packages/worker/src/friction/__tests__/fingerprint.test.ts
git commit -m "fix(friction): collapse positional selector variants into one bucket"
```

---

### Task 2: Add bucket watermark and generation evidence tables

`friction_signals` gives each signal exactly one `generation_id` and one mutable verdict, so a later generation cannot cite an earlier generation's evidence without overwriting its audit trail. This task adds membership plus the watermark Task 4 gates on.

**Files:**
- Create: `packages/ingestion/db/migrations/041_friction_bucket_state.sql`
- Modify: `packages/worker/src/friction/__tests__/tenant-purge.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `friction_bucket_state(project_id, environment_id, fingerprint, rule_version, prompt_version, evaluated_users, evaluated_at, last_generation_id)` keyed on the first five columns; `friction_generation_evidence(generation_id, signal_id, project_id)` keyed on `(generation_id, signal_id)`.

- [ ] **Step 1: Write the migration**

Create `packages/ingestion/db/migrations/041_friction_bucket_state.sql`:

```sql
-- 041_friction_bucket_state.sql — bucket evidence accumulation.
-- Append-only after 040. IDEMPOTENCY IS MANDATORY: the runner re-applies
-- every file on every start.
--
-- Before this migration, threshold counting read only 'pending' signals, so a
-- verdict permanently removed its own evidence and the bucket refilled from
-- zero. Counting all non-unchecked evidence instead needs two things: a
-- watermark, so an unchanged bucket is not re-judged on every session, and
-- membership, so a generation records exactly which signals it was shown.

CREATE TABLE IF NOT EXISTS friction_bucket_state (
  project_id         UUID NOT NULL REFERENCES projects(id),
  environment_id     UUID NOT NULL REFERENCES environments(id),
  fingerprint        TEXT NOT NULL,
  rule_version       INTEGER NOT NULL,
  -- Prompt version is part of the key: a new prompt must be able to re-judge
  -- a bucket that an older prompt already judged.
  prompt_version     INTEGER NOT NULL,
  -- Distinct identified users present the last time this bucket was judged.
  evaluated_users    INTEGER NOT NULL DEFAULT 0,
  -- Readers treat state older than the evidence window as absent, so a bucket
  -- whose evidence decayed cannot be frozen behind a stale high-water mark.
  evaluated_at       TIMESTAMPTZ,
  last_generation_id UUID REFERENCES friction_adjudication_generations(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment_id, fingerprint, rule_version, prompt_version)
);

-- Which signals a generation was actually shown. A signal may be evidence for
-- several generations; friction_signals.generation_id keeps pointing at the
-- generation that produced that signal's own verdict.
CREATE TABLE IF NOT EXISTS friction_generation_evidence (
  generation_id UUID NOT NULL REFERENCES friction_adjudication_generations(id) ON DELETE CASCADE,
  signal_id     UUID NOT NULL REFERENCES friction_signals(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (generation_id, signal_id)
);

CREATE INDEX IF NOT EXISTS idx_friction_generation_evidence_signal
  ON friction_generation_evidence(project_id, signal_id);

-- Evidence counting reads active signals of one rule version regardless of
-- verdict status, which the pre-041 indexes do not serve. INCLUDE carries the
-- payload both the count and list queries need.
CREATE INDEX IF NOT EXISTS idx_friction_signals_bucket_evidence
  ON friction_signals(project_id, environment_id, fingerprint, rule_version, occurred_at)
  INCLUDE (end_user_id, occurrence_count, adjudication_status)
  WHERE retracted_at IS NULL AND superseded_by IS NULL AND end_user_id IS NOT NULL;
```

- [ ] **Step 2: Apply the migration**

Run:

```bash
MIGRATION_DIR=packages/ingestion/db/migrations ./scripts/run-migrations.sh
```

Expected: exits 0.

- [ ] **Step 3: Verify idempotency**

Run the same command again. Expected: exits 0 with no error.

- [ ] **Step 4: Verify the objects and the index plan**

Run:

```bash
psql "$DATABASE_URL" -c "\d friction_bucket_state" -c "\d friction_generation_evidence"
```

Expected: both tables print, with a five-column primary key on `friction_bucket_state`.

**Do not try to validate the index against the dev database.** It holds ~22 signal rows, where a sequential scan is genuinely cheaper, so any correctly built index will still show `Seq Scan`. Also never use `gen_random_uuid()` in the EXPLAIN: it is VOLATILE, so Postgres cannot use it as an index scan key and the leading columns silently drop from `Index Cond` into `Filter`, which reports a wrong answer about the index shape.

To actually verify, build a disposable database, migrate it, seed on the order of 30,000 signals across a few hundred fingerprints, `VACUUM ANALYZE`, and EXPLAIN with **literal** UUIDs. Expect an `Index Only Scan using idx_friction_signals_bucket_evidence` with all five key columns in `Index Cond`, `adjudication_status` served from the INCLUDE payload, and `Heap Fetches: 0`.

Known and acceptable: before the visibility map is set, the planner prefers the pre-existing `idx_friction_signals_aggregation` because the new index is wider and an index-only scan is not yet available. Either way it is an index scan, never a sequential one, at real scale.

- [ ] **Step 5: Update the tenant purge helper**

`packages/worker/src/friction/__tests__/tenant-purge.ts` deletes generations. The new tables reference them, so they must be deleted first or the delete fails. Open the file, find the delete sequence, and add these two statements **before** the `friction_adjudication_generations` delete:

```typescript
  await client.query(`DELETE FROM friction_generation_evidence WHERE project_id = $1`, [projectId]);
  await client.query(`DELETE FROM friction_bucket_state WHERE project_id = $1`, [projectId]);
```

**Read the file before pasting this.** `purgeStaleTenants` is **org**-scoped, not project-scoped: every statement in it uses the `${orgScope}` subquery with `$1 = orgName`. Adapt both deletes to that pattern rather than introducing a `projectId` parameter that does not exist in this function.

`last_generation_id` is `ON DELETE SET NULL` and the evidence FKs cascade, so this ordering is belt-and-braces, but the explicit deletes keep purge deterministic and keep bucket state from surviving its project.

- [ ] **Step 6: Run a suite that uses the purge helper**

Run: `pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/promotion-db.integration.test.ts`

Expected: pass, 0 skipped.

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/db/migrations/041_friction_bucket_state.sql packages/worker/src/friction/__tests__/tenant-purge.ts
git commit -m "feat(friction): add bucket watermark and generation evidence tables"
```

---

### Task 3: Count evidence, not pending rows

**Files:**
- Modify: `packages/worker/src/friction/promotion-db.ts:98-115` (`listEligibleSignals`), `:322-337` (`countEligibleUsers`)
- Modify: `packages/worker/src/friction/__tests__/bucket-promotion.integration.test.ts:188` (an existing test encodes the bug)
- Test: `packages/worker/src/friction/__tests__/promotion-db.integration.test.ts` (modify)

**Interfaces:**
- Consumes: `BucketTuple` (`promotion-db.ts:248`) = `{projectId, environmentId, fingerprint, ruleVersion, promptVersion}`.
- Produces: `countEligibleUsers(client: pg.PoolClient, tuple: Pick<BucketTuple,'projectId'|'environmentId'|'fingerprint'|'ruleVersion'>): Promise<number>` and `listEligibleSignals(client, sameTuplePick): Promise<{ids: string[]; totalOccurrences: number}>` — both gain the `ruleVersion` requirement.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describeDb` block of `packages/worker/src/friction/__tests__/promotion-db.integration.test.ts`. Add `countEligibleUsers` and `listEligibleSignals` to the file's existing import from `../promotion-db.js`:

```typescript
  it('counts adjudicated signals as evidence but never unchecked ones', async () => {
    const fingerprint = 'evidence-fp-1';
    const users = await seedEndUsers(6);
    // Three rejected, two pending: all five are still evidence.
    for (const [index, userId] of users.slice(0, 5).entries()) {
      await insertSignal({
        fingerprint, ruleVersion: 3, endUserId: userId,
        adjudicationStatus: index < 3 ? 'rejected' : 'pending',
      });
    }
    // An unchecked row is contractually not evidence (dead-letter.ts:14).
    await insertSignal({
      fingerprint, ruleVersion: 3, endUserId: users[5]!, adjudicationStatus: 'unchecked',
    });
    // A different rule version must not contribute.
    const [otherVersionUser] = await seedEndUsers(1);
    await insertSignal({
      fingerprint, ruleVersion: 2, endUserId: otherVersionUser!, adjudicationStatus: 'pending',
    });

    const client = await pool.connect();
    try {
      const tuple = { projectId, environmentId, fingerprint, ruleVersion: 3 };
      expect(await countEligibleUsers(client, tuple)).toBe(5);
      expect((await listEligibleSignals(client, tuple)).ids).toHaveLength(5);
    } finally {
      client.release();
    }
  });

  it('excludes retracted and superseded signals from evidence', async () => {
    const fingerprint = 'evidence-fp-2';
    const users = await seedEndUsers(4);
    await insertSignal({ fingerprint, ruleVersion: 3, endUserId: users[0]!, adjudicationStatus: 'pending' });
    await insertSignal({ fingerprint, ruleVersion: 3, endUserId: users[1]!, adjudicationStatus: 'pending', retracted: true });
    await insertSignal({ fingerprint, ruleVersion: 3, endUserId: users[2]!, adjudicationStatus: 'accepted' });

    // A genuinely superseded row: the replacement carries the evidence.
    const replacement = await insertSignal({
      fingerprint, ruleVersion: 3, endUserId: users[3]!, adjudicationStatus: 'pending',
    });
    const superseded = await insertSignal({
      fingerprint, ruleVersion: 3, endUserId: users[3]!, adjudicationStatus: 'pending',
    });
    await pool.query(
      `UPDATE friction_signals SET superseded_by = $1 WHERE id = $2`,
      [replacement, superseded],
    );

    const client = await pool.connect();
    try {
      // users[0] pending, users[2] accepted, users[3] via the replacement row.
      // users[1] retracted and the superseded row are both excluded.
      expect(await countEligibleUsers(client, {
        projectId, environmentId, fingerprint, ruleVersion: 3,
      })).toBe(3);
    } finally {
      client.release();
    }
  });
```

Add these helpers to the same file if not already present:

```typescript
async function seedEndUsers(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO end_users (project_id, external_user_id, first_seen, last_seen)
       VALUES ($1, $2, now(), now()) RETURNING id`,
      [projectId, `evidence-user-${Math.random().toString(36).slice(2)}`],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

async function seedSessionRow(): Promise<string> {
  const id = `evidence-sess-${Math.random().toString(36).slice(2)}`;
  await pool.query(
    `INSERT INTO sessions (id, project_id, environment_id, started_at, status, chunk_count)
     VALUES ($1, $2, $3, now(), 'analyzed', 1)`,
    [id, projectId, environmentId],
  );
  return id;
}

async function insertSignal(opts: {
  fingerprint: string;
  ruleVersion: number;
  endUserId: string | null;
  adjudicationStatus: 'pending' | 'accepted' | 'rejected' | 'unchecked';
  retracted?: boolean;
}): Promise<string> {
  const sessionId = await seedSessionRow();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO friction_signals
       (session_id, project_id, environment_id, end_user_id, rule_version,
        signal_type, fingerprint, element_selector, page_url_normalized,
        occurred_at, occurrence_count, adjudication_status, retracted_at)
     VALUES ($1, $2, $3, $4, $5, 'dead_click', $6, 'button.save', '/x',
             now(), 1, $7, CASE WHEN $8::boolean THEN now() ELSE NULL END)
     RETURNING id`,
    [
      sessionId, projectId, environmentId, opts.endUserId, opts.ruleVersion,
      opts.fingerprint, opts.adjudicationStatus, opts.retracted === true,
    ],
  );
  return rows[0]!.id;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/promotion-db.integration.test.ts -t 'counts adjudicated signals as evidence'
```

Expected: FAIL with `expected 3 to be 5`. Three, not two: the current query counts the two pending v3 rows **plus** the pending v2 row, because there is no rule-version predicate yet.

- [ ] **Step 3: Write the implementation**

In `packages/worker/src/friction/promotion-db.ts`, replace the body of `countEligibleUsers`:

```typescript
export async function countEligibleUsers(
  client: pg.PoolClient,
  tuple: Pick<BucketTuple, 'projectId' | 'environmentId' | 'fingerprint' | 'ruleVersion'>,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT COUNT(DISTINCT end_user_id)::int AS n
     FROM friction_signals
     WHERE project_id = $1 AND environment_id = $2 AND fingerprint = $3
       AND rule_version = $4
       AND end_user_id IS NOT NULL
       AND adjudication_status <> 'unchecked'
       AND retracted_at IS NULL AND superseded_by IS NULL
       AND occurred_at > now() - interval '7 days'`,
    [tuple.projectId, tuple.environmentId, tuple.fingerprint, tuple.ruleVersion],
  );
  return rows[0]!.n;
}
```

The replaced predicate was `adjudication_status = 'pending'`. That is the defect: a verdict must not delete its own evidence. `unchecked` stays excluded because a dead-lettered job's signals are contractually not evidence.

Replace the query inside `listEligibleSignals` with the same predicates:

```typescript
export async function listEligibleSignals(
  client: pg.PoolClient,
  tuple: Pick<BucketTuple, 'projectId' | 'environmentId' | 'fingerprint' | 'ruleVersion'>,
): Promise<{ ids: string[]; totalOccurrences: number }> {
  const { rows } = await client.query<{ id: string; occurrence_count: number }>(
    `SELECT id, occurrence_count
     FROM friction_signals
     WHERE project_id = $1 AND environment_id = $2 AND fingerprint = $3
       AND rule_version = $4
       AND end_user_id IS NOT NULL
       AND adjudication_status <> 'unchecked'
       AND retracted_at IS NULL AND superseded_by IS NULL
       AND occurred_at > now() - interval '7 days'`,
    [tuple.projectId, tuple.environmentId, tuple.fingerprint, tuple.ruleVersion],
  );
  return {
    ids: rows.map((row) => row.id),
    totalOccurrences: rows.reduce((sum, row) => sum + row.occurrence_count, 0),
  };
}
```

**Safety note, already verified against the code:** `claimSignalsForAdjudication` (`promotion-db.ts:32`) keeps `AND adjudication_status = 'pending'` in its UPDATE, and `applyBucketOutcome` (`promotion-db.ts:501`) selects only pending-claimed-by-this-job rows plus same-generation recovery rows. So passing already-adjudicated ids into those functions cannot overwrite historical verdicts or double-attach incidents. Attaching the full evidence set is done deliberately in Task 5.

- [ ] **Step 4: Fix the existing test that encodes the bug**

`packages/worker/src/friction/__tests__/bucket-promotion.integration.test.ts:188` asserts that rejected and unchecked rows are both excluded from the threshold. Half of that is now wrong. Split it:

```typescript
  it('counts rejected signals toward the threshold but not unchecked ones', async () => {
    // Rejected rows remain evidence: a verdict must not delete what it judged.
    // Unchecked rows are excluded by the dead-letter contract (dead-letter.ts:14).
```

Update the body so rejected rows are expected in the count and unchecked rows are not. Do not relax the unchecked assertion.

- [ ] **Step 5: Typecheck and run**

Run:

```bash
pnpm --filter @opslane/worker exec tsc --noEmit
pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/promotion-db.integration.test.ts src/friction/__tests__/bucket-promotion.integration.test.ts
```

Expected: no type errors; all tests pass. The callers at `promotion.ts:166` and `promotion.ts:189` already pass `tuple`, which carries `ruleVersion`, so they type-check unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/friction/promotion-db.ts packages/worker/src/friction/__tests__/promotion-db.integration.test.ts packages/worker/src/friction/__tests__/bucket-promotion.integration.test.ts
git commit -m "fix(friction): count active evidence per rule version, not pending rows"
```

---

### Task 4: Gate re-adjudication on growth, with an expiring watermark

With Task 3 alone, a bucket over threshold would be re-judged on every session that touches it. The watermark makes the trigger "evidence grew materially since we last judged this", and expires so a decayed bucket is not frozen forever.

**Files:**
- Modify: `packages/worker/src/friction/promotion-db.ts` (add three functions)
- Modify: `packages/worker/src/friction/promotion.ts:22-23` and `:166-176`
- Modify: `packages/worker/src/friction/__tests__/promotion.test.ts:16` (mock)

**Interfaces:**
- Consumes: `countEligibleUsers` (Task 3), `BucketTuple`.
- Produces:
  - `readBucketState(client: pg.PoolClient, tuple: BucketTuple): Promise<{evaluatedUsers: number} | null>` — returns `null` when absent **or** when `evaluated_at` is outside the evidence window.
  - `recordBucketEvaluation(client: pg.PoolClient, tuple: BucketTuple, opts: {evaluatedUsers: number; generationId: string | null}): Promise<void>`
  - `recordGenerationEvidence(client: pg.PoolClient, generationId: string, projectId: string, signalIds: string[]): Promise<void>`
  - From `promotion.ts`: `export const PROMOTION_THRESHOLD_USERS = 5`, `export const RE_ADJUDICATION_GROWTH = 1.5`, `export const EVIDENCE_WINDOW_DAYS = 7`.

- [ ] **Step 1: Add the state accessors**

Append to `packages/worker/src/friction/promotion-db.ts`. Note these take the **full** `BucketTuple`, because the watermark key includes `prompt_version`:

```typescript
/** Distinct identified users present the last time this bucket was judged by
 * this rule and prompt version. Returns null when never judged, or when the
 * last judgement is older than the evidence window: a bucket whose evidence
 * decayed must not stay frozen behind a stale high-water mark. */
export async function readBucketState(
  client: pg.PoolClient,
  tuple: BucketTuple,
): Promise<{ evaluatedUsers: number } | null> {
  const { rows } = await client.query<{ evaluated_users: number }>(
    `SELECT evaluated_users
     FROM friction_bucket_state
     WHERE project_id = $1 AND environment_id = $2
       AND fingerprint = $3 AND rule_version = $4 AND prompt_version = $5
       AND evaluated_at IS NOT NULL
       AND evaluated_at > now() - interval '7 days'`,
    [
      tuple.projectId, tuple.environmentId, tuple.fingerprint,
      tuple.ruleVersion, tuple.promptVersion,
    ],
  );
  const row = rows[0];
  return row ? { evaluatedUsers: row.evaluated_users } : null;
}

/** Records that this bucket was judged at a given evidence level. Serialized
 * on the bucket advisory lock so evaluated_users, evaluated_at and
 * last_generation_id always describe the same evaluation. */
export async function recordBucketEvaluation(
  client: pg.PoolClient,
  tuple: BucketTuple,
  opts: { evaluatedUsers: number; generationId: string | null },
): Promise<void> {
  await client.query('BEGIN');
  try {
    const [k1, k2] = tupleLockKey(tuple.projectId, tuple.environmentId, tuple.fingerprint);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);
    await client.query(
      `INSERT INTO friction_bucket_state
         (project_id, environment_id, fingerprint, rule_version, prompt_version,
          evaluated_users, evaluated_at, last_generation_id)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
       ON CONFLICT (project_id, environment_id, fingerprint, rule_version, prompt_version)
       DO UPDATE SET
         evaluated_users = EXCLUDED.evaluated_users,
         evaluated_at = EXCLUDED.evaluated_at,
         last_generation_id = EXCLUDED.last_generation_id,
         updated_at = now()`,
      [
        tuple.projectId, tuple.environmentId, tuple.fingerprint,
        tuple.ruleVersion, tuple.promptVersion,
        opts.evaluatedUsers, opts.generationId,
      ],
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Which signals this generation was shown. Re-running is a no-op. */
export async function recordGenerationEvidence(
  client: pg.PoolClient,
  generationId: string,
  projectId: string,
  signalIds: string[],
): Promise<void> {
  if (signalIds.length === 0) return;
  await client.query(
    `INSERT INTO friction_generation_evidence (generation_id, signal_id, project_id)
     SELECT $1, s.id, $3
     FROM friction_signals s
     WHERE s.id = ANY($2::uuid[]) AND s.project_id = $3
     ON CONFLICT (generation_id, signal_id) DO NOTHING`,
    [generationId, signalIds, projectId],
  );
}
```

The insert joins back to `friction_signals` on `project_id` so a signal id from another tenant cannot be recorded.

`tupleLockKey` already exists in this file (used by `applyBucketOutcome`); no new import is needed.

Last-write-wins replaces `GREATEST` deliberately: under the advisory lock the last writer is the one that actually judged the bucket, and a monotonic maximum is what produces the permanent-freeze failure mode.

- [ ] **Step 2: Change the trigger in promotion.ts**

Replace the constants at `packages/worker/src/friction/promotion.ts:22-23`:

```typescript
export const PROMOTION_THRESHOLD_USERS = 5;
/** Re-judge only when evidence has grown by half again since the last verdict.
 * Without this, a bucket over threshold is re-judged on every session. */
export const RE_ADJUDICATION_GROWTH = 1.5;
export const EVIDENCE_WINDOW_DAYS = 7;
const WINDOW_DAYS = EVIDENCE_WINDOW_DAYS;
```

Add `readBucketState`, `recordBucketEvaluation`, `recordGenerationEvidence` to the existing import block from `./promotion-db.js`.

Replace the threshold check at `promotion.ts:166-176`:

```typescript
    const eligibleUsers = await withClient((c) => countEligibleUsers(c, tuple));
    if (eligibleUsers < PROMOTION_THRESHOLD_USERS) {
      logger.info('Friction candidate below threshold', {
        project_id: signal.project_id,
        session_id: signal.session_id,
        signal_id: signal.id,
        job_id: jobId,
        eligible_users: eligibleUsers,
      });
      continue;
    }

    const state = await withClient((c) => readBucketState(c, tuple));
    if (state && eligibleUsers < Math.ceil(state.evaluatedUsers * RE_ADJUDICATION_GROWTH)) {
      logger.info('Friction bucket judged and not materially grown', {
        project_id: signal.project_id,
        signal_id: signal.id,
        job_id: jobId,
        eligible_users: eligibleUsers,
        evaluated_users: state.evaluatedUsers,
      });
      continue;
    }
```

- [ ] **Step 3: Record membership BEFORE the model call, watermark after the verdict**

Ordering matters and getting it backwards silently breaks Task 5. Membership must exist before `applyBucketOutcome` runs, because Task 5 reads it.

In `promotion.ts`, find the existing `claimSignalsForAdjudication` call for the bucket path (it follows `listEligibleSignals`). Immediately **after** it, add:

```typescript
    await withClient((c) =>
      recordGenerationEvidence(c, generation.id, signal.project_id, eligible.ids));
```

Then, `applyBucketOutcome` is awaited at lines 205-210 and the `Friction bucket adjudicated` log begins at line 211. Insert immediately **before** that log call:

```typescript
    await withClient((c) => recordBucketEvaluation(c, tuple, {
      evaluatedUsers: eligibleUsers,
      generationId: generation.id,
    }));
```

`recordBucketEvaluation` opens its own transaction, so it gets its own client.

**Known race, accepted deliberately.** Between `applyBucketOutcome` terminalizing the generation and the watermark write, a concurrent job can read the old watermark and claim a fresh generation, producing one duplicate model call. It cannot corrupt state: membership is idempotent and the verdict path is advisory-locked. Closing it fully means writing the watermark inside `applyBucketOutcome`'s transaction, which changes that function's contract; that is deliberately out of scope. One occasional duplicate call is a strict improvement on the 68 this plan exists to eliminate.

- [ ] **Step 4: Update the promotion test mock**

`packages/worker/src/friction/__tests__/promotion.test.ts:16` mocks `../promotion-db.js`. Vitest fails on any imported name the mock does not provide. Add all three:

```typescript
  readBucketState: vi.fn(async () => null),
  recordBucketEvaluation: vi.fn(async () => undefined),
  recordGenerationEvidence: vi.fn(async () => undefined),
```

`readBucketState` defaulting to `null` preserves every existing test's meaning: no prior evaluation, so the growth gate does not fire.

- [ ] **Step 5: Typecheck and run**

Run:

```bash
pnpm --filter @opslane/worker exec tsc --noEmit
pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/promotion.test.ts src/friction/__tests__/bucket-promotion.integration.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/friction/promotion-db.ts packages/worker/src/friction/promotion.ts packages/worker/src/friction/__tests__/promotion.test.ts
git commit -m "feat(friction): gate re-adjudication on evidence growth"
```

---

### Task 5: Attach the full evidence set to an accepted incident

`applyBucketOutcome` attaches only rows that were pending and claimed by this job. Once evidence accumulates across verdicts, the model is shown 32 users and the resulting incident reports 4.

**Do not widen the selection inside `applyBucketOutcome`.** Verified against the code: the rows it selects flow into a blanket `UPDATE friction_signals SET adjudication_status, generation_id, adjudicated_at, adjudication_model, adjudication_prompt_version, adjudication_reason` at `promotion-db.ts:536`, and that update runs **before** the `if (!verdict.accepted)` early return at `:555`. Widening the selection would rewrite historical verdicts, and would do it on rejections too. This task adds a separate attachment step instead: it sets `incident_id` only, never verdict fields, and only after acceptance.

**Files:**
- Modify: `packages/worker/src/friction/promotion-db.ts` (add `attachGenerationEvidenceToIncident`)
- Modify: `packages/worker/src/friction/promotion.ts` (call it after an accepting outcome)
- Test: `packages/worker/src/friction/__tests__/bucket-promotion.integration.test.ts` (modify)

**Interfaces:**
- Consumes: `friction_generation_evidence` (Task 2), `recordGenerationEvidence` (Task 4, which now runs before `applyBucketOutcome`), `recomputeIncidentImpact(client, incidentId, projectId)` (existing, `promotion-db.ts:574`).
- Produces: `attachGenerationEvidenceToIncident(generationId: string, projectId: string, incidentId: string, ruleVersion: number): Promise<number>` — returns the number of rows newly attached.

- [ ] **Step 1: Add the attachment function**

Append to `packages/worker/src/friction/promotion-db.ts`:

```typescript
/** Attaches this generation's recorded evidence to the incident it produced.
 * Sets incident_id ONLY: verdict fields, generation_id and the audit columns
 * belong to whichever generation actually judged each signal, and rewriting
 * them would destroy that history. Skips rows already attached anywhere,
 * so a fold-accepted signal keeps its error incident. */
export async function attachGenerationEvidenceToIncident(
  generationId: string,
  projectId: string,
  incidentId: string,
  ruleVersion: number,
): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE friction_signals s
          SET incident_id = $3
        FROM friction_generation_evidence e
       WHERE e.generation_id = $1
         AND e.signal_id = s.id
         AND e.project_id = $2
         AND s.project_id = $2
         AND s.rule_version = $4
         AND s.incident_id IS NULL
         AND s.adjudication_status <> 'unchecked'
         AND s.retracted_at IS NULL AND s.superseded_by IS NULL`,
      [generationId, projectId, incidentId, ruleVersion],
    );
    await recomputeIncidentImpact(client, incidentId, projectId);
    await client.query('COMMIT');
    return res.rowCount ?? 0;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

Check `recomputeIncidentImpact`'s actual signature at `promotion-db.ts:574` before writing this call; if it takes `(client, incidentId)` without `projectId`, match it exactly rather than inventing a parameter.

- [ ] **Step 2: Write the failing test**

Append to `packages/worker/src/friction/__tests__/bucket-promotion.integration.test.ts`. This uses only primitives, since the file has no bucket-seeding helper:

```typescript
  it('attaches previously rejected evidence to the incident on a later acceptance', async () => {
    const fingerprint = 'attach-evidence-fp';
    const incident = await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id, fingerprint, title, first_seen, last_seen, occurrence_count,
          affected_users_count, status, kind, environment_id)
       VALUES ($1, $2, 'Dead click on /x', now(), now(), 0, 0, 'candidate', 'friction', $3)
       RETURNING id`,
      [projectId, `incident-${fingerprint}`, environmentId],
    );
    const incidentId = incident.rows[0]!.id;

    const generation = await pool.query<{ id: string }>(
      `INSERT INTO friction_adjudication_generations
         (project_id, environment_id, fingerprint, rule_version, prompt_version,
          status, window_start, window_end)
       VALUES ($1, $2, $3, 3, 3, 'accepted', now() - interval '7 days', now())
       RETURNING id`,
      [projectId, environmentId, fingerprint],
    );
    const generationId = generation.rows[0]!.id;

    // Three users already rejected in an earlier round, two accepted now.
    const signalIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      signalIds.push(await insertBucketSignal({
        fingerprint,
        adjudicationStatus: i < 3 ? 'rejected' : 'accepted',
      }));
    }
    await pool.query(
      `INSERT INTO friction_generation_evidence (generation_id, signal_id, project_id)
       SELECT $1, unnest($2::uuid[]), $3`,
      [generationId, signalIds, projectId],
    );

    const attached = await attachGenerationEvidenceToIncident(
      generationId, projectId, incidentId, 3,
    );
    expect(attached).toBe(5);

    const { rows } = await pool.query<{ affected_users_count: number }>(
      `SELECT affected_users_count FROM error_groups WHERE id = $1 AND project_id = $2`,
      [incidentId, projectId],
    );
    expect(rows[0]!.affected_users_count).toBe(5);

    // The rejected rows keep their verdict; only incident_id changed.
    const { rows: verdicts } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM friction_signals
       WHERE id = ANY($1::uuid[]) AND adjudication_status = 'rejected'`,
      [signalIds],
    );
    expect(verdicts[0]!.n).toBe(3);
  });
```

Add the helper if the file lacks one (each signal needs its own session and end user so distinct-user counting is meaningful):

```typescript
async function insertBucketSignal(opts: {
  fingerprint: string;
  adjudicationStatus: 'pending' | 'accepted' | 'rejected' | 'unchecked';
}): Promise<string> {
  const suffix = Math.random().toString(36).slice(2);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO end_users (project_id, external_user_id, first_seen, last_seen)
     VALUES ($1, $2, now(), now()) RETURNING id`,
    [projectId, `attach-u-${suffix}`],
  );
  const sessionId = `attach-sess-${suffix}`;
  await pool.query(
    `INSERT INTO sessions (id, project_id, environment_id, started_at, status, chunk_count)
     VALUES ($1, $2, $3, now(), 'analyzed', 1)`,
    [sessionId, projectId, environmentId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO friction_signals
       (session_id, project_id, environment_id, end_user_id, rule_version,
        signal_type, fingerprint, element_selector, page_url_normalized,
        occurred_at, occurrence_count, adjudication_status)
     VALUES ($1, $2, $3, $4, 3, 'dead_click', $5, 'button.save', '/x',
             now(), 1, $6)
     RETURNING id`,
    [sessionId, projectId, environmentId, user.rows[0]!.id, opts.fingerprint,
     opts.adjudicationStatus],
  );
  return rows[0]!.id;
}
```

Import `attachGenerationEvidenceToIncident` from `../promotion-db.js`.

- [ ] **Step 3: Run it**

Run:

```bash
pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/bucket-promotion.integration.test.ts -t 'attaches previously rejected evidence'
```

Expected: FAIL before Step 1's function exists; PASS after. If `attached` comes back `0`, the membership rows were not inserted; check the `unnest` cast.

- [ ] **Step 4: Call it from the accepting path**

In `promotion.ts`, after `applyBucketOutcome` returns and only when the verdict was accepted, add:

```typescript
    if (verdict.accepted && outcome !== 'noop') {
      const incidentId = await withClient(async (c) => {
        const { rows } = await c.query<{ promoted_incident_id: string | null }>(
          `SELECT promoted_incident_id FROM friction_adjudication_generations
           WHERE id = $1 AND project_id = $2`,
          [generation.id, signal.project_id],
        );
        return rows[0]?.promoted_incident_id ?? null;
      });
      if (incidentId) {
        const attached = await attachGenerationEvidenceToIncident(
          generation.id, signal.project_id, incidentId, signal.rule_version,
        );
        logger.info('Attached bucket evidence to incident', {
          project_id: signal.project_id,
          generation_id: generation.id,
          incident_id: incidentId,
          attached,
        });
      }
    }
```

Add `attachGenerationEvidenceToIncident` to the import block. Match the local variable names already in scope (`outcome`, `verdict`, `generation`, `signal`); if `applyBucketOutcome`'s return is not bound to `outcome` in this file, bind it.

- [ ] **Step 5: Run the tests**

Run:

```bash
pnpm --filter @opslane/worker exec tsc --noEmit
pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/bucket-promotion.integration.test.ts src/friction/__tests__/promotion.test.ts
```

Expected: all pass, including the pre-existing impact assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/friction/promotion-db.ts packages/worker/src/friction/promotion.ts packages/worker/src/friction/__tests__/bucket-promotion.integration.test.ts
git commit -m "fix(friction): attach the full evidence set to an accepted incident"
```

---

### Task 6: Claim the generation before reserving budget, and release it on failure

`reserveOrRevisit` runs before `claimGeneration`, so jobs that lose the claim still consume budget. Naively swapping the two leaks a generation: if the claim succeeds and the reservation then fails, the row stays `adjudicating` forever and `uq_friction_generation_inflight` blocks every retry.

**Files:**
- Modify: `packages/worker/src/friction/promotion-db.ts` (add `releaseGeneration`)
- Modify: `packages/worker/src/friction/promotion.ts:178-186`
- Test: `packages/worker/src/friction/__tests__/promotion-db.integration.test.ts` (modify)

**Interfaces:**
- Consumes: `claimGeneration(tuple, claimJobId): Promise<GenerationRow | null>`, `tryReserveAdjudicationCall(client, projectId, dailyCap): Promise<boolean>`.
- Produces: `releaseGeneration(generationId: string, projectId: string, claimJobId: string): Promise<void>` — deletes an `adjudicating` row that never reached a verdict, freeing the in-flight slot. Scoped by all three ids so it can never touch another worker's claim, and guarded on `status = 'adjudicating' AND adjudicated_at IS NULL` so a finished generation survives.

- [ ] **Step 1: Add releaseGeneration**

Append to `packages/worker/src/friction/promotion-db.ts`:

```typescript
/** Frees the in-flight slot held by a generation we claimed but never
 * adjudicated. Deletes rather than terminalizing: 'unchecked' specifically
 * means a job exhausted its retries before a verdict (007 migration), and
 * dead-letter reconciliation only writes a diagnostic for generations it
 * transitions itself, so a budget-released row would sit 'unchecked' forever
 * with no diagnostic. A generation that was never adjudicated has no audit
 * value. Scoped to the claiming job and to rows with no verdict, so it can
 * never delete another worker's in-flight claim or a finished generation. */
export async function releaseGeneration(
  generationId: string,
  projectId: string,
  claimJobId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM friction_adjudication_generations
      WHERE id = $1 AND project_id = $2 AND claim_job_id = $3
        AND status = 'adjudicating' AND adjudicated_at IS NULL`,
    [generationId, projectId, claimJobId],
  );
}
```

`friction_generation_evidence.generation_id` is `ON DELETE CASCADE` and `friction_bucket_state.last_generation_id` is `ON DELETE SET NULL`, so this delete cannot orphan either table. `friction_signals.generation_id` has no cascade, but no signal can reference this generation yet: the release happens before `claimSignalsForAdjudication`.

- [ ] **Step 2: Write the failing test**

Append to `packages/worker/src/friction/__tests__/promotion-db.integration.test.ts`, adding `claimGeneration` and `releaseGeneration` to the file's imports:

```typescript
  it('releasing a claimed generation frees the in-flight slot', async () => {
    // claim_job_id is a foreign key, so this must be a real job row.
    const job = await pool.query<{ id: string }>(
      `INSERT INTO error_group_jobs (project_id, job_type, status)
       VALUES ($1, 'session_analysis', 'claimed') RETURNING id`,
      [projectId],
    );
    const releaseJobId = job.rows[0]!.id;
    const tuple = {
      projectId, environmentId,
      fingerprint: 'release-fp',
      ruleVersion: 3,
      promptVersion: 3,
    };
    const first = await claimGeneration(tuple, releaseJobId);
    expect(first).not.toBeNull();

    // The in-flight partial unique index blocks a second claim.
    expect(await claimGeneration(tuple, releaseJobId)).toBeNull();

    await releaseGeneration(first!.id, projectId, releaseJobId);

    // After release, a later job can claim again.
    const third = await claimGeneration(tuple, releaseJobId);
    expect(third).not.toBeNull();
    expect(third!.id).not.toBe(first!.id);

    // A finished generation is never deleted by release.
    await pool.query(
      `UPDATE friction_adjudication_generations
          SET status = 'rejected', adjudicated_at = now() WHERE id = $1`,
      [third!.id],
    );
    await releaseGeneration(third!.id, projectId, releaseJobId);
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM friction_adjudication_generations WHERE id = $1`,
      [third!.id],
    );
    expect(rows[0]!.n).toBe(1);
  });
```

- [ ] **Step 3: Run it**

Run:

```bash
pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/promotion-db.integration.test.ts -t 'frees the in-flight slot'
```

Expected: PASS once `releaseGeneration` exists. This test pins the primitive the ordering fix depends on.

- [ ] **Step 4: Reorder with release-on-failure**

Replace `promotion.ts:178-186`:

```typescript
    // Threshold crossed: claim the durable generation; losers skip the call.
    if (!await reserveOrRevisit(session, signal, jobId, runtime)) break;
    const generation = await claimGeneration(tuple, jobId);
    if (!generation) {
      logger.info('Friction generation already in flight, skipping', {
        project_id: signal.project_id,
        signal_id: signal.id,
        job_id: jobId,
      });
      continue;
    }
```

with:

```typescript
    // Claim first, so a job that loses the claim never consumes a model call
    // from the daily budget. If the budget is then exhausted, the claim must
    // be released: a generation left 'adjudicating' would block every retry
    // through uq_friction_generation_inflight.
    const generation = await claimGeneration(tuple, jobId);
    if (!generation) {
      logger.info('Friction generation already in flight, skipping', {
        project_id: signal.project_id,
        signal_id: signal.id,
        job_id: jobId,
      });
      continue;
    }
    if (!await reserveOrRevisit(session, signal, jobId, runtime)) {
      await releaseGeneration(generation.id, signal.project_id, jobId);
      logger.info('Released generation: adjudication budget exhausted', {
        project_id: signal.project_id,
        signal_id: signal.id,
        job_id: jobId,
        generation_id: generation.id,
      });
      break;
    }
```

Add `releaseGeneration` to the import block from `./promotion-db.js`.

- [ ] **Step 5: Add releaseGeneration to the promotion mock**

`packages/worker/src/friction/__tests__/promotion.test.ts:16` mocks `../promotion-db.js`. Add:

```typescript
  releaseGeneration: vi.fn(async () => undefined),
```

Also confirm `attachGenerationEvidenceToIncident` from Task 5 is in that mock:

```typescript
  attachGenerationEvidenceToIncident: vi.fn(async () => 0),
```

Vitest fails on any imported name the mock omits, so a missing entry surfaces as a confusing module error rather than a test failure.

- [ ] **Step 6: Typecheck and run the friction suites**

Run:

```bash
pnpm --filter @opslane/worker exec tsc --noEmit
pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/friction/promotion-db.ts packages/worker/src/friction/promotion.ts packages/worker/src/friction/__tests__/promotion-db.integration.test.ts packages/worker/src/friction/__tests__/promotion.test.ts
git commit -m "fix(friction): claim before budget, releasing the claim when budget is out"
```

---

### Task 7: Tell the adjudicator what the threshold already means

The dominant production rejection reason is "Only 5 occurrences across 5 distinct users in 7 days is too low-volume" — the model setting its own volume bar above ours because the prompt never states ours.

**Files:**
- Modify: `packages/worker/src/friction/adjudicator.ts:6-72`
- Test: `packages/worker/src/friction/__tests__/adjudicator.test.ts` (modify)

**Interfaces:**
- Consumes: `AdjudicationInput` (`adjudicator.ts:12`).
- Produces: `ADJUDICATION_PROMPT_VERSION = 3`, `ADJUDICATION_PROMPT_VERSION_WINDOWS = 4`. `buildAdjudicationPrompt` signature unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/worker/src/friction/__tests__/adjudicator.test.ts`:

```typescript
describe('bucket prompt rubric', () => {
  const input = {
    scope: 'bucket' as const,
    signalType: 'dead_click' as const,
    elementSelector: 'button.save',
    pageUrlNormalized: '/settings',
    occurrenceCount: 47,
    bucketSummary: { distinctUsers: 19, totalOccurrences: 47, windowDays: 7 },
  };

  it('states that the volume threshold is already cleared', () => {
    const prompt = buildAdjudicationPrompt(input);
    expect(prompt).toMatch(/already .*(cleared|met)/i);
    expect(prompt).toContain('5 distinct users');
  });

  it('forbids rejecting on volume alone', () => {
    const prompt = buildAdjudicationPrompt(input);
    expect(prompt).toMatch(/not a valid reason to reject/i);
  });

  it('still fences the untrusted evidence', () => {
    const prompt = buildAdjudicationPrompt(input);
    expect(prompt).toContain('<untrusted-evidence>');
    expect(prompt).toContain('</untrusted-evidence>');
  });

  it('omits the rubric for fold scope', () => {
    const foldPrompt = buildAdjudicationPrompt({
      scope: 'fold' as const,
      signalType: 'dead_click' as const,
      elementSelector: 'button.save',
      pageUrlNormalized: '/settings',
      occurrenceCount: 1,
      nearbyError: { title: 'TypeError: x', secondsAway: 3 },
    });
    expect(foldPrompt).not.toMatch(/not a valid reason to reject/i);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/adjudicator.test.ts -t 'bucket prompt rubric'`

Expected: the first two FAIL, the last two PASS.

- [ ] **Step 3: Implement**

In `packages/worker/src/friction/adjudicator.ts`, bump both versions:

```typescript
export const ADJUDICATION_PROMPT_VERSION = 3;
export const ADJUDICATION_PROMPT_VERSION_WINDOWS = 4;
```

In `buildAdjudicationPrompt`, after the `</untrusted-evidence>` push and before the `if (input.evidenceWindows)` branch, add:

```typescript
  if (input.bucketSummary) {
    instructions.push(
      'This detection has ALREADY cleared the product significance bar: a bucket',
      'is only sent to you once at least 5 distinct users have hit it inside the',
      'window. Volume is therefore not a valid reason to reject. Judge only',
      'whether the DETECTOR is right: does this interaction pattern describe a',
      'real user-facing problem, or is it an artifact (an intentional repeat',
      'click, a non-interactive element a user idly clicked, a control that',
      'legitimately does nothing on that page)?',
    );
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/adjudicator.test.ts`

Expected: all pass. Update any existing assertion that pins `promptVersion` to `1` or `2`; a prompt version bump invalidating prior verdicts is the intended contract.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/friction/adjudicator.ts packages/worker/src/friction/__tests__/adjudicator.test.ts
git commit -m "feat(friction): state the cleared volume bar in the bucket prompt"
```

---

### Task 8: Prove the behavior end to end through processFrictionOutcomes

This is the test that would have caught the production defect. It drives the real orchestration function with a stub adjudicator and counts model calls.

**Files:**
- Create: `packages/worker/src/friction/__tests__/bucket-evidence.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 through 7, plus `processFrictionOutcomes(session, jobId, adjudicator, runtime)` from `promotion.ts:60`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the test**

Create `packages/worker/src/friction/__tests__/bucket-evidence.integration.test.ts`. Note the project insert supplies `github_repo`, which is `NOT NULL`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../db.js';
import { processFrictionOutcomes } from '../promotion.js';
import type { Adjudicator, AdjudicationInput, AdjudicationVerdict } from '../adjudicator.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('bucket evidence accumulation end to end', () => {
  let pool: pg.Pool;
  let projectId: string;
  let environmentId: string;
  const fingerprint = 'accumulate-fp';

  const calls: AdjudicationInput[] = [];
  function stubAdjudicator(accepted: boolean): Adjudicator {
    return {
      modelId: 'stub-model',
      promptVersion: 3,
      async adjudicate(input: AdjudicationInput): Promise<AdjudicationVerdict> {
        calls.push(input);
        return { accepted, reason: accepted ? 'stub accept' : 'stub reject' };
      },
    };
  }

  const runtime = {
    windowMode: 'off' as const,
    dailyCap: 500,
    loadWindows: async () => [],
  };

  beforeAll(async () => {
    pool = getPool();
    const org = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ('bucket-evidence-test') RETURNING id`,
    );
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo)
       VALUES ($1, 'bucket-evidence', 'acme/bucket-evidence') RETURNING id`,
      [org.rows[0]!.id],
    );
    projectId = project.rows[0]!.id;
    const env = await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
      [projectId],
    );
    environmentId = env.rows[0]!.id;
  });

  /** Full teardown. Leaving session_analysis jobs in 'claimed' consumes
   * fleet-wide SESSION_ANALYSIS_MAX_CONCURRENT slots and poisons later
   * suites; leaking sessions and end_users skews other tests' counts. */
  async function purge(): Promise<void> {
    await pool.query(`DELETE FROM friction_generation_evidence WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM friction_bucket_state WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM friction_signals WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM friction_adjudication_generations WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM error_groups WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM sessions WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM end_users WHERE project_id = $1`, [projectId]);
  }

  afterAll(async () => {
    await purge();
    await pool.query(`DELETE FROM environments WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await closePool();
  });

  beforeEach(async () => {
    calls.length = 0;
    await purge();
  });

  /** Seeds one session with one identified user and one pending signal,
   * then runs the real promotion path over that session. */
  async function addUserSessionAndProcess(): Promise<void> {
    const suffix = Math.random().toString(36).slice(2);
    const user = await pool.query<{ id: string }>(
      `INSERT INTO end_users (project_id, external_user_id, first_seen, last_seen)
       VALUES ($1, $2, now(), now()) RETURNING id`,
      [projectId, `u-${suffix}`],
    );
    const sessionId = `sess-${suffix}`;
    await pool.query(
      `INSERT INTO sessions (id, project_id, environment_id, started_at, status, chunk_count)
       VALUES ($1, $2, $3, now(), 'analyzed', 1)`,
      [sessionId, projectId, environmentId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO error_group_jobs (project_id, job_type, session_id, status)
       VALUES ($1, 'session_analysis', $2, 'claimed') RETURNING id`,
      [projectId, sessionId],
    );
    await pool.query(
      `INSERT INTO friction_signals
         (session_id, project_id, environment_id, end_user_id, rule_version,
          signal_type, fingerprint, element_selector, page_url_normalized,
          occurred_at, occurrence_count, adjudication_status)
       VALUES ($1, $2, $3, $4, 3, 'dead_click', $5, 'button.save', '/x',
               now(), 1, 'pending')`,
      [sessionId, projectId, environmentId, user.rows[0]!.id, fingerprint],
    );
    const session = await pool.query(
      `SELECT * FROM sessions WHERE id = $1 AND project_id = $2`, [sessionId, projectId],
    );
    await processFrictionOutcomes(
      session.rows[0] as never,
      job.rows[0]!.id,
      stubAdjudicator(false),
      runtime,
    );
  }

  it('adjudicates once at the threshold, not once per session after it', async () => {
    for (let i = 0; i < 9; i++) await addUserSessionAndProcess();
    // Five users trigger one call. Users 6 to 9 are growth below 1.5x of 5
    // (ceil = 8) until the eighth, which triggers exactly one more.
    expect(calls.length).toBe(2);
  });

  it('records the evidence it was shown', async () => {
    for (let i = 0; i < 5; i++) await addUserSessionAndProcess();
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM friction_generation_evidence WHERE project_id = $1`,
      [projectId],
    );
    expect(rows[0]!.n).toBe(5);
  });

  it('writes a watermark at the evidence level it judged', async () => {
    for (let i = 0; i < 5; i++) await addUserSessionAndProcess();
    const { rows } = await pool.query<{ evaluated_users: number; prompt_version: number }>(
      `SELECT evaluated_users, prompt_version FROM friction_bucket_state
       WHERE project_id = $1 AND fingerprint = $2`,
      [projectId, fingerprint],
    );
    expect(rows[0]!.evaluated_users).toBe(5);
    expect(rows[0]!.prompt_version).toBe(3);
  });

  it('still counts users whose signals were rejected', async () => {
    for (let i = 0; i < 5; i++) await addUserSessionAndProcess();
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(DISTINCT end_user_id)::int AS n FROM friction_signals
       WHERE project_id = $1 AND fingerprint = $2 AND adjudication_status = 'rejected'`,
      [projectId, fingerprint],
    );
    // This is the production defect: these five stopped counting entirely.
    expect(rows[0]!.n).toBeGreaterThan(0);
    const second = await pool.connect();
    try {
      const { rows: ev } = await second.query<{ n: number }>(
        `SELECT COUNT(DISTINCT end_user_id)::int AS n FROM friction_signals
         WHERE project_id = $1 AND fingerprint = $2
           AND adjudication_status <> 'unchecked'
           AND retracted_at IS NULL AND superseded_by IS NULL`,
        [projectId, fingerprint],
      );
      expect(ev[0]!.n).toBe(5);
    } finally {
      second.release();
    }
  });
});
```

- [ ] **Step 2: Run it against a fresh database**

Run:

```bash
pnpm --filter @opslane/worker exec vitest run src/friction/__tests__/bucket-evidence.integration.test.ts
```

Expected: 4 passed, 0 skipped. A skip means `DATABASE_URL` is unset and the test proved nothing.

If the first test's call count differs, do not change the assertion to match the code until you have worked out which call was correct. The intended sequence is: one call when the fifth user arrives, and one more when the eighth arrives (`ceil(5 * 1.5) = 8`).

- [ ] **Step 3: Run the full worker suite**

Run: `pnpm --filter @opslane/worker exec vitest run`

Expected: pass. Read the skip count.

- [ ] **Step 4: Run the repository gate**

Run:

```bash
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go vet ./... && go test ./...)
docker compose config --quiet
```

Expected: all pass; `go test` reports zero skips. `pnpm test` marks DB-gated suites *skipped* when `DATABASE_URL` is unset, so read the skip count rather than the pass count.

- [ ] **Step 5: Run the live smoke — required, not optional**

This changes the pipeline, so `AGENTS.md` requires a live seeded smoke and the repository gate does not substitute for it. From a worktree, export the full port/URL block as a unit (see `AGENTS.md`), then:

```bash
MIGRATION_DIR=packages/ingestion/db/migrations ./scripts/run-migrations.sh
psql "$DATABASE_URL" -f scripts/seed-e2e.sql
docker compose up -d --build ingestion worker
curl -sS -X POST "$INGESTION_URL/api/v1/events" -H 'Content-Type: application/json' \
  -H "X-API-Key: $OPSLANE_INGEST_KEY" --data @test-fixtures/wire/<a frozen fixture>.json
```

Then drive a friction session through `test-fixtures/vue-app` and confirm in the database:

```sql
SELECT status, count(*) FROM error_group_jobs
 WHERE job_type = 'session_analysis' GROUP BY status;
SELECT evaluated_users, prompt_version FROM friction_bucket_state;
SELECT count(*) FROM friction_generation_evidence;
```

Expected: jobs reach `completed`, a `friction_bucket_state` row exists at prompt version 3, and evidence rows equal the number of eligible signals. Record the actual output in the PR body.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/friction/__tests__/bucket-evidence.integration.test.ts
git commit -m "test(friction): prove buckets accumulate evidence across verdicts"
```

---

## Self-Review

**Spec coverage.** Diagnosis items 2 (accumulate evidence, version scoping, immutable membership, watermark, budget ordering), 2b (selector normalization), and the item-4 prompt rubric are covered by Tasks 1 through 8. Out of scope, each needing its own plan: the labeled evaluation corpus, request-fact fixture validation, bucket-scope error evidence, the backfill, rule-version-1 retirement, the sessions list, the digest.

**Known gaps carried forward, deliberately not in this plan:**
- Renewal and revocation semantics for an accepted generation whose evidence later disappears. Today an accepted generation is inherited until `valid_until` regardless, and that inheritance path (`promotion.ts:143`) short-circuits before the growth gate, so the growth rule applies only to rejected and expired buckets. That is the intended scope.
- Lease-aware recovery of a generation wedged by a worker that died between claim and verdict. Task 6 fixes the budget path only; a crash still relies on dead-letter reconciliation.
- Orphaned rule-version-2 candidates whose fingerprints changed under Task 1.
- Cohort turnover: a bucket whose five users are entirely replaced by five different users inside the window does not re-adjudicate, because the gate compares cardinality rather than membership. `friction_generation_evidence` makes a membership-diff version possible later; expiry bounds the effect to seven days.
- The narrow duplicate-call race documented in Task 4, Step 3.
- `friction_generation_evidence.project_id` is not constrained to agree with its generation's project. The insert in `recordGenerationEvidence` joins on the signal's `project_id`, which is the path that matters; a composite FK would be stronger.
- Non-test tenant/project deletion paths must be checked for the two new tables before this ships. Task 2 updates only the test purge helper.

**Type consistency.** `BucketTuple` keeps all five fields. `countEligibleUsers` and `listEligibleSignals` take the four-field pick including `ruleVersion`; `readBucketState` and `recordBucketEvaluation` take the full `BucketTuple` because the watermark key includes `promptVersion`. `readBucketState` returns `{evaluatedUsers}` and is read as `state.evaluatedUsers` in Task 4. `releaseGeneration(generationId, projectId)` is used in Task 6 with `generation.id` and `signal.project_id`.
