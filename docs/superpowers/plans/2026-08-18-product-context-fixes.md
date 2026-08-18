# Product-context fixes (Slice 6 verification follow-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the product-context pipeline runnable against the real Anthropic API and close the verified gaps: conflict reporting, run observability, the connect trigger, and honest request provenance.

**Architecture:** Six decisions (D1–D6) agreed after black-box verification (`.verify/runs/20260818-152726/report.md`) and codex consults. One worker-side schema fix unblocks everything (D1); one migration adds the route_map quality columns and a runs table (D2/D5/D6 DDL); the worker write path carries conflicts, review status, declared requests, and a transactional run record; Go gains a connect-time enqueue that fires only on an actual repo transition; an offline forbidden-keyword scan plus a live contract test prevent the D1 bug class from shipping again.

**Tech Stack:** TypeScript (Node 22, worker, Vitest colocated in `__tests__`), Go 1.24 + pgx (ingestion), Postgres migrations in `packages/ingestion/db/migrations/`.

**Spec:** `docs/superpowers/specs/2026-08-16-pipeline-implementation-plan.md` lines 355–406 (Slice 6) and `docs/superpowers/specs/2026-08-15-pipeline-architecture-design.md` lines 233–254, as amended by the D1–D6 decisions summarized below.

## Global constraints

- AGPL-3.0-only worker and ingestion code; no new dependencies.
- Strict TypeScript, ESM, `unknown` + narrowing; tests colocated in `__tests__`.
- Do not weaken terminal-status or lease contracts. `upsertProductContextClaims` keeps its lease-fenced transaction shape; new writes join that transaction rather than bypassing it.
- Worker unit tests mock `pg` (`db-queries.test.ts` pattern). Worker **integration** tests are separate `*.integration.test.ts` files gated by `const describeDb = DATABASE_URL ? describe : describe.skip` and seed via raw SQL (`environment-context.integration.test.ts` is the model). Never put pool-backed tests in the mocked file.
- Go DB tests live in package `db_test`, use `testPool(t)` / `db.New(pool)` / `cleanupTenant` from `testhelper_test.go`, and **skip** when Postgres is unreachable — confirm they ran.
- Migrations are applied by the compose `migrate` service on stack start; tests assert against an already-migrated database. Migration number for this plan: `056` (last existing: 055).
- `job_usage.phase` is TEXT with only a non-empty CHECK (migration 043 verified) — no DDL needed to add a phase value. `job_usage.job_id` REFERENCES `error_group_jobs(id)`; any test writing usage must seed a real job row.
- The `POST /api/v1/events` wire contract is untouched.
- `route_map.observed_requests` stays reserved for session-derived evidence (Slice 5). Nothing in this plan writes anything but `'{}'` to it.

## Decision summary the tasks implement

- **D1**: strict tools must not use `minimum`/`maximum` on numbers (Anthropic 400s them — verified live). Express the 0–1 range in the description; `parseRouteClaims` already enforces it at runtime. Guard the whole class: offline keyword scan (mandatory) + live contract test (gated).
- **D2**: claims carry a **required** `evidence_conflicts: string[]` (empty when reconciled). Non-empty conflicts cap confidence at 0.5 and set `route_map.review_status = 'needs_review'`; a later clean refresh clears both.
- **D3**: no bridge for the missing session-observed routes; document dormancy (merge into existing comments + worker AGENTS bullet).
- **D4**: enqueue `product_context` when a project **transitions** to a usable `github_repo` (create-with-repo, or settings change to a different/first repo). Re-saving the same repo does not re-enqueue.
- **D5**: persist one run record per model pass in `product_context_runs`, written **inside the lease-fenced claims transaction** (so a completed run always has its record); bill tokens/cost best-effort into `job_usage` with phase `product_context`. Definitions: `coverage` = (route_count − unknown_count) / route_count (0 when route_count is 0); **unknown** = claim with `confidence === 0`; `conflict_count` = number of routes whose `evidence_conflicts` is non-empty; `human_route_count` = human-owned `route_map` rows whose pattern is in the run's discovery set (`prepared.routes` — verified to include human-owned repository routes). Jobs that discover zero routes return early and record nothing; that narrowing is deliberate.
- **D6**: code-derived requests are "requests the code could make". Rename the discovery field `observedRequests` → `declaredRequests` end-to-end (including the prompt the model sees) and persist to `route_map.declared_requests`.

## File structure

- `packages/worker/src/product-context/schema.ts` — D1 fix, D2 claim field + validation (modify)
- `packages/worker/src/product-context/job.ts` — D6 rename, cap rule, run metrics, prompt sentence (modify)
- `packages/worker/src/db.ts` — final write-path signature, `UsagePhase`, dormancy comment merge (modify)
- `packages/worker/src/friction/investigate-friction.ts` — export `CLASSIFY_TOOL` (modify)
- `packages/worker/src/__tests__/product-context.test.ts` — unit tests (modify)
- `packages/worker/src/__tests__/strict-tool-schemas.test.ts` — offline keyword scan, always runs (create)
- `packages/worker/src/__tests__/product-context.integration.test.ts` — DB-gated write-path tests (create)
- `packages/worker/src/__tests__/tool-contracts.live.test.ts` — live API contract test, key-gated (create)
- `packages/ingestion/db/migrations/056_product_context_quality.sql` — DDL (create)
- `packages/ingestion/db/migration_056_test.go` — DDL assertions (create)
- `packages/ingestion/db/queries_connect_test.go` — connect-trigger tests (create)
- `packages/ingestion/db/queries.go` — transition-aware connect enqueue (modify)
- `packages/ingestion/priority/sweeper.go` — dormancy comment (modify)
- `packages/worker/AGENTS.md` — dormancy bullet (modify)

---

### Task 1: Fix the confidence schema and add the offline strict-schema scan (D1)

The Anthropic API rejects `minimum`/`maximum` on `type: 'number'` inside a `strict: true` tool with `400 invalid_request_error` (verified live: "tools.3.custom: For 'number' type, properties maximum, minimum are not supported"). Every real `product_context` and `route_map` job currently dead-letters on this. `minItems`/`maxItems` on arrays are accepted (diagnosis runs in production with them) — scan only for the number keywords.

**Files:**
- Modify: `packages/worker/src/product-context/schema.ts:40`
- Modify: `packages/worker/src/friction/investigate-friction.ts:63` (`const CLASSIFY_TOOL` → `export const CLASSIFY_TOOL`)
- Create: `packages/worker/src/__tests__/strict-tool-schemas.test.ts`

**Interfaces:**
- Consumes: `routeClaimsTerminalTool()` (`product-context/schema.ts`), `routeMapTerminalTool()` (`route-map.ts:26`), `submitDiagnosisTool()` (`diagnose-schema.ts:178`), `CLASSIFY_TOOL` (`friction/investigate-friction.ts`).
- Produces: a schema with no `minimum`/`maximum`; an always-on scan Task 6's live test complements.

- [ ] **Step 1: Export the friction tool**

In `packages/worker/src/friction/investigate-friction.ts`, change `const CLASSIFY_TOOL: Anthropic.Tool = {` to `export const CLASSIFY_TOOL: Anthropic.Tool = {`. No other change.

- [ ] **Step 2: Write the failing scan test**

Create `packages/worker/src/__tests__/strict-tool-schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { routeClaimsTerminalTool } from '../product-context/schema.js';
import { routeMapTerminalTool } from '../route-map.js';
import { submitDiagnosisTool } from '../diagnose-schema.js';
import { CLASSIFY_TOOL } from '../friction/investigate-friction.js';

// Anthropic strict tools reject minimum/maximum on numbers at request time
// with invalid_request_error, which dead-letters every job using the tool
// while stub-based tests stay green (Slice 6 verification, AC5/AC11).
// This scan is the offline half of the guard; tool-contracts.live.test.ts is
// the live half. New strict tools must be added to STRICT_TOOLS in both.
const STRICT_TOOLS: Anthropic.Tool[] = [
  routeClaimsTerminalTool(),
  routeMapTerminalTool(),
  submitDiagnosisTool(),
  CLASSIFY_TOOL,
];

function collectKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((v) => collectKeys(v, found)); return; }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) { found.add(k); collectKeys(v, found); }
  }
}

describe('strict tool schemas avoid API-rejected keywords', () => {
  for (const tool of STRICT_TOOLS) {
    it(`${tool.name} uses no minimum/maximum`, () => {
      const keys = new Set<string>();
      collectKeys(tool.input_schema, keys);
      expect(keys.has('minimum')).toBe(false);
      expect(keys.has('maximum')).toBe(false);
    });
  }

  it('states the 0-1 confidence contract in the description instead', () => {
    const text = JSON.stringify(routeClaimsTerminalTool().input_schema);
    expect(text).toContain('0 (could not ground)');
    expect(text).toContain('1 (certain)');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @opslane/worker test -- strict-tool-schemas`
Expected: FAIL — `submit_product_context uses no minimum/maximum` (the other three tools already pass; that is expected, not a broken test).

- [ ] **Step 4: Fix the schema**

In `packages/worker/src/product-context/schema.ts`, replace the `confidence` property line:

```ts
    confidence: {
      type: 'number',
      description: 'How well the code grounds this claim, from 0 (could not ground) to 1 (certain).',
    },
```

Do not touch `parseRouteClaims`: it already rejects confidence outside 0–1 at runtime.

- [ ] **Step 5: Run to verify it passes, then commit**

Run: `pnpm --filter @opslane/worker test -- strict-tool-schemas` → PASS.

```bash
git add packages/worker/src/product-context/schema.ts packages/worker/src/friction/investigate-friction.ts packages/worker/src/__tests__/strict-tool-schemas.test.ts
git commit -m "fix(worker): strict tool schemas drop API-rejected number keywords"
```

---

### Task 2: evidence_conflicts in the claim contract; rename declared requests (D2 parse + D6 rename)

**Files:**
- Modify: `packages/worker/src/product-context/schema.ts`
- Modify: `packages/worker/src/product-context/job.ts`
- Test: `packages/worker/src/__tests__/product-context.test.ts`

**Interfaces:**
- Consumes: Task 1's schema shape.
- Produces: `RouteClaim` gains required `evidenceConflicts: string[]`; `DiscoveredRoute.observedRequests` is renamed to `declaredRequests` everywhere (type, discovery, merge, prompt). Tasks 4 and 6 use exactly `claim.evidenceConflicts` and `route.declaredRequests`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/worker/src/__tests__/product-context.test.ts`:

```ts
const baseClaim = {
  route: '/a',
  purpose: 'Edit a thing',
  actions: ['save'],
  client_refs: ['src/a.ts'],
  server_refs: [],
  audience: 'standard',
  confidence: 0.9,
  evidence_conflicts: [],
};

describe('evidence_conflicts', () => {
  it('is required on every claim', () => {
    const { evidence_conflicts: _dropped, ...withoutConflicts } = baseClaim;
    expect(() => parseRouteClaims({ claims: [withoutConflicts] }, ['/a']))
      .toThrow(/evidence_conflicts/);
  });

  it('accepts an empty list and deduplicates/trims entries', () => {
    const [claim] = parseRouteClaims({
      claims: [{ ...baseClaim, evidence_conflicts: [' PUT /x has no handler ', 'PUT /x has no handler'] }],
    }, ['/a']);
    expect(claim!.evidenceConflicts).toEqual(['PUT /x has no handler']);
  });

  it('rejects non-string entries', () => {
    expect(() => parseRouteClaims({
      claims: [{ ...baseClaim, evidence_conflicts: [42] }],
    }, ['/a'])).toThrow(/evidence_conflicts/);
  });
});

describe('declared requests naming', () => {
  it('discovery output and the model prompt say declaredRequests, not observedRequests', () => {
    const prompt = buildProductContextPrompt([
      { route: '/a', clientRefs: ['src/a.ts'], serverRefs: [], declaredRequests: ['PUT /api/a'] },
    ]);
    expect(prompt).toContain('declaredRequests');
    expect(prompt).not.toContain('observedRequests');
  });
});
```

Existing fixtures in this file that build claims without `evidence_conflicts` or routes with `observedRequests` will fail to compile; updating them is part of this task.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @opslane/worker test -- product-context`
Expected: new tests FAIL / compile errors on the renamed field.

- [ ] **Step 3: Implement**

In `packages/worker/src/product-context/schema.ts`:
1. `RouteClaim` gains `evidenceConflicts: string[];`
2. `ROUTE_CLAIM_SCHEMA.required` gains `'evidence_conflicts'` (this automatically extends `CLAIM_KEYS`).
3. `ROUTE_CLAIM_SCHEMA.properties` gains:
```ts
    evidence_conflicts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Evidence you could not reconcile for this route (observed behavior with no code, code contradicting observation). Empty when everything lines up.',
    },
```
4. `parseRouteClaims` returns `evidenceConflicts: stringArray(value['evidence_conflicts'], 'evidence_conflicts', index),`

In `packages/worker/src/product-context/job.ts`:
1. Rename `DiscoveredRoute.observedRequests` → `declaredRequests`; update `addDiscoveredRoute`, `discoverRepositoryRoutes` (the local `observedRequests(source)` helper can keep its name or become `declaredRequests(source)` — pick one and be consistent), `mergeDiscovery`, and every literal.
2. `unknownClaim` gains `evidenceConflicts: []`.
3. `SYSTEM_PROMPT` gains, after "Do not infer importance from a URL.":
```
Report evidence you could not reconcile in evidence_conflicts and leave it
empty when code and observations agree; never guess across a conflict.
```

- [ ] **Step 4: Run to verify pass, then commit**

`pnpm --filter @opslane/worker test -- product-context` → PASS. Also `pnpm --filter @opslane/worker build` to catch any remaining rename stragglers.

```bash
git add packages/worker/src/product-context/schema.ts packages/worker/src/product-context/job.ts packages/worker/src/__tests__/product-context.test.ts
git commit -m "feat(worker): required evidence_conflicts; declared requests named honestly"
```

---

### Task 3: Migration 056 — quality columns and the runs table (D2/D5/D6 DDL)

**Files:**
- Create: `packages/ingestion/db/migrations/056_product_context_quality.sql`
- Create: `packages/ingestion/db/migration_056_test.go`

**Interfaces:**
- Consumes: `route_map` (040/051/052), `error_group_jobs`, `job_usage` (043).
- Produces: `route_map.evidence_conflicts`, `route_map.review_status`, `route_map.declared_requests`; table `product_context_runs` with `UNIQUE (job_id, execution)` and FK to `error_group_jobs`. Task 4 writes these exact names.

- [ ] **Step 1: Write the migration**

Create `packages/ingestion/db/migrations/056_product_context_quality.sql`:

```sql
-- Verified gaps from the Slice 6 acceptance run (.verify/runs/20260818-152726):
-- conflicts the model could not reconcile had no representation (AC16), run
-- observability was log-only (AC9), and code-derived requests were dropped.
-- observed_requests stays reserved for Slice 5 session evidence; code-derived
-- capabilities land in declared_requests instead.

ALTER TABLE route_map
  ADD COLUMN IF NOT EXISTS evidence_conflicts TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'clear'
    CHECK (review_status IN ('clear', 'needs_review')),
  ADD COLUMN IF NOT EXISTS declared_requests TEXT[] NOT NULL DEFAULT '{}';

-- One row per completed model pass, written in the same lease-fenced
-- transaction as the claims so a completed run always has its record.
-- unknown = claim with confidence 0; conflict_count counts routes whose
-- evidence_conflicts is non-empty; coverage = (route-unknown)/route.
CREATE TABLE IF NOT EXISTS product_context_runs (
  id             BIGSERIAL PRIMARY KEY,
  job_id         UUID NOT NULL REFERENCES error_group_jobs(id) ON DELETE CASCADE,
  execution      INTEGER NOT NULL CHECK (execution >= 0),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha     TEXT NOT NULL CHECK (commit_sha <> ''),
  model          TEXT NOT NULL CHECK (model <> ''),
  prompt_version INTEGER NOT NULL,
  route_count    INTEGER NOT NULL CHECK (route_count >= 0),
  unknown_count  INTEGER NOT NULL CHECK (unknown_count >= 0 AND unknown_count <= route_count),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0 AND conflict_count <= route_count),
  human_route_count INTEGER NOT NULL CHECK (human_route_count >= 0 AND human_route_count <= route_count),
  coverage       REAL NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
  input_tokens   BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens  BIGINT NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens  BIGINT NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens BIGINT NOT NULL CHECK (cache_write_tokens >= 0),
  cost_usd       NUMERIC(12, 6) NOT NULL CHECK (cost_usd >= 0),
  latency_ms     INTEGER NOT NULL CHECK (latency_ms >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, execution)
);

CREATE INDEX IF NOT EXISTS idx_product_context_runs_project
  ON product_context_runs (project_id, created_at DESC);
```

- [ ] **Step 2: Write the migration test**

Create `packages/ingestion/db/migration_056_test.go` in package `db_test`, using the real helpers (`testPool`, `db.New`, `cleanupTenant`, `ptrStr` from `testhelper_test.go`; project seeding as in `project_keys_db_test.go`):

```go
package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestMigration056ProductContextQuality(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "migration-056")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	// No repo on purpose: after Task 5 lands, provisioning WITH a repo
	// enqueues a connect job, and the manual pending insert below would then
	// violate uq_product_context_job_active.
	provisioning, err := q.ProvisionProject(ctx, org.ID, "m056-app", nil, "migration-056")
	if err != nil {
		t.Fatal(err)
	}
	projectID := provisioning.Project.ID

	// New route_map columns exist with their defaults.
	if _, err := pool.Exec(ctx,
		`INSERT INTO route_map (project_id, pattern, name, tier) VALUES ($1, '/m056', 'M', 'standard')`,
		projectID,
	); err != nil {
		t.Fatalf("insert route_map row: %v", err)
	}
	var reviewStatus string
	var conflicts, declared []string
	if err := pool.QueryRow(ctx,
		`SELECT review_status, evidence_conflicts, declared_requests
		   FROM route_map WHERE project_id = $1 AND pattern = '/m056'`,
		projectID,
	).Scan(&reviewStatus, &conflicts, &declared); err != nil {
		t.Fatalf("select new route_map columns: %v", err)
	}
	if reviewStatus != "clear" || len(conflicts) != 0 || len(declared) != 0 {
		t.Fatalf("unexpected defaults: %q %v %v", reviewStatus, conflicts, declared)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE route_map SET review_status = 'bogus' WHERE project_id = $1 AND pattern = '/m056'`,
		projectID,
	); err == nil {
		t.Fatal("review_status accepted a value outside clear/needs_review")
	}

	// The runs table takes a full row keyed to a real job, and job_usage
	// accepts phase 'product_context' (its CHECK is only non-empty).
	var jobID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (project_id, job_type, triggered_by, payload)
		 VALUES ($1, 'product_context', 'auto', '{"trigger":"connect"}'::jsonb)
		 RETURNING id`,
		projectID,
	).Scan(&jobID); err != nil {
		t.Fatalf("seed job: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO product_context_runs
		   (job_id, execution, project_id, commit_sha, model, prompt_version,
		    route_count, unknown_count, conflict_count, human_route_count, coverage,
		    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		    cost_usd, latency_ms)
		 VALUES ($1, 0, $2, 'abc123', 'claude-sonnet-5', 1, 4, 2, 1, 1, 0.5, 100, 50, 0, 0, 0.001, 250)`,
		jobID, projectID,
	); err != nil {
		t.Fatalf("insert product_context_runs: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO product_context_runs
		   (job_id, execution, project_id, commit_sha, model, prompt_version,
		    route_count, unknown_count, conflict_count, human_route_count, coverage,
		    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		    cost_usd, latency_ms)
		 VALUES ($1, 0, $2, 'abc123', 'claude-sonnet-5', 1, 4, 2, 1, 1, 0.5, 100, 50, 0, 0, 0.001, 250)`,
		jobID, projectID,
	); err == nil {
		t.Fatal("duplicate (job_id, execution) run row was accepted")
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO product_context_runs
		   (job_id, execution, project_id, commit_sha, model, prompt_version,
		    route_count, unknown_count, conflict_count, human_route_count, coverage,
		    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		    cost_usd, latency_ms)
		 VALUES ($1, 1, $2, 'abc123', 'claude-sonnet-5', 1, 2, 3, 0, 0, 0, 1, 1, 0, 0, 0, 1)`,
		jobID, projectID,
	); err == nil {
		t.Fatal("unknown_count above route_count was accepted")
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO job_usage
		   (job_id, execution, phase, model, input_tokens, output_tokens,
		    cache_read_tokens, cache_write_tokens, cost_usd)
		 VALUES ($1, 0, 'product_context', 'claude-sonnet-5', 100, 50, 0, 0, 0.001)`,
		jobID,
	); err != nil {
		t.Fatalf("job_usage rejected phase product_context: %v", err)
	}
}
```

If `ProvisionProject`'s signature differs, mirror the exact call `project_keys_db_test.go` makes; do not invent parameters.

- [ ] **Step 3: Run before the migration is applied**

```bash
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"   # or the worktree DSN
cd packages/ingestion && go test ./db/ -run TestMigration056 -v
```
Expected: FAIL on the missing columns — or SKIP if Postgres is unreachable, which means your stack is down; start it (`docker compose up -d postgres` plus the port env block from root `AGENTS.md` if defaults are taken) and re-run. Do not proceed on a skip. If your stack's `migrate` service already auto-applied 056 (it runs every migration in the directory on start), the red observation is unavailable; note that and rely on the assertions.

- [ ] **Step 4: Apply the migration and re-run**

From the repo root, with the same env the stack was started with:

```bash
docker compose run --rm migrate
```

(the compose `migrate` service applies every file in `packages/ingestion/db/migrations/` in order and is idempotent). Re-run the test. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/migrations/056_product_context_quality.sql packages/ingestion/db/migration_056_test.go
git commit -m "feat(db): route_map quality columns and product_context_runs (migration 056)"
```

---

### Task 4: The write path — conflicts, review status, declared requests, and the transactional run record (D2/D5/D6)

One task because it is one deliverable: the final persist signature and the job flow that feeds it. Splitting it would leave a mid-state signature no reviewer should approve.

**Files:**
- Modify: `packages/worker/src/db.ts` (`UsagePhase`, `upsertProductContextClaims`)
- Modify: `packages/worker/src/product-context/job.ts` (`ProductContextWrite`, cap, counts, latency, job_usage)
- Test: `packages/worker/src/__tests__/product-context.integration.test.ts` (create), `packages/worker/src/__tests__/product-context.test.ts` (unit additions)

**Interfaces:**
- Consumes: Task 2's `claim.evidenceConflicts` and `route.declaredRequests`; Task 3's columns and table; existing `recordJobUsage` (`db.ts:357`) and `ClaimedJob.attempts`.
- Produces the final write signature (Task 6's live re-verification and the AC re-run consume the behavior, nothing else consumes the types):

```ts
export async function upsertProductContextClaims(args: {
  projectId: string;
  jobId: string;
  workerId: string;
  leaseGeneration: string;
  claims: RouteClaim[];
  commitSha: string;
  promptVersion: number;
  model: string;
  declaredRequests: Record<string, string[]>;   // route pattern -> sorted requests
  run: {
    execution: number;
    usage: TokenUsage;
    costUsd: number;
    latencyMs: number;
    humanRouteCount: number;
  };
}): Promise<boolean>
```

`route_count`, `unknown_count` (confidence === 0), `conflict_count`, and `coverage` are computed inside the function from `args.claims` so they cannot drift from what was written.

- [ ] **Step 1: Write the failing integration tests**

Create `packages/worker/src/__tests__/product-context.integration.test.ts` modeled exactly on `environment-context.integration.test.ts` (same gate, raw-SQL seeding, `closePool` in `afterAll`):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closePool, upsertProductContextClaims, recordJobUsage } from '../db.js';
import type { RouteClaim } from '../product-context/schema.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('product-context write path integration', () => {
  let pool: pg.Pool;
  let projectId: string;
  let jobId: string;
  const workerId = 'worker-int-test';

  function claim(overrides: Partial<RouteClaim> & { route: string }): RouteClaim {
    return {
      purpose: 'Edit a thing',
      actions: ['save'],
      clientRefs: ['src/a.ts'],
      serverRefs: [],
      audience: 'standard',
      confidence: 0.9,
      evidenceConflicts: [],
      ...overrides,
    };
  }

  async function claimedJob(): Promise<{ jobId: string; leaseGeneration: string }> {
    // Only one product_context job may be pending/claimed per project
    // (uq_product_context_job_active); retire earlier test jobs first.
    await pool.query(
      `UPDATE error_group_jobs SET status = 'completed'
        WHERE project_id = $1 AND job_type = 'product_context' AND status IN ('pending','claimed')`,
      [projectId],
    );
    const job = await pool.query<{ id: string; lease_generation: string }>(
      `INSERT INTO error_group_jobs
         (project_id, job_type, triggered_by, payload, status, worker_id,
          claimed_at, lease_expires_at, lease_generation)
       VALUES ($1, 'product_context', 'auto', '{}'::jsonb, 'claimed', $2,
               now(), now() + interval '5 minutes', 1)
       RETURNING id, lease_generation::text AS lease_generation`,
      [projectId, workerId],
    );
    return { jobId: job.rows[0]!.id, leaseGeneration: job.rows[0]!.lease_generation };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`worker-product-context-${crypto.randomUUID()}`],
    );
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo, default_branch)
       VALUES ($1, 'pc-project', 'example/pc', 'main') RETURNING id`,
      [org.rows[0]!.id],
    );
    projectId = project.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.end();
    await closePool();
  });

  it('persists conflicts, review status, declared requests, and the run record in one write', async () => {
    const lease = await claimedJob();
    jobId = lease.jobId;
    const wrote = await upsertProductContextClaims({
      projectId, jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-1', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: { '/a': ['PUT /api/a'] },
      run: { execution: 0, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.001, latencyMs: 250, humanRouteCount: 0 },
      claims: [
        claim({ route: '/a', confidence: 0.5, evidenceConflicts: ['PUT /api/a observed, no handler in repo'] }),
        claim({ route: '/b', purpose: 'unknown', audience: 'unknown', confidence: 0, clientRefs: [], actions: [] }),
      ],
    });
    expect(wrote).toBe(true);

    const routeA = await pool.query(
      `SELECT evidence_conflicts, review_status, declared_requests, observed_requests
         FROM route_map WHERE project_id = $1 AND pattern = '/a'`, [projectId]);
    expect(routeA.rows[0].evidence_conflicts).toEqual(['PUT /api/a observed, no handler in repo']);
    expect(routeA.rows[0].review_status).toBe('needs_review');
    expect(routeA.rows[0].declared_requests).toEqual(['PUT /api/a']);
    expect(routeA.rows[0].observed_requests).toEqual([]);

    const run = await pool.query(
      `SELECT route_count, unknown_count, conflict_count, coverage::float8 AS coverage, latency_ms
         FROM product_context_runs WHERE job_id = $1 AND execution = 0`, [jobId]);
    expect(run.rows[0]).toMatchObject({ route_count: 2, unknown_count: 1, conflict_count: 1, coverage: 0.5, latency_ms: 250 });
  });

  it('a clean refresh clears review_status and conflicts and replaces declared requests', async () => {
    // Seed the dirty state inside this test so it proves clearing on its own
    // (a default-'clear' implementation that never clears must fail here).
    await pool.query(
      `UPDATE route_map
          SET review_status = 'needs_review', evidence_conflicts = ARRAY['stale conflict']
        WHERE project_id = $1 AND pattern = '/a'`,
      [projectId],
    );
    const lease = await claimedJob();
    const wrote = await upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-2', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: { '/a': ['PUT /api/a', 'GET /api/a'] },
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 1, humanRouteCount: 0 },
      claims: [claim({ route: '/a', confidence: 0.9 })],
    });
    expect(wrote).toBe(true);
    const routeA = await pool.query(
      `SELECT evidence_conflicts, review_status, declared_requests
         FROM route_map WHERE project_id = $1 AND pattern = '/a'`, [projectId]);
    expect(routeA.rows[0].evidence_conflicts).toEqual([]);
    expect(routeA.rows[0].review_status).toBe('clear');
    expect(routeA.rows[0].declared_requests).toEqual(['PUT /api/a', 'GET /api/a']);
  });

  it('never touches a human row, including the new columns', async () => {
    await pool.query(
      `INSERT INTO route_map (project_id, pattern, name, purpose, tier, source, audience, confidence)
       VALUES ($1, '/h', 'Human', 'Curated', 'standard', 'human', 'standard', 1)`, [projectId]);
    const before = await pool.query(`SELECT * FROM route_map WHERE project_id = $1 AND pattern = '/h'`, [projectId]);
    const lease = await claimedJob();
    await upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-3', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: { '/h': ['GET /api/h'] },
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 1, humanRouteCount: 1 },
      claims: [claim({ route: '/h', purpose: 'model rewrite attempt', evidenceConflicts: ['x'] })],
    });
    const after = await pool.query(`SELECT * FROM route_map WHERE project_id = $1 AND pattern = '/h'`, [projectId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('a lost lease writes neither claims nor a run record', async () => {
    const lease = await claimedJob();
    const wrote = await upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: '999',
      commitSha: 'sha-4', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: {},
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 1, humanRouteCount: 0 },
      claims: [claim({ route: '/fenced' })],
    });
    expect(wrote).toBe(false);
    const run = await pool.query(`SELECT count(*)::int AS n FROM product_context_runs WHERE job_id = $1`, [lease.jobId]);
    expect(run.rows[0].n).toBe(0);
  });

  it('claims and the run record share one transaction: a failing run insert rolls back the routes', async () => {
    const lease = await claimedJob();
    // latency_ms has CHECK (latency_ms >= 0); -1 forces the run insert to fail
    // after the route upserts, so the whole write must roll back.
    await expect(upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-tx', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: {},
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: -1, humanRouteCount: 0 },
      claims: [claim({ route: '/txprobe' })],
    })).rejects.toThrow();
    const route = await pool.query(
      `SELECT count(*)::int AS n FROM route_map WHERE project_id = $1 AND pattern = '/txprobe'`, [projectId]);
    expect(route.rows[0].n).toBe(0);
  });

  it('recordJobUsage accepts phase product_context against a real job', async () => {
    const lease = await claimedJob();
    await recordJobUsage({
      jobId: lease.jobId, execution: 0, phase: 'product_context',
      model: 'claude-sonnet-5',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.001,
    });
    const usage = await pool.query(`SELECT phase FROM job_usage WHERE job_id = $1`, [lease.jobId]);
    expect(usage.rows[0]?.phase).toBe('product_context');
  });
});
```

Adjust the `error_group_jobs` insert columns to the real schema if a named column differs (read migration 040/055 rather than guessing); the assertions stay as written. If `TokenUsage`'s field names differ from `{input, output, cacheRead, cacheWrite}`, mirror `db.ts`'s actual type.

- [ ] **Step 2: Write the failing unit tests (cap + metrics feed)**

Add to `packages/worker/src/__tests__/product-context.test.ts`, using the fake-dependencies pattern the file already uses for `runProductContext`:

```ts
it('caps confidence at 0.5 when conflicts exist and passes run metrics to persist', async () => {
  const persisted: unknown[] = [];
  await runProductContext(fakeJob({ attempts: 2 }), new AbortController().signal, {
    prepare: async () => fakePrepared({
      routes: [
        { route: '/a', clientRefs: ['src/a.ts'], serverRefs: [], declaredRequests: ['PUT /api/a'] },
      ],
    }),
    askModel: async () => ({
      raw: { claims: [{ ...wireClaim('/a'), confidence: 0.9, evidence_conflicts: ['PUT /api/a has no handler'] }] },
      filesRead: ['src/a.ts'],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.002,
    }),
    persist: async (write) => { persisted.push(write); return true; },
    countHumanRoutes: async () => 3,
  });
  const write = persisted[0] as { claims: { confidence: number }[]; run: { execution: number; humanRouteCount: number; latencyMs: number }; declaredRequests: Record<string, string[]> };
  expect(write.claims[0]!.confidence).toBe(0.5);
  expect(write.run.execution).toBe(2);
  expect(write.run.humanRouteCount).toBe(3);
  expect(write.run.latencyMs).toBeGreaterThanOrEqual(0);
  expect(write.declaredRequests['/a']).toEqual(['PUT /api/a']);
});
```

Use the file's existing fixture helpers (`fakeJob`, `fakePrepared`, `wireClaim` or their real names); if they do not exist, build the minimal literal objects inline the way the file's other `runProductContext` tests do.

- [ ] **Step 3: Run to verify failure**

```bash
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
pnpm --filter @opslane/worker test -- product-context
```
Expected: integration suite FAILS (signature mismatch / missing columns handling) and the unit test FAILS. Confirm the integration suite ran, not skipped.

- [ ] **Step 4: Implement**

In `packages/worker/src/db.ts`:
1. `UsagePhase` becomes `'investigation' | 'fix' | 'judge' | 'product_context'`.
2. `upsertProductContextClaims` takes the signature above. Inside the existing transaction, after the per-claim loop and before `COMMIT`:
   - per-claim INSERT extends to the new columns (parameter list renumbered consistently):
```sql
INSERT INTO route_map
  (project_id, pattern, name, purpose, tier, actions, client_refs, server_refs,
   observed_requests, audience, confidence, commit_sha, prompt_version, model, source,
   evidence_conflicts, review_status, declared_requests)
VALUES ($1, $2, $3, $3,
        CASE $7 WHEN 'customer' THEN 'customer' WHEN 'admin' THEN 'admin' ELSE 'standard' END,
        $4, $5, $6, '{}'::text[], $7, $8, $9, $10, $11, $12,
        $13, CASE WHEN cardinality($13::text[]) > 0 THEN 'needs_review' ELSE 'clear' END, $14)
ON CONFLICT (project_id, pattern) DO UPDATE SET
  ...existing columns...,
  evidence_conflicts = EXCLUDED.evidence_conflicts,
  review_status = EXCLUDED.review_status,
  declared_requests = EXCLUDED.declared_requests,
  updated_at = now()
WHERE route_map.source <> 'human'
```
     with binds `claim.evidenceConflicts` and `args.declaredRequests[claim.route] ?? []`.
   - one run-record INSERT computed from `args.claims`:
```ts
const routeCount = args.claims.length;
const unknownCount = args.claims.filter((c) => c.confidence === 0).length;
const conflictCount = args.claims.filter((c) => c.evidenceConflicts.length > 0).length;
const coverage = routeCount === 0 ? 0 : (routeCount - unknownCount) / routeCount;
```
```sql
INSERT INTO product_context_runs
  (job_id, execution, project_id, commit_sha, model, prompt_version,
   route_count, unknown_count, conflict_count, human_route_count, coverage,
   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
   cost_usd, latency_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
ON CONFLICT (job_id, execution) DO NOTHING
```

In `packages/worker/src/product-context/job.ts`:
1. `ProductContextDependencies` gains `countHumanRoutes: (projectId: string, patterns: string[]) => Promise<number>;` with default:
```ts
async (projectId, patterns) => {
  const { rows } = await getPoolQuery(  // use db.ts's actual query helper via a new exported db function countHumanRoutePatterns(projectId, patterns)
```
   Concretely: add to `db.ts`:
```ts
export async function countHumanRoutePatterns(projectId: string, patterns: string[]): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM route_map
      WHERE project_id = $1 AND source = 'human' AND pattern = ANY($2)`,
    [projectId, patterns],
  );
  return Number(rows[0]?.n ?? 0);
}
```
   and use it as the default dependency.
2. In `runProductContext`: `const startedAt = Date.now();` as the **first line** (run latency includes clone and discovery, per D5); build `declaredRequests` from `prepared.routes`; apply the cap:
```ts
const capped = grounded.map((claim) => claim.evidenceConflicts.length > 0
  ? { ...claim, confidence: Math.min(claim.confidence, 0.5) }
  : claim);
```
   call `dependencies.countHumanRoutes(job.projectId, discovered)`, then `persist` with `claims: capped`, `declaredRequests`, and `run: { execution: job.attempts, usage: result.usage, costUsd: result.costUsd, latencyMs: Date.now() - startedAt, humanRouteCount }`.
3. After a successful persist, best-effort billing (this is the one intentionally non-transactional write — `job_usage` is a ledger, `recordJobUsage` already swallows failures):
```ts
await db.recordJobUsage({ jobId: job.id, execution: job.attempts, phase: 'product_context', model: PRODUCT_CONTEXT_MODEL, usage: result.usage, costUsd: result.costUsd });
```
4. Keep both existing `logger.info` lines; add `conflict_count` and `human_route_count` fields to the "Product context persisted" line. The unknown predicate everywhere is `confidence === 0`.
5. The zero-route early return stays and records nothing; add one comment line saying so (deliberate narrowing: no model pass, no run record).

- [ ] **Step 5: Run to verify pass, then commit**

`pnpm --filter @opslane/worker test -- product-context` (unit + integration, with `DATABASE_URL`) → PASS, including the pre-existing lease-fencing tests.

```bash
git add packages/worker/src/db.ts packages/worker/src/product-context/job.ts packages/worker/src/__tests__/product-context.integration.test.ts packages/worker/src/__tests__/product-context.test.ts
git commit -m "feat(worker): transactional run records, conflict capping, declared requests"
```

---

### Task 5: Connect-time trigger fires on the transition only (D4, Go)

**Files:**
- Modify: `packages/ingestion/db/queries.go` (`CreateProjectTx` ~line 3390, `SetProjectGitHubConfig` ~line 3413, new `enqueueProductContextConnectTx`)
- Create: `packages/ingestion/db/queries_connect_test.go`

**Interfaces:**
- Consumes: migration 055's partial unique index `uq_product_context_job_active`.
- Produces: a `product_context` job with payload `{"trigger":"connect"}` exactly when a project goes from no/other repo to a usable repo. The worker needs no change (`pushMetadata` yields `changedPaths: null` for that payload → full discovery).

- [ ] **Step 1: Write the failing tests**

Create `packages/ingestion/db/queries_connect_test.go`:

```go
package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func connectJobCount(t *testing.T, projectID string) int {
	t.Helper()
	pool := testPool(t)
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id = $1 AND job_type = 'product_context'
		    AND payload->>'trigger' = 'connect'`,
		projectID,
	).Scan(&n); err != nil {
		t.Fatalf("count connect jobs: %v", err)
	}
	return n
}

func TestSetProjectGitHubConfigEnqueuesOnTransitionOnly(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "connect-trigger")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	provisioning, err := q.ProvisionProject(ctx, org.ID, "connect-app", nil, "connect-trigger")
	if err != nil {
		t.Fatal(err)
	}
	projectID := provisioning.Project.ID

	// First connect: empty -> usable repo enqueues once.
	if err := q.SetProjectGitHubConfig(ctx, org.ID, projectID, "acme/app", "main"); err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, projectID); n != 1 {
		t.Fatalf("expected 1 connect job after first connect, got %d", n)
	}

	// Re-saving the same repo is not a transition, even after the first job
	// completed (the active-job index no longer dedupes then).
	if _, err := pool.Exec(ctx,
		`UPDATE error_group_jobs SET status = 'completed'
		  WHERE project_id = $1 AND job_type = 'product_context'`,
		projectID,
	); err != nil {
		t.Fatal(err)
	}
	if err := q.SetProjectGitHubConfig(ctx, org.ID, projectID, "acme/app", "main"); err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, projectID); n != 1 {
		t.Fatalf("re-saving the same repo enqueued again: %d jobs", n)
	}

	// Switching to a different repository is a transition.
	if err := q.SetProjectGitHubConfig(ctx, org.ID, projectID, "acme/other", "main"); err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, projectID); n != 2 {
		t.Fatalf("expected 2 connect jobs after repo switch, got %d", n)
	}

	// A repo switch while a job is CLAIMED supersedes it back to pending
	// (mirrors push supersession; the fenced worker cannot write stale claims).
	if _, err := pool.Exec(ctx,
		`UPDATE error_group_jobs
		    SET status = 'claimed', worker_id = 'w-old', claimed_at = now(),
		        lease_expires_at = now() + interval '5 minutes'
		  WHERE project_id = $1 AND job_type = 'product_context' AND status = 'pending'`,
		projectID,
	); err != nil {
		t.Fatal(err)
	}
	if err := q.SetProjectGitHubConfig(ctx, org.ID, projectID, "acme/third", "main"); err != nil {
		t.Fatal(err)
	}
	var status string
	var workerID *string
	if err := pool.QueryRow(ctx,
		`SELECT status, worker_id FROM error_group_jobs
		  WHERE project_id = $1 AND job_type = 'product_context'
		    AND status IN ('pending','claimed')`,
		projectID,
	).Scan(&status, &workerID); err != nil {
		t.Fatalf("read superseded job: %v", err)
	}
	if status != "pending" || workerID != nil {
		t.Fatalf("claimed job not superseded on repo switch: status=%q worker=%v", status, workerID)
	}
}

func TestCreateProjectWithRepoEnqueuesProductContext(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "connect-create")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	withRepo, err := q.CreateProject(ctx, org.ID, "with-repo", ptrStr("acme/app"))
	if err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, withRepo.ID); n != 1 {
		t.Fatalf("create-with-repo: expected 1 connect job, got %d", n)
	}

	withoutRepo, err := q.CreateProject(ctx, org.ID, "without-repo", nil)
	if err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, withoutRepo.ID); n != 0 {
		t.Fatalf("create-without-repo: expected 0 connect jobs, got %d", n)
	}

	blank, err := q.CreateProject(ctx, org.ID, "blank-repo", ptrStr("   "))
	if err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, blank.ID); n != 0 {
		t.Fatalf("whitespace repo counted as usable: %d jobs", n)
	}
}
```

If `SetProjectGitHubConfig` or `CreateProject` have different parameter lists than shown, mirror the real signatures from `queries.go`; the assertions stay.

- [ ] **Step 2: Run to verify failure**

```bash
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
cd packages/ingestion && go test ./db/ -run 'Connect|CreateProjectWithRepo' -v
```
Expected: FAIL (no jobs enqueued). Confirm the tests ran, not skipped.

- [ ] **Step 3: Implement**

In `queries.go`:

```go
// enqueueProductContextConnectTx schedules repository understanding when a
// project gains or switches its repo. A repo switch must supersede active
// work exactly like a newer push does: a worker still cloning the OLD repo
// is fenced by lease_generation, and this reset guarantees a fresh job runs
// against the new repo. Mirror EnqueueProductContextPush's conflict arm.
func enqueueProductContextConnectTx(ctx context.Context, tx pgx.Tx, projectID string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs (project_id, job_type, triggered_by, payload)
		 VALUES ($1, 'product_context', 'auto', '{"trigger":"connect"}'::jsonb)
		 ON CONFLICT (project_id, job_type)
		   WHERE job_type = 'product_context' AND status IN ('pending','claimed')
		 DO UPDATE SET
		   status = 'pending',
		   worker_id = NULL,
		   claimed_at = NULL,
		   lease_expires_at = NULL,
		   available_at = now(),
		   attempts = 0,
		   last_error = NULL,
		   payload = EXCLUDED.payload,
		   updated_at = now()`,
		projectID,
	)
	if err != nil {
		return fmt.Errorf("enqueue product context on connect: %w", err)
	}
	return nil
}
```

`SetProjectGitHubConfig`: use a plain transaction with two statements — sibling-CTE execution order is not guaranteed in Postgres, so do not read-and-update in one statement:

```go
// inside a tx: lock, compare, update, enqueue on transition
var previous *string
err = tx.QueryRow(ctx,
	`SELECT github_repo FROM projects WHERE id = $2 AND org_id = $1 FOR UPDATE`,
	orgID, projectID,
).Scan(&previous)
// (preserve the function's existing not-found handling here)
if _, err := tx.Exec(ctx,
	`UPDATE projects SET github_repo = $3, default_branch = $4 WHERE id = $2 AND org_id = $1`,
	orgID, projectID, fullName, defaultBranch,
); err != nil { ... }
next := strings.TrimSpace(fullName)
if next != "" && (previous == nil || strings.TrimSpace(*previous) != next) {
	if err := enqueueProductContextConnectTx(ctx, tx, projectID); err != nil { ... }
}
```

Preserve the function's existing signature, error wrapping style, and not-found behavior; if the function is not currently transactional, make it so for exactly this scope.

`CreateProjectTx`: after the project INSERT, when `githubRepo != nil && strings.TrimSpace(*githubRepo) != ""`, call `enqueueProductContextConnectTx(ctx, tx, p.ID)`.

- [ ] **Step 4: Run tests, build, commit**

Same test command → PASS. Then `cd packages/ingestion && go build ./...`.

Note (recorded limitation, do not "fix" it): the dashboard connect path is covered at the query layer only. Exercising the `SetGitHubConfig` HTTP handler end-to-end needs a faked GitHub App (JWT + installation-repo listing) and is out of scope; the handler's only path to the repo write is this query function.

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/queries_connect_test.go
git commit -m "feat(ingestion): enqueue product context on repository connect transitions"
```

---

### Task 6: Live contract test (D1 guard, runs after all schema changes)

Ordered after Tasks 2 and 4 deliberately: it must exercise the **final** `submit_product_context` schema, including `evidence_conflicts`.

**Files:**
- Create: `packages/worker/src/__tests__/tool-contracts.live.test.ts`

**Interfaces:**
- Consumes: the same `STRICT_TOOLS` list as Task 1's scan (import the builders directly).
- Produces: a gated guard. It fails **only** on `invalid_request_error` (schema rejected); other API errors (auth, rate limit, overloaded) fail with a distinct message naming the real cause so nobody misreads an outage as a schema bug.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { routeClaimsTerminalTool } from '../product-context/schema.js';
import { routeMapTerminalTool } from '../route-map.js';
import { submitDiagnosisTool } from '../diagnose-schema.js';
import { CLASSIFY_TOOL } from '../friction/investigate-friction.js';

const apiKey = process.env['ANTHROPIC_API_KEY'];

// Live half of the strict-schema guard (offline half: strict-tool-schemas.test.ts).
// Gated on ANTHROPIC_API_KEY like the DB suites are gated on DATABASE_URL: a
// keyless environment reports SKIPPED, and release verification must run it
// with a key (root AGENTS.md: read the skip count).
describe.skipIf(!apiKey)('strict tool schemas are accepted by the Anthropic API', () => {
  const tools: Anthropic.Tool[] = [
    routeClaimsTerminalTool(),
    routeMapTerminalTool(),   // vestigial (route_map jobs run the product-context path) but still declared strict
    submitDiagnosisTool(),
    CLASSIFY_TOOL,
  ];

  for (const tool of tools) {
    it(`accepts ${tool.name}`, async () => {
      const client = new Anthropic({ apiKey: apiKey! });
      try {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          tools: [tool],
          messages: [{ role: 'user', content: 'Reply with any text.' }],
        });
        expect(response.type).toBe('message');
      } catch (error: unknown) {
        // Only a 400 whose message points at the tools block is a schema
        // verdict; any other failure (auth, rate limit, outage, unrelated 400)
        // is inconclusive and must not masquerade as one.
        if (error instanceof Anthropic.APIError && error.status === 400 && /tools/i.test(error.message)) {
          throw new Error(`schema for ${tool.name} rejected by the API: ${error.message}`);
        }
        throw new Error(`live check inconclusive for ${tool.name} (not a schema verdict): ${String(error)}`);
      }
    }, 30_000);
  }
});
```

- [ ] **Step 2: Run gated, then live**

`env -u ANTHROPIC_API_KEY pnpm --filter @opslane/worker test -- tool-contracts` → suite SKIPPED (reported as skipped, not passed).
With `ANTHROPIC_API_KEY` exported: 4 PASS. A 400 on any tool is a finding to report, not silently fix — for `submit_product_context` it means Tasks 1–2 are wrong; for the others it is a pre-existing bug outside this plan's scope.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/__tests__/tool-contracts.live.test.ts
git commit -m "test(worker): live Anthropic contract check for strict tool schemas"
```

---

### Task 7: Document the dormant session-fed inputs (D3)

**Files:**
- Modify: `packages/worker/src/db.ts` (the **existing** JSDoc above `listProductContextPatterns` — extend it, do not stack a second block)
- Modify: `packages/ingestion/priority/sweeper.go` (above `enqueueRouteMapJobsSQL`, ~line 289)
- Modify: `packages/worker/AGENTS.md`

- [ ] **Step 1: Extend the db.ts JSDoc**

Append to the existing comment block (which ends "...never human ones."):

```
 *
 * Session-observed routes come from error_groups.page_url_normalized. Slice 2
 * stopped writing error_groups at ingest; Slices 3/4 (stack resolve +
 * settlement) will recreate them from captured observations. Until then this
 * input only sees pre-cutover rows — dormant by decision, not by accident
 * (docs/superpowers/plans/2026-08-18-product-context-fixes.md, D3).
```

- [ ] **Step 2: Add the sweeper.go comment**

Above `enqueueRouteMapJobsSQL`:

```go
// Reads error_groups, which ingest stopped writing in Slice 2. Until the
// Slice 3/4 settlement sweep recreates issue rows from captured observations,
// this trigger only fires for pre-cutover groups. Dormant by decision; see
// docs/superpowers/plans/2026-08-18-product-context-fixes.md (D3).
```

- [ ] **Step 3: Add the AGENTS.md bullet**

In `packages/worker/AGENTS.md` under `## Contracts`:

```markdown
- Product-context discovery's "routes observed in sessions" input and the
  unknown-route sweeper both read `error_groups`, which ingest stopped writing
  in Slice 2. They are dormant for new sessions until the Slice 3/4 settlement
  sweep lands. Do not bridge them from raw `error_events`; that would create a
  second URL-normalization contract.
```

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/db.ts packages/ingestion/priority/sweeper.go packages/worker/AGENTS.md
git commit -m "docs: record the dormant session-fed product-context inputs (D3)"
```

---

### Task 8: Full gate

- [ ] **Step 1: Repository gate**

From the repo root, with the worktree port/URL block from the root `AGENTS.md` exported if the default stack ports are taken (including the MinIO variables — Go storage tests skip without them, and the gate requires **zero** Go skips):

```bash
pnpm install --frozen-lockfile
pnpm -r build
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"   # or the worktree DSN
pnpm --filter @opslane/worker test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
git diff --check
```

Read the worker skip count: only the poller-gated suites and (without a key) the live contract suite may skip. Then run the live contract suite once with `ANTHROPIC_API_KEY` exported and confirm 4 passes.

Then run the full root suite and report it honestly rather than skipping it:

```bash
pnpm test
```

Known pre-existing failure not caused by this plan: the SDK browser matrix fails on hosts without WebKit/Firefox system libraries (verified before this plan: 1 environment failure, remaining tests pass). The gate passes if that is the **only** failure; name it in the completion report. Any other root-level failure is yours to explain.

- [ ] **Step 2: Stop**

Do not push, do not open a PR. The verification session re-runs the acceptance criteria (including a live end-to-end model run — the plan's own live smoke) against this working tree next.

---

## Out of scope (recorded so nobody "helpfully" adds them)

- Checking out the payload SHA instead of branch head; unioning `changed_paths` on supersession; mechanical `serverRefs` discovery; salvaging partial output from a malformed submission (fail-closed whole-run rejection is deliberate). All observed in verification, all deferred.
- Any write to `route_map.observed_requests` (Slice 5 owns it).
- Admin/dashboard UI for `product_context_runs` and `review_status`.
- Auto-discovery of strict tools for the guard tests; the `STRICT_TOOLS` list is maintained by hand and both test files say so.

## Review findings adjudicated (codex iteration 2)

Accepted and folded in: migration test provisions without a repo (avoids colliding with the Task 5 connect enqueue); the integration harness retires prior jobs before claiming (one-active-job index); the clean-refresh test seeds its own dirty state; a rollback test proves claims and run record share one transaction (negative latency forces the run insert to fail); repo switches supersede active jobs exactly like pushes (DO UPDATE mirror of `EnqueueProductContextPush`); the sibling CTE was replaced with two ordered statements in a transaction; the live test only treats a 400 mentioning tools as a schema verdict; `cache_read_tokens`/`cache_write_tokens` joined the runs table; migration apply is a concrete `docker compose run --rm migrate`; the gate runs root `pnpm test` and names the one allowed pre-existing failure.

Rejected: "the pipeline smoke is deferred" — deliberate; the verification session that commissioned this plan re-runs the acceptance criteria, including the live end-to-end model run, immediately after the executor stops. That separation (implementer never grades their own work) is the point.

## Review findings adjudicated (codex iteration 1)

Accepted and folded in: integration tests moved out of the mocked `db-queries.test.ts`; full test bodies everywhere; coverage/execution/FK/uniqueness/cross-checks on `product_context_runs`; run record made transactional with the claims write; `declaredRequests` renamed end-to-end including the prompt; live test moved after all schema changes and made to classify non-schema failures; offline scan made mandatory; cap tested at 0.9→0.5; clean-refresh clears review state; latency measured from job start; unknown/coverage/conflict definitions pinned; connect trigger made transition-aware with trim; JSDoc merged instead of stacked; gate completed.

Rejected with evidence: `job_usage.phase` needs no DDL (CHECK is only non-empty — migration 043; the migration test now proves the phase inserts); human-route counting over `prepared.routes` is the discovery scope (verified live: human-owned repository routes appear in it; session-only human rows outside discovery are out of D5's definition); HTTP-handler-path test for the dashboard connect needs a faked GitHub App and is recorded as a limitation instead.

## Self-review notes

- Spec/decision coverage: D1→T1/T6, D2→T2/T3/T4, D3→T7, D4→T5, D5→T3/T4, D6→T2/T3/T4.
- Type consistency: `evidenceConflicts` (TS) ↔ `evidence_conflicts` (wire/SQL); `declaredRequests` (TS field and arg) ↔ `declared_requests` (SQL); `upsertProductContextClaims` signature defined once in Task 4 and used nowhere else; `countHumanRoutePatterns` defined in Task 4 where it is consumed.
- Judgment calls an implementer must not "fix": `observed_requests` stays `'{}'`; the 0.5 cap is deliberate; zero-route runs record nothing; whole-run rejection of malformed output stays; a live-test 400 is a stop-and-report.
