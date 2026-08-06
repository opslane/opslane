# Diagnosis-First Error Pipeline: M0 + M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the investigation produce an evidence-backed diagnosis and derive the fix-or-not decision from it in code, so the pipeline stops shipping band-aid fixes like [PR #1297](https://github.com/conelike/asset-management-jira/pull/1297).

**Architecture:** The investigation currently answers a boolean `fixable` and the diagnosis is whatever prose justifies it. We invert that. The model calls `submit_diagnosis` with structured fields and never names an outcome. A pure function derives one of three outcomes from `cause_location` plus the project's configured fix surface. `index.ts` routes three ways instead of two, and the fix agent stops being handed a suggested fix.

**Tech Stack:** Node 22, TypeScript (strict, ESM), Vitest, Anthropic SDK, Postgres via `pg`. Go 1.24 in `packages/ingestion` is untouched by this plan.

## Global Constraints

- ESM only. Every relative import ends in `.js`, including from `.ts` sources.
- Strict TypeScript. Use `unknown` plus narrowing, never `any`.
- Tests are colocated in `__tests__/` next to the code they cover.
- Package scope is `@opslane/`. Worker tests run with `pnpm --filter @opslane/worker test`.
- Untrusted model and customer text stays fenced in `<untrusted_data>` tags before it enters a prompt.
- Every terminal `needs_human` write carries a non-empty `reason_code`, `reason_message` and `remediation`. `db.ts:1450` throws otherwise.
- Do not weaken terminal-status or lease contracts to make a test pass.
- The `POST /api/v1/events` wire contract is append-only. Nothing in this plan touches it.
- Existing eval fixtures under `eval/cases/` must keep passing. Never edit a frozen fixture under `test-fixtures/wire/`.

## Reference

Design doc: `docs/design/incident-conclusions.md`. Read the sections "The change in one idea", "What a diagnosis has to contain", and "The three outcomes, renamed" before starting Task 4.

## Starting state

`packages/worker/src/investigate.ts` has **uncommitted local modifications** (45 insertions, 19 deletions). They are a mix of two real fixes and spike scaffolding that must not ship. Task 1 separates them. Do not start any other task until Task 1 is committed.

There are also 11 untracked spike files. `packages/worker/src/__tests__/spike-b-resolution.test.ts` reaches into `../../../sdk/src/debug-images.js`, dragging a file outside `rootDir` into the worker's program, so **`pnpm --filter @opslane/worker build` fails today** with two `TS6059` errors. The SDK builds clean. Task 1 deletes them.

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `shared/src/diagnosis.ts` | The `Diagnosis`, `FailingRequest` and `DiagnosisOutcome` types. Runtime-free, shared by worker and eval. Re-exported from `shared/src/types.ts`, which is the package entry; there is no `index.ts`. |
| `packages/worker/src/diagnosis-schema.ts` | The `submit_diagnosis` Anthropic tool definition and a parser that turns raw tool input into a validated `Diagnosis`. |
| `packages/worker/src/classify.ts` | `deriveOutcome`, the pure function that maps a `Diagnosis` plus a fix surface to one of three outcomes. No I/O, no model. |
| `packages/worker/src/fix-surface.ts` | Loads a project's fix-surface globs and answers whether a repo path is inside it. |
| `packages/worker/src/__tests__/classify.test.ts` | The derivation tests, including the two routing invariants. |
| `packages/worker/src/__tests__/fix-surface.test.ts` | Glob matching and path-shape detection. |
| `packages/worker/src/__tests__/diagnosis-schema.test.ts` | Parser validation and word limits. |
| `eval/src/validate.ts` | Runtime validation of a loaded `EvalCase`. |
| `eval/src/__tests__/validate.test.ts` | Validator tests. |
| `eval/cases/hard-*/case.json` | The six hard fixtures, promoted from the spike file and validated. |

**Modified files:**

| Path | Change |
|---|---|
| `packages/worker/src/investigate.ts` | `classify_error` replaced by `submit_diagnosis`; returns a `Diagnosis` plus a derived outcome. |
| `packages/worker/src/index.ts:552-600` | Two-way routing becomes three-way. |
| `packages/worker/src/index.ts:571` | Stops populating `suggestedMitigation`. |
| `packages/worker/src/agent-fix.ts:505-520` | Receives the diagnosis; no longer receives a suggested mitigation. |
| `packages/worker/src/harness/tool-bridge.ts:172` | `give_up` becomes `submit_diagnosis`. |
| `packages/worker/src/db.ts` | New `loadFixSurface` (Task 5) and `recordDiagnosisDecision` (Task 10). |
| `eval/src/loader.ts:7` | Calls the validator. |
| `eval/src/types.ts:37` | `expected.outcome` gains a third value. |

**Deleted files:** the 11 spike files listed in Task 1. `packages/worker/src/__tests__/spike-b-resolution.test.ts` imports `../../../sdk/src/debug-images.js`, which puts a file outside `rootDir` into the worker's program, so `pnpm --filter @opslane/worker build` currently fails with two `TS6059` errors. The SDK's own build is unaffected.

---

## Task 1: Separate the real investigate.ts fixes from spike scaffolding

The working tree mixes two production fixes with experiment plumbing. Ship the fixes with tests, delete the rest, so every later task starts from a clean base.

**Files:**
- Modify: `packages/worker/src/investigate.ts`
- Test: `packages/worker/src/__tests__/investigate.test.ts`
- Delete: `packages/worker/spike-cd.ts`, `spike-d2.ts`, `spike-e.ts`, `spike-evalset.ts`, `spike-evidence.ts`, `spike-hard.ts`, `spike-matrix.ts`, `packages/worker/src/__tests__/spike-b-resolution.test.ts`, `packages/sdk/src/__tests__/spike-a-pr1297.test.ts`, `packages/sdk/src/__tests__/spike-g-breadcrumb.test.ts`, `cli/spike-agentsdk.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `investigateError(apiKey: string, input: InvestigateInput, repoPath: string): Promise<InvestigationResult>` with the `variant` parameter removed.

- [ ] **Step 1: Move the hard-case data into the repository before deleting the spike file**

`spike-hard.ts` holds the six hard cases and Task 3 needs their error data. Do not stage it in `/tmp`: that disappears across machines and reboots, and Task 3 may run days later or on another checkout. Commit it where Task 3 will look.

```bash
mkdir -p eval/fixtures-source
cp packages/worker/spike-hard.ts eval/fixtures-source/hard-cases-reference.ts
git add eval/fixtures-source/hard-cases-reference.ts
```

**Not** under `eval/cases/`: every command in Tasks 2, 3 and 11 enumerates that directory and expects a `case.json` in each entry.

Add a header line to the copied file so nobody mistakes it for live code:

```ts
// Reference only. The source data for eval/cases/hard-*, kept because the H4
// entry here is the broken one: its crumb() helper emits no timestamp, which is
// why the retry storm it claims to test was never in the fixture.
```

- [ ] **Step 2: Write the failing test for fail-closed budget exhaustion**

Add to `packages/worker/src/__tests__/investigate.test.ts`:

```ts
it('fails closed when the budget is exhausted before any classification', async () => {
  process.env['INVESTIGATION_BUDGET_USD'] = '0.0000001';
  mockMessagesCreate.mockResolvedValueOnce(
    toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
  );

  const result = await investigateError('test-key', makeInput(), tempDir);

  expect(result.fixable).toBe(false);
  expect(result.reason).toBe('Investigation budget exceeded');
  delete process.env['INVESTIGATION_BUDGET_USD'];
});

it('keeps a classification that arrives in the same response that blows the budget', async () => {
  process.env['INVESTIGATION_BUDGET_USD'] = '0.0000001';
  mockMessagesCreate.mockResolvedValueOnce(
    classifyResponse({ fixable: true, confidence: 'high', reason: 'null deref in App.vue:42' }),
  );

  const result = await investigateError('test-key', makeInput(), tempDir);

  expect(result.fixable).toBe(true);
  expect(result.reason).toBe('null deref in App.vue:42');
  delete process.env['INVESTIGATION_BUDGET_USD'];
});
```

- [ ] **Step 3: Run the tests to verify they fail against committed HEAD**

```bash
git stash push packages/worker/src/investigate.ts
pnpm --filter @opslane/worker test -- investigate
```

Expected: both new tests FAIL. The first because HEAD returns `fixable: true` on exhaustion, the second because HEAD checks the budget before parsing the response.

```bash
git stash pop
```

- [ ] **Step 4: Strip the spike scaffolding from investigate.ts, keep the two fixes**

Remove: the `InvestigationVariant` interface, the `variant` parameter from `classifyTool`, `toolsFor`, `buildInvestigationPrompt` and `investigateError`, and the `raw` field on `InvestigationResult`.

Keep: `INVESTIGATION_MODEL`, `INVESTIGATION_MAX_TURNS` and `INVESTIGATION_BUDGET_USD` env overrides (they make the tests above possible), the response-parsing-before-budget-check ordering, and both `fixable: false` exhaustion returns.

The two blocks that must survive verbatim:

```ts
    // Process response blocks BEFORE the budget check. This response is already
    // paid for; if it carries the classification, discarding it wastes the spend
    // AND throws away the answer.
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
```

```ts
    // Budget check. Fails CLOSED: exhaustion is an execution failure, not a
    // finding, so it must not hand the fix agent a `fixable: true` it never
    // earned. Skipped when this response already contains the classification.
    const hasClassification = toolCalls.some((tc) => tc.name === 'classify_error');
    if (cost > BUDGET_USD && !hasClassification) {
```

- [ ] **Step 5: Delete the spike files**

```bash
rm -f packages/worker/spike-cd.ts packages/worker/spike-d2.ts packages/worker/spike-e.ts \
      packages/worker/spike-evalset.ts packages/worker/spike-evidence.ts \
      packages/worker/spike-hard.ts packages/worker/spike-matrix.ts \
      packages/worker/src/__tests__/spike-b-resolution.test.ts \
      packages/sdk/src/__tests__/spike-a-pr1297.test.ts \
      packages/sdk/src/__tests__/spike-g-breadcrumb.test.ts \
      cli/spike-agentsdk.mjs
```

- [ ] **Step 6: Run the worker suite and confirm the build is unblocked**

```bash
pnpm --filter @opslane/worker test
pnpm --filter @opslane/worker build
```

Expected: all PASS. Before Step 5 the build fails with:

```
../sdk/src/debug-images.ts(5,8): error TS6059: File '.../packages/sdk/src/build/registry-contract.ts'
  is not under 'rootDir' '.../packages/worker/src'
src/__tests__/spike-b-resolution.test.ts(13,35): error TS6059: ...
```

That is the worker's build, not the SDK's. `pnpm --filter @opslane/sdk build` passes either way, so do not use it to check this.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/investigate.ts packages/worker/src/__tests__/investigate.test.ts
git commit -m "fix(worker): investigation budget failures fail closed and keep paid-for classifications

Exhaustion returned fixable: true, so the hardest investigations defaulted to
attempting a fix. The budget was also checked before the response was parsed,
discarding a classification we had already paid for.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git add -A packages/worker packages/sdk cli
git commit -m "chore: remove investigation spike scaffolding

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Validate eval fixtures at load

`eval/src/loader.ts:7` casts `JSON.parse` straight to `EvalCase` and checks three fields. `eval/src/types.ts:16` declares breadcrumb `timestamp` required and nothing enforces it. Task 3 adds fixtures whose whole point is timing evidence, so the guard comes first.

**Files:**
- Create: `eval/src/validate.ts`
- Create: `eval/src/__tests__/validate.test.ts`
- Modify: `eval/src/loader.ts`

**Interfaces:**
- Consumes: `EvalCase` from `eval/src/types.ts`.
- Produces: `validateCase(raw: unknown, caseDir: string): EvalCase`, throws `Error` with a message naming the case directory and the specific failure.

- [ ] **Step 1: Write the failing test**

Create `eval/src/__tests__/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateCase } from '../validate.js';

function baseCase(): Record<string, unknown> {
  return {
    id: 'demo-001',
    app: 'demo',
    bug_patch: null,
    error_event: {
      error: { type: 'TypeError', message: 'boom', stack: 'at App.vue:1:1' },
      breadcrumbs: [
        { type: 'fetch', timestamp: '2026-08-06T10:00:00.000Z', category: 'fetch', message: 'GET /a' },
      ],
      context: {},
    },
    expected: { outcome: 'fix_pr' },
    grading: { fail_to_pass: [], pass_to_pass: [] },
  };
}

describe('validateCase', () => {
  it('accepts a well-formed case', () => {
    expect(() => validateCase(baseCase(), 'cases/demo-001')).not.toThrow();
  });

  it('rejects a breadcrumb with no timestamp', () => {
    const c = baseCase() as any;
    delete c.error_event.breadcrumbs[0].timestamp;
    expect(() => validateCase(c, 'cases/demo-001')).toThrow(/breadcrumbs\[0\].*timestamp/);
  });

  it('rejects a breadcrumb with a non-ISO timestamp', () => {
    const c = baseCase() as any;
    c.error_event.breadcrumbs[0].timestamp = 'yesterday';
    expect(() => validateCase(c, 'cases/demo-001')).toThrow(/breadcrumbs\[0\].*timestamp/);
  });

  it('accepts an empty breadcrumb list', () => {
    const c = baseCase() as any;
    c.error_event.breadcrumbs = [];
    expect(() => validateCase(c, 'cases/demo-001')).not.toThrow();
  });

  it('names the case directory in the error', () => {
    const c = baseCase() as any;
    delete c.id;
    expect(() => validateCase(c, 'cases/demo-001')).toThrow(/cases\/demo-001/);
  });

  it('rejects an unknown expected.outcome', () => {
    const c = baseCase() as any;
    c.expected.outcome = 'maybe';
    expect(() => validateCase(c, 'cases/demo-001')).toThrow(/expected\.outcome/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @opslane/eval test -- validate
```

Expected: FAIL, "Failed to resolve import ../validate.js".

- [ ] **Step 3: Write the validator**

Create `eval/src/validate.ts`:

```ts
import type { EvalCase } from './types.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const OUTCOMES = ['fix_pr', 'needs_human', 'conclusion'] as const;

function fail(caseDir: string, what: string): never {
  throw new Error(`Invalid case.json in ${caseDir}: ${what}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Runtime validation of a parsed case.json. The EvalCase type annotation on
 * JSON.parse is a promise to the compiler, not a check on the data: a fixture
 * missing every breadcrumb timestamp used to load clean, run, and produce a
 * score indistinguishable from a real one.
 */
export function validateCase(raw: unknown, caseDir: string): EvalCase {
  if (!isRecord(raw)) fail(caseDir, 'not an object');

  for (const k of ['id', 'app'] as const) {
    if (typeof raw[k] !== 'string' || !raw[k]) fail(caseDir, `missing required field "${k}"`);
  }

  const ev = raw['error_event'];
  if (!isRecord(ev)) fail(caseDir, 'missing required field "error_event"');

  const err = ev['error'];
  if (!isRecord(err)) fail(caseDir, 'error_event.error is missing');
  for (const k of ['type', 'message', 'stack'] as const) {
    if (typeof err[k] !== 'string') fail(caseDir, `error_event.error.${k} must be a string`);
  }

  const crumbs = ev['breadcrumbs'];
  if (!Array.isArray(crumbs)) fail(caseDir, 'error_event.breadcrumbs must be an array');
  crumbs.forEach((c, i) => {
    if (!isRecord(c)) fail(caseDir, `error_event.breadcrumbs[${i}] is not an object`);
    const ts = c['timestamp'];
    if (typeof ts !== 'string' || !ISO.test(ts)) {
      fail(caseDir, `error_event.breadcrumbs[${i}].timestamp must be an ISO 8601 string, got ${JSON.stringify(ts)}`);
    }
    for (const k of ['type', 'category', 'message'] as const) {
      if (typeof c[k] !== 'string') fail(caseDir, `error_event.breadcrumbs[${i}].${k} must be a string`);
    }
  });

  if (ev['platform'] !== undefined && typeof ev['platform'] !== 'string') {
    fail(caseDir, 'error_event.platform must be a string when present');
  }
  if (ev['context'] !== undefined && !isRecord(ev['context'])) {
    fail(caseDir, 'error_event.context must be an object when present');
  }

  const grading = raw['grading'];
  if (!isRecord(grading)) fail(caseDir, 'missing required field "grading"');
  for (const k of ['fail_to_pass', 'pass_to_pass'] as const) {
    if (!Array.isArray(grading[k])) fail(caseDir, `grading.${k} must be an array`);
  }

  const exp = raw['expected'];
  if (!isRecord(exp)) fail(caseDir, 'missing required field "expected"');
  if (!OUTCOMES.includes(exp['outcome'] as typeof OUTCOMES[number])) {
    fail(caseDir, `expected.outcome must be one of ${OUTCOMES.join(', ')}, got ${JSON.stringify(exp['outcome'])}`);
  }

  return raw as unknown as EvalCase;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @opslane/eval test -- validate
```

Expected: 6 PASS.

- [ ] **Step 5: Wire the validator into the loader**

In `eval/src/loader.ts`, replace the body of `loadCase`:

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { EvalCase } from './types.js';
import { validateCase } from './validate.js';

export async function loadCase(caseDir: string): Promise<EvalCase> {
  const raw = await readFile(path.join(caseDir, 'case.json'), 'utf-8');
  return validateCase(JSON.parse(raw), caseDir);
}
```

- [ ] **Step 6: Add the third outcome to the type**

In `eval/src/types.ts`, change the `expected.outcome` union:

```ts
  expected: {
    outcome: 'fix_pr' | 'needs_human' | 'conclusion';
    rca_file?: string;
    reason_code?: ReasonCode;
  };
```

- [ ] **Step 7: Verify every existing fixture still loads**

```bash
pnpm --filter @opslane/eval test
pnpm --filter @opslane/eval build
node --input-type=module -e "
const {loadCase}=await import('./eval/dist/loader.js');
const {readdirSync,existsSync}=await import('node:fs');
const dirs=readdirSync('eval/cases').filter(d=>existsSync('eval/cases/'+d+'/case.json'));
for (const d of dirs) await loadCase('eval/cases/'+d);
console.log('all', dirs.length, 'cases valid');
"
```

Expected: "all cases valid". All 26 existing fixtures already carry timestamps on every breadcrumb, so none should fail. If one does, fix the fixture, not the validator.

- [ ] **Step 8: Commit**

```bash
git add eval/src/validate.ts eval/src/__tests__/validate.test.ts eval/src/loader.ts eval/src/types.ts
git commit -m "feat(eval): validate case fixtures at load

A type annotation on JSON.parse is not a runtime check. Breadcrumb timestamps
were declared required and never enforced, which is how a fixture could be
missing the evidence its own test depended on and still produce a score.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Promote the hard cases to validated fixtures, with H4 rebuilt and paired

H4 was meant to test an external-looking symptom with a local cause: a 429 caused by our own client looping. Its 12 breadcrumbs carried no timestamps, so the burst was never in the data. It is rebuilt here with real timing, and paired with a control that looks the same but has the opposite correct answer, so passing means something.

**Files:**
- Create: `eval/cases/hard-h1-timeout/case.json`
- Create: `eval/cases/hard-h2-500-reported/case.json`
- Create: `eval/cases/hard-h4-retry-storm/case.json`
- Create: `eval/cases/hard-h4-control-server-ratelimit/case.json`
- Create: `eval/cases/hard-h5-malformed-url/case.json`
- Create: `eval/cases/hard-h6-null-deref/case.json`
- Reference: `eval/fixtures-source/hard-cases-reference.ts`, committed in Task 1 Step 1

**Interfaces:**
- Consumes: `validateCase` from Task 2.
- Produces: six fixture directories. Task 8 asserts against `hard-h1-timeout` and `hard-h4-retry-storm`.

- [ ] **Step 1: Write the H4 fixture with a visible burst**

Create `eval/cases/hard-h4-retry-storm/case.json`. Twelve requests inside 480 milliseconds, which no human clicking could produce:

```json
{
  "id": "hard-h4-retry-storm",
  "app": "asset-management-jira",
  "bug_patch": null,
  "error_event": {
    "platform": "javascript",
    "error": {
      "type": "FetchError",
      "message": "Server Error: 429 | GET /api/asset-types",
      "stack": "FetchError: Server Error: 429 | GET /api/asset-types\n    at handleResponse (client/asset-panel/src/api/fetcher/index.ts:41:11)"
    },
    "breadcrumbs": [
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.000Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.041Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.083Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.126Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.168Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.211Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.253Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.297Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.339Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.382Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.424Z", "category": "fetch", "level": "error", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 429 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.467Z", "category": "fetch", "level": "error", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 429, "error": "Server Error: 429 | GET /api/asset-types" } }
    ],
    "context": { "note": "12 requests in 467ms. No user input could produce this cadence." }
  },
  "expected": {
    "outcome": "fix_pr",
    "rca_file": "client/asset-panel/src/App.tsx"
  },
  "grading": { "fail_to_pass": [], "pass_to_pass": [] }
}
```

- [ ] **Step 2: Write the paired control**

Create `eval/cases/hard-h4-control-server-ratelimit/case.json`. Same endpoint, same 429, same error text. The only difference is the cadence: eleven minutes of ordinary use, so no client loop exists and the correct answer flips.

```json
{
  "id": "hard-h4-control-server-ratelimit",
  "app": "asset-management-jira",
  "bug_patch": null,
  "error_event": {
    "platform": "javascript",
    "error": {
      "type": "FetchError",
      "message": "Server Error: 429 | GET /api/asset-types",
      "stack": "FetchError: Server Error: 429 | GET /api/asset-types\n    at handleResponse (client/asset-panel/src/api/fetcher/index.ts:41:11)"
    },
    "breadcrumbs": [
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.000Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:02:11.400Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:04:52.900Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:07:38.100Z", "category": "fetch", "level": "info", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 200 } },
      { "type": "fetch", "timestamp": "2026-08-06T10:11:04.700Z", "category": "fetch", "level": "error", "message": "GET /api/asset-types", "data": { "method": "GET", "url": "/api/asset-types", "status_code": 429, "error": "Server Error: 429 | GET /api/asset-types" } }
    ],
    "context": { "note": "5 requests over 11 minutes. Ordinary use; the limit is being applied server-side." }
  },
  "expected": { "outcome": "conclusion" },
  "grading": { "fail_to_pass": [], "pass_to_pass": [] }
}
```

- [ ] **Step 3: Write the remaining four fixtures**

Port H1, H2, H5 and H6 from `eval/fixtures-source/hard-cases-reference.ts`, adding an ISO timestamp to every breadcrumb. Set `expected.outcome` to `conclusion` for `hard-h1-timeout` and `hard-h2-500-reported`, and `fix_pr` for `hard-h5-malformed-url` and `hard-h6-null-deref`.

`hard-h1-timeout` is the PR #1297 case and must carry this error shape:

```json
{
  "id": "hard-h1-timeout",
  "app": "asset-management-jira",
  "bug_patch": null,
  "error_event": {
    "platform": "javascript",
    "error": {
      "type": "TimeoutError",
      "message": "signal timed out",
      "stack": "TimeoutError: signal timed out\n    at fetchWithTimeout (client/asset-panel/src/api/fetcher/index.ts:28:5)"
    },
    "breadcrumbs": [
      { "type": "fetch", "timestamp": "2026-08-06T10:00:00.000Z", "category": "fetch", "level": "error", "message": "GET /issue-context/api/assets/search", "data": { "method": "GET", "url": "/issue-context/api/assets/search?q=laptop", "error": "signal timed out" } }
    ],
    "context": {}
  },
  "expected": { "outcome": "conclusion" },
  "grading": { "fail_to_pass": [], "pass_to_pass": [] }
}
```

- [ ] **Step 4: Verify every new fixture validates**

```bash
pnpm --filter @opslane/eval build
node --input-type=module -e "
const {loadCase}=await import('./eval/dist/loader.js');
const {readdirSync,existsSync}=await import('node:fs');
for (const d of readdirSync('eval/cases').filter(x=>existsSync('eval/cases/'+x+'/case.json'))) { await loadCase('eval/cases/'+d); console.log('ok', d); }
"
```

Expected: all 32 cases print `ok`.

- [ ] **Step 5: Prove the validator would have caught the old H4**

```bash
node --input-type=module -e "
const {validateCase}=await import('./eval/dist/validate.js');
const {readFileSync}=await import('node:fs');
const c=JSON.parse(readFileSync('eval/cases/hard-h4-retry-storm/case.json','utf8'));
c.error_event.breadcrumbs.forEach(b => delete b.timestamp);
try { validateCase(c,'cases/hard-h4-retry-storm'); console.log('REGRESSION: accepted the broken fixture'); process.exit(1); }
catch(e) { console.log('correctly rejected:', e.message); }
"
```

Expected: "correctly rejected: ... breadcrumbs[0].timestamp must be an ISO 8601 string, got undefined".

- [ ] **Step 6: Commit**

```bash
git add eval/cases/hard-*
git commit -m "test(eval): promote the six hard cases to validated fixtures

H4 is rebuilt with real timing: the retry storm it was built to test was never
in the data, so twelve identical requests were equally consistent with a client
loop and with ordinary use. It is now paired with a control carrying the same
error and the opposite correct answer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The Diagnosis type and the submit_diagnosis tool

**Files:**
- Create: `shared/src/diagnosis.ts`
- Modify: `shared/src/types.ts`
- Create: `packages/worker/src/diagnosis-schema.ts`
- Create: `packages/worker/src/__tests__/diagnosis-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DiagnosisOutcome = 'code_fix' | 'not_actionable' | 'needs_more_context'`
  - `interface FailingRequest { method: string; url: string; status?: number; count: number }`
  - `interface Diagnosis { one_line_description: string; why_chain: string[]; reproduction_steps: string[]; cause_location: string; failing_request?: FailingRequest | null }`
  - `submitDiagnosisTool(): Anthropic.Tool`
  - `parseDiagnosis(raw: Record<string, unknown>): Diagnosis | null`, returns `null` when a required field is missing or empty.

- [ ] **Step 1: Write the shared types**

Create `shared/src/diagnosis.ts`:

```ts
/**
 * The primary artifact of an investigation. The classification is derived from
 * this in code (see packages/worker/src/classify.ts); the model never names an
 * outcome. Field shape follows Sentry Seer's RootCauseArtifact, with
 * cause_location standing in for their relevant_repo because our fix surface is
 * a set of paths inside one repository rather than a choice between repos.
 */
export interface Diagnosis {
  /** Under 30 words. */
  one_line_description: string;
  /** Cause to effect, each entry under 15 words. */
  why_chain: string[];
  /** Each entry under 15 words. */
  reproduction_steps: string[];
  /** A `path/to/file.ts:42` inside the repo, or a description of the external system. */
  cause_location: string;
  /** Extracted in code from breadcrumbs, never written by the model. */
  failing_request?: FailingRequest | null;
}

export interface FailingRequest {
  method: string;
  url: string;
  status?: number;
  /** How many matching requests were seen, after collapsing repeats. */
  count: number;
}

/**
 * code_fix          a defect inside the authorized fix surface we can change and verify
 * not_actionable    real cause, no permitted change here removes it (infra, third party, outside the surface)
 * needs_more_context  the analysis is plausible but too vague to act on
 */
export type DiagnosisOutcome = 'code_fix' | 'not_actionable' | 'needs_more_context';
```

- [ ] **Step 2: Export it**

There is no `shared/src/index.ts`. The package entry is `shared/src/types.ts` (`shared/package.json` sets `"main": "dist/types.js"`), so re-export from there. Append to `shared/src/types.ts`:

```ts
export type { Diagnosis, FailingRequest, DiagnosisOutcome } from './diagnosis.js';
```

Confirm the re-export actually reaches consumers before relying on it:

```bash
pnpm --filter @opslane/shared build
node --input-type=module -e "import('@opslane/shared').then(() => console.log('exports ok'))"
```

- [ ] **Step 3: Write the failing test**

Create `packages/worker/src/__tests__/diagnosis-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { submitDiagnosisTool, parseDiagnosis } from '../diagnosis-schema.js';

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    one_line_description: 'Search endpoint exceeds its 10 second budget',
    why_chain: ['User types in search box', 'Client calls /api/assets/search', 'Server does not respond in 10s'],
    reproduction_steps: ['Open the asset panel', 'Type a query with many matches'],
    cause_location: 'GET /issue-context/api/assets/search (remote service)',
    ...over,
  };
}

describe('submitDiagnosisTool', () => {
  it('has no field in which the model can name an outcome', () => {
    const props = submitDiagnosisTool().input_schema.properties as Record<string, unknown>;
    for (const banned of ['fixable', 'outcome', 'reason_code', 'classification', 'assessment']) {
      expect(props[banned]).toBeUndefined();
    }
  });

  it('requires the four diagnosis fields', () => {
    const req = (submitDiagnosisTool().input_schema as { required: string[] }).required;
    expect(req.sort()).toEqual(['cause_location', 'one_line_description', 'reproduction_steps', 'why_chain']);
  });
});

describe('parseDiagnosis', () => {
  it('parses a well-formed submission', () => {
    const d = parseDiagnosis(raw());
    expect(d?.cause_location).toBe('GET /issue-context/api/assets/search (remote service)');
    expect(d?.why_chain).toHaveLength(3);
  });

  it('returns null when cause_location is missing', () => {
    const r = raw(); delete r['cause_location'];
    expect(parseDiagnosis(r)).toBeNull();
  });

  it('returns null when cause_location is blank', () => {
    expect(parseDiagnosis(raw({ cause_location: '   ' }))).toBeNull();
  });

  it('returns null when why_chain is empty', () => {
    expect(parseDiagnosis(raw({ why_chain: [] }))).toBeNull();
  });

  it('returns null when reproduction_steps is empty, because Task 8 joins it into a required field', () => {
    expect(parseDiagnosis(raw({ reproduction_steps: [] }))).toBeNull();
  });

  it('truncates an over-long summary rather than rejecting it', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const d = parseDiagnosis(raw({ one_line_description: long }));
    expect(d).not.toBeNull();
    expect(d!.one_line_description.split(/\s+/).length).toBeLessThanOrEqual(31);
  });

  it('truncates each why_chain entry to 15 words', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const d = parseDiagnosis(raw({ why_chain: [long] }));
    expect(d!.why_chain[0]!.split(/\s+/).length).toBeLessThanOrEqual(16);
  });

  it('drops non-string entries from why_chain rather than failing', () => {
    const d = parseDiagnosis(raw({ why_chain: ['a real step', 42, null, 'another step'] }));
    expect(d?.why_chain).toEqual(['a real step', 'another step']);
  });

  it('ignores a failing_request supplied by the model', () => {
    const d = parseDiagnosis(raw({ failing_request: { method: 'GET', url: '/made-up', count: 99 } }));
    expect(d?.failing_request).toBeUndefined();
  });

  it('returns null for a non-object', () => {
    expect(parseDiagnosis(null as unknown as Record<string, unknown>)).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm --filter @opslane/worker test -- diagnosis-schema
```

Expected: FAIL, "Failed to resolve import ../diagnosis-schema.js".

- [ ] **Step 5: Write the schema module**

Create `packages/worker/src/diagnosis-schema.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { Diagnosis } from '@opslane/shared';

/**
 * The investigation's terminal tool. Deliberately carries no outcome field:
 * the model reports what it found and our code decides what that means, so a
 * reworded diagnosis cannot change where the incident lands.
 */
export function submitDiagnosisTool(): Anthropic.Tool {
  return {
    name: 'submit_diagnosis',
    description:
      'Submit your diagnosis. Call this once you can explain what caused the error. ' +
      'Do not propose a fix and do not decide what should happen next.',
    input_schema: {
      type: 'object' as const,
      properties: {
        one_line_description: {
          type: 'string',
          description: 'What caused the error, in under 30 words.',
        },
        why_chain: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered chain of one-line "why" statements from entry point to failure, each under 15 words. ' +
            'Write only the answers, not the questions: prefer "x -> y -> z".',
        },
        reproduction_steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Steps that would reproduce this error, each under 15 words.',
        },
        cause_location: {
          type: 'string',
          description:
            'Where the cause lives. A repository path with a line number (src/api/fetcher.ts:41) when the ' +
            'defect is in code you read. Otherwise name the external system, for example ' +
            '"GET /api/assets/search (remote service)". Report where it is; do not decide whether we can fix it.',
        },
      },
      required: ['one_line_description', 'why_chain', 'reproduction_steps', 'cause_location'],
    },
  };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

/**
 * Returns null when the submission is unusable. A null here is a
 * needs_more_context outcome, never a conclusion.
 *
 * failing_request is deliberately not read from the model: it is extracted from
 * breadcrumbs in code (M2), because unaided the model names the failing endpoint
 * about one time in three.
 */
export function parseDiagnosis(raw: Record<string, unknown>): Diagnosis | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const desc = typeof raw['one_line_description'] === 'string' ? raw['one_line_description'].trim() : '';
  const where = typeof raw['cause_location'] === 'string' ? raw['cause_location'].trim() : '';
  const why = strings(raw['why_chain']);
  const repro = strings(raw['reproduction_steps']);

  // reproduction_steps is required by the schema, so an empty list is a parse
  // failure rather than a silently-empty field. Task 8 joins it into the
  // remediation, and `[].join('; ')` is `''`, which db.ts:1450 rejects.
  if (!desc || !where || why.length === 0 || repro.length === 0) return null;

  // Word limits are enforced by truncation, not rejection: a diagnosis that is
  // right but wordy is still worth having, and rejecting it would route a good
  // run to needs_more_context over formatting.
  const clampWords = (t: string, n: number): string => {
    const w = t.trim().split(/\s+/);
    return w.length <= n ? t.trim() : w.slice(0, n).join(' ') + '…';
  };

  return {
    one_line_description: clampWords(desc, 30),
    why_chain: why.map((w) => clampWords(w, 15)),
    reproduction_steps: repro.map((r) => clampWords(r, 15)),
    cause_location: where,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm -r build && pnpm --filter @opslane/worker test -- diagnosis-schema
```

Expected: 12 PASS. `pnpm -r build` is required because `@opslane/shared` gained a new export.

- [ ] **Step 7: Commit**

```bash
git add shared/src/diagnosis.ts shared/src/types.ts packages/worker/src/diagnosis-schema.ts packages/worker/src/__tests__/diagnosis-schema.test.ts
git commit -m "feat(worker): add the Diagnosis type and the submit_diagnosis tool

The tool carries no outcome field. The model reports what it found; deriving
what that means is Task 5's job.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The fix surface

`cause_location` is either a path in the repository or a description of something outside it. The surface decides which paths we are allowed to change.

**Files:**
- Create: `packages/worker/src/fix-surface.ts`
- Create: `packages/worker/src/__tests__/fix-surface.test.ts`
- Create: `packages/ingestion/db/migrations/010_fix_surface.sql`
- Modify: `packages/worker/src/db.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface FixSurface { globs: string[] | null }`, `null` means the whole repository, which is today's behaviour, so an unconfigured project is unaffected.
  - `parseCauseLocation(causeLocation: string): CauseLocation` with three kinds: `repo_path`, `external_system`, `vague`.
  - `isInsideFixSurface(path: string, surface: FixSurface): boolean`
  - `loadFixSurface(projectId: string): Promise<FixSurface>` in `db.ts`.

Without `loadFixSurface` nothing supplies a surface at runtime and the whole boundary is theory. Task 8 calls it.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/fix-surface.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCauseLocation, isInsideFixSurface } from '../fix-surface.js';

describe('parseCauseLocation', () => {
  it('reads a path with a line number', () => {
    expect(parseCauseLocation('client/asset-panel/src/App.tsx:5'))
      .toEqual({ kind: 'repo_path', path: 'client/asset-panel/src/App.tsx', line: 5 });
  });

  it('reads a path with no line number', () => {
    expect(parseCauseLocation('server/app/routes/api/resources/asset.py'))
      .toEqual({ kind: 'repo_path', path: 'server/app/routes/api/resources/asset.py' });
  });

  it('reads a repository-root file', () => {
    expect(parseCauseLocation('package.json:12')).toEqual({ kind: 'repo_path', path: 'package.json', line: 12 });
  });

  it('strips a leading ./', () => {
    expect(parseCauseLocation('./src/App.tsx:3')).toEqual({ kind: 'repo_path', path: 'src/App.tsx', line: 3 });
  });

  it('strips wrapping backticks', () => {
    expect(parseCauseLocation('`src/App.tsx:3`')).toEqual({ kind: 'repo_path', path: 'src/App.tsx', line: 3 });
  });

  it('recognises an HTTP method and path as an external system', () => {
    expect(parseCauseLocation('GET /issue-context/api/assets/search (remote service)'))
      .toEqual({ kind: 'external_system' });
  });

  it('recognises a URL as an external system', () => {
    expect(parseCauseLocation('https://cdn.example.com/app.js')).toEqual({ kind: 'external_system' });
  });

  it('recognises a hostname as an external system', () => {
    expect(parseCauseLocation('api.assetmanagementforjira.com is not responding'))
      .toEqual({ kind: 'external_system' });
  });

  // Path shape wins over the hostname signal, or these read as external.
  it('does not mistake a repo path containing a domain-like segment for a host', () => {
    expect(parseCauseLocation('src/example.com/config.ts:4'))
      .toEqual({ kind: 'repo_path', path: 'src/example.com/config.ts', line: 4 });
    expect(parseCauseLocation('config/service.dev.ts'))
      .toEqual({ kind: 'repo_path', path: 'config/service.dev.ts' });
  });

  it('calls bare prose vague, not external', () => {
    expect(parseCauseLocation('the cause could not be determined')).toEqual({ kind: 'vague' });
  });

  it('calls a directory-shaped reference vague', () => {
    expect(parseCauseLocation('src/api')).toEqual({ kind: 'vague' });
  });

  it('calls a path escaping the repo root vague', () => {
    expect(parseCauseLocation('../../../etc/passwd:1')).toEqual({ kind: 'vague' });
  });
});

describe('isInsideFixSurface', () => {
  const frontendOnly = { globs: ['client/**'] };

  it('accepts a path under a configured glob', () => {
    expect(isInsideFixSurface('client/asset-panel/src/App.tsx', frontendOnly)).toBe(true);
  });

  it('rejects a path outside every configured glob', () => {
    expect(isInsideFixSurface('server/app/routes/api/resources/asset.py', frontendOnly)).toBe(false);
  });

  it('accepts everything when no surface is configured', () => {
    expect(isInsideFixSurface('server/app/routes/api/resources/asset.py', { globs: null })).toBe(true);
  });

  it('rejects everything when the surface is configured empty', () => {
    expect(isInsideFixSurface('client/asset-panel/src/App.tsx', { globs: [] })).toBe(false);
  });

  it('matches a single-segment wildcard without crossing directories', () => {
    expect(isInsideFixSurface('client/App.tsx', { globs: ['client/*'] })).toBe(true);
    expect(isInsideFixSurface('client/deep/App.tsx', { globs: ['client/*'] })).toBe(false);
  });

  // `a/**/b` must not match `a/xb`: the separator is part of the pattern.
  it('does not let ** swallow a path separator', () => {
    const g = { globs: ['client/**/App.tsx'] };
    expect(isInsideFixSurface('client/App.tsx', g)).toBe(true);
    expect(isInsideFixSurface('client/deep/nested/App.tsx', g)).toBe(true);
    expect(isInsideFixSurface('client/EvilApp.tsx', g)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @opslane/worker test -- fix-surface
```

Expected: FAIL, "Failed to resolve import ../fix-surface.js".

- [ ] **Step 3: Write the module**

Create `packages/worker/src/fix-surface.ts`:

```ts
/**
 * Which paths in the clone we are allowed to change. `globs: null` means the
 * whole repository, which is the behaviour before this existed, so an
 * unconfigured project is unaffected. v1 sets frontend-only globs per project.
 *
 * This is separate from what the agent may READ. Reading is not fixing: the
 * agent should open a backend handler to say why it is slow even when it will
 * never patch it.
 */
export interface FixSurface {
  globs: string[] | null;
}

export type CauseLocation =
  | { kind: 'repo_path'; path: string; line?: number }
  | { kind: 'external_system' }
  | { kind: 'vague' };

const PATH_SEGMENT = /^[\w.@+-]+$/;

/** A URL, an HTTP method plus path, or an explicit external marker. */
const EXTERNAL_SIGNALS: RegExp[] = [
  /^[a-z][a-z0-9+.-]*:\/\//i,
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S/,
  /\((?:remote|external|third[- ]party)[^)]*\)/i,
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|cloud|app)\b/i,
];

/**
 * Three kinds, not two, and the third is the point.
 *
 * An earlier version returned `external` for anything that did not parse as a
 * path, which meant "unknown" and "probably the backend" became terminal
 * conclusions. That handed routing straight back to the model: write prose, get
 * a conclusion. Only a positively recognised external citation is external now.
 * Everything unrecognised is vague, and vague is a failure, never a conclusion.
 */
export function parseCauseLocation(causeLocation: string): CauseLocation {
  const raw = (causeLocation ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
  if (!raw) return { kind: 'vague' };

  // Path shape is tested FIRST. A hostname signal would otherwise misread
  // legitimate repository paths like `src/example.com/config.ts` or
  // `config/service.dev.ts` as external systems.
  const m = /^\.?\/?([^\s:]+?)(?::(\d+))?$/.exec(raw);
  const looksLikePath =
    m !== null &&
    (/\.[A-Za-z0-9]+$/.test(m[1]!) || /^(Dockerfile|Makefile|Procfile)$/i.test(m[1]!)) &&
    m[1]!.split('/').every((sg) => sg !== '' && sg !== '.' && sg !== '..' && PATH_SEGMENT.test(sg));

  if (!looksLikePath) {
    return EXTERNAL_SIGNALS.some((re) => re.test(raw)) ? { kind: 'external_system' } : { kind: 'vague' };
  }

  const path = m![1]!;
  const line = m![2] ? Number(m![2]) : undefined;
  if (line !== undefined && line < 1) return { kind: 'repo_path', path };
  return line === undefined ? { kind: 'repo_path', path } : { kind: 'repo_path', path, line };
}

/** Matches `**` across separators and `*` within one segment. */
function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          // `a/**/b` must match `a/b` and `a/x/y/b`, never `a/xb`.
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + '$');
}

export function isInsideFixSurface(path: string, surface: FixSurface): boolean {
  if (surface.globs === null) return true;
  return surface.globs.some((g) => globToRegExp(g).test(path));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @opslane/worker test -- fix-surface
```

Expected: 18 PASS.

- [ ] **Step 5: Add the column that holds a project's surface**

Create `packages/ingestion/db/migrations/010_fix_surface.sql`:

```sql
-- 010_fix_surface.sql, which paths in a clone we are allowed to change.
-- Append-only after 001-009. IDEMPOTENCY IS MANDATORY: run-migrations.sh
-- re-applies every file on every start.
--
-- NULL means the whole repository, which is the behaviour before this column
-- existed, so every existing project is unaffected until someone sets it.
-- This is the fix surface, not the read surface: the agent should open a
-- backend handler to explain a slow endpoint even when it will never patch it.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS fix_surface_globs TEXT[];
```

- [ ] **Step 6: Load it**

Add to `packages/worker/src/db.ts`:

```ts
import type { FixSurface } from './fix-surface.js';

/** NULL column means the whole repository: the behaviour before the column existed. */
export async function loadFixSurface(projectId: string): Promise<FixSurface> {
  const { rows } = await getPool().query<{ fix_surface_globs: string[] | null }>(
    'SELECT fix_surface_globs FROM projects WHERE id = $1',
    [projectId],
  );
  return { globs: rows[0]?.fix_surface_globs ?? null };
}
```

- [ ] **Step 7: Verify the migration is idempotent**

```bash
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
(cd packages/ingestion && ./db/run-migrations.sh && ./db/run-migrations.sh)
psql "$DATABASE_URL" -c "\\d projects" | grep fix_surface_globs
```

Expected: two clean runs, and the column present exactly once.

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/fix-surface.ts packages/worker/src/__tests__/fix-surface.test.ts packages/ingestion/db/migrations/010_fix_surface.sql packages/worker/src/db.ts
git commit -m "feat(worker): add the fix surface, separating what we may read from what we may patch

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Derive the outcome in code

This is the task that makes the inversion real. Nothing else changes routing.

**Files:**
- Create: `packages/worker/src/classify.ts`
- Create: `packages/worker/src/__tests__/classify.test.ts`

**Interfaces:**
- Consumes: `Diagnosis`, `DiagnosisOutcome` from `@opslane/shared`; `FixSurface`, `parseCauseLocation`, `isInsideFixSurface` from Task 5.
- Produces: `deriveOutcome(diagnosis: Diagnosis | null, surface: FixSurface, fileExists: (p: string) => boolean): DerivedDecision` where `interface DerivedDecision { outcome: DiagnosisOutcome; reason: string }`.

- [ ] **Step 1: Write the failing test, including the two routing invariants**

Create `packages/worker/src/__tests__/classify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Diagnosis } from '@opslane/shared';
import { deriveOutcome } from '../classify.js';

const frontendOnly = { globs: ['client/**'] };
const allFilesExist = () => true;

function diag(over: Partial<Diagnosis> = {}): Diagnosis {
  return {
    one_line_description: 'Null dereference rendering the asset list',
    why_chain: ['Asset list renders before fetch resolves', 'assets is null', 'map throws'],
    reproduction_steps: ['Open the panel with a slow network'],
    cause_location: 'client/asset-panel/src/AssetList.tsx:42',
    ...over,
  };
}

describe('deriveOutcome', () => {
  it('routes a defect inside the surface to code_fix', () => {
    expect(deriveOutcome(diag(), frontendOnly, allFilesExist).outcome).toBe('code_fix');
  });

  it('routes a recognised external cause to not_actionable', () => {
    const d = diag({ cause_location: 'GET /issue-context/api/assets/search (remote service)' });
    expect(deriveOutcome(d, frontendOnly, allFilesExist).outcome).toBe('not_actionable');
  });

  // The hole this closes: prose used to parse as "external", so the model could
  // reach a terminal conclusion by declining to name anything.
  it.each([
    'unknown',
    'probably the backend',
    'could not locate the cause',
    'somewhere in the API layer',
    'src/api',
  ])('routes vague location %j to needs_more_context, never a conclusion', (loc) => {
    const r = deriveOutcome(diag({ cause_location: loc }), frontendOnly, allFilesExist);
    expect(r.outcome).toBe('needs_more_context');
  });

  it('accepts a repository-root file as a citation', () => {
    const d = diag({ cause_location: 'package.json:12' });
    expect(deriveOutcome(d, { globs: null }, allFilesExist).outcome).toBe('code_fix');
  });

  it('accepts a ./-prefixed citation', () => {
    const d = diag({ cause_location: './client/asset-panel/src/AssetList.tsx:42' });
    expect(deriveOutcome(d, frontendOnly, allFilesExist).outcome).toBe('code_fix');
  });

  it('only opens a PR unattended when the diagnosis is solid', () => {
    const thin = diag({ why_chain: ['it broke'], reproduction_steps: [], cause_location: 'client/a/b.tsx' });
    const solid = diag();
    expect(deriveOutcome(thin, frontendOnly, allFilesExist).confidence).toBe('medium');
    expect(deriveOutcome(solid, frontendOnly, allFilesExist).confidence).toBe('high');
  });

  it('routes a real defect outside the surface to not_actionable', () => {
    const d = diag({ cause_location: 'server/app/routes/api/resources/asset.py:79' });
    const r = deriveOutcome(d, frontendOnly, allFilesExist);
    expect(r.outcome).toBe('not_actionable');
    expect(r.reason).toMatch(/outside the configured fix surface/);
  });

  it('routes a missing diagnosis to needs_more_context', () => {
    expect(deriveOutcome(null, frontendOnly, allFilesExist).outcome).toBe('needs_more_context');
  });

  it('routes an uncheckable citation to needs_more_context, not a conclusion', () => {
    const d = diag({ cause_location: 'client/asset-panel/src/Ghost.tsx:9' });
    const r = deriveOutcome(d, frontendOnly, () => false);
    expect(r.outcome).toBe('needs_more_context');
    expect(r.reason).toMatch(/does not exist/);
  });

  // The two invariants. Neither can pass while the model picks the label.
  it('INVARIANT: rewording a diagnosis does not change the route', () => {
    const a = diag();
    const b = diag({
      one_line_description: 'The asset list blows up on a null collection',
      why_chain: ['Render happens first', 'The collection is null', 'Calling map on null throws'],
      reproduction_steps: ['Load the panel on a throttled connection'],
    });
    const ra = deriveOutcome(a, frontendOnly, allFilesExist);
    const rb = deriveOutcome(b, frontendOnly, allFilesExist);
    expect(rb.outcome).toBe(ra.outcome);
  });

  it('INVARIANT: changing where the defect sits does change the route', () => {
    const inside = diag({ cause_location: 'client/asset-panel/src/AssetList.tsx:42' });
    const outside = diag({ cause_location: 'server/app/routes/api/resources/asset.py:79' });
    expect(deriveOutcome(inside, frontendOnly, allFilesExist).outcome)
      .not.toBe(deriveOutcome(outside, frontendOnly, allFilesExist).outcome);
  });

  it('is unaffected by an unconfigured surface, matching pre-existing behaviour', () => {
    const d = diag({ cause_location: 'server/app/routes/api/resources/asset.py:79' });
    expect(deriveOutcome(d, { globs: null }, allFilesExist).outcome).toBe('code_fix');
  });

  it('never answers not_actionable merely because evidence is thin', () => {
    const d = diag({ why_chain: ['something went wrong'], cause_location: '' });
    expect(deriveOutcome(d, frontendOnly, allFilesExist).outcome).toBe('needs_more_context');
  });

  it('rejects a directory cited as if it were a file', () => {
    const d = diag({ cause_location: 'client/asset-panel/src/AssetList.tsx' });
    // fileExists answers false for a directory; see Task 7 Step 3's statSync guard.
    expect(deriveOutcome(d, frontendOnly, () => false).outcome).toBe('needs_more_context');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @opslane/worker test -- classify
```

Expected: FAIL, "Failed to resolve import ../classify.js".

- [ ] **Step 3: Write the derivation**

Create `packages/worker/src/classify.ts`:

```ts
import type { Diagnosis, DiagnosisOutcome } from '@opslane/shared';
import { parseCauseLocation, isInsideFixSurface, type FixSurface } from './fix-surface.js';

export interface DerivedDecision {
  outcome: DiagnosisOutcome;
  /** Why this outcome, in our words. Written to the incident and the decision record. */
  reason: string;
  /**
   * Derived from how much the diagnosis actually established, not asked of the
   * model. Only `high` opens a PR without a human; `medium` parks at
   * `investigated` for approval.
   */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * `high` is the bar for opening a PR with nobody watching, so it asks for a
 * chain with real steps in it, at least one reproduction step, and a citation
 * precise enough to carry a line number.
 *
 * This measures how carefully the run was written up, not whether it is right.
 * A confidently wrong diagnosis with a well-formed chain still scores high.
 * See "Known gaps".
 */
export const HIGH_CONFIDENCE_MIN_CHAIN = 3;

function deriveConfidence(d: Diagnosis, line: number | undefined): 'high' | 'medium' {
  const solid =
    d.why_chain.length >= HIGH_CONFIDENCE_MIN_CHAIN &&
    d.reproduction_steps.length >= 1 &&
    line !== undefined;
  return solid ? 'high' : 'medium';
}

/**
 * Maps a diagnosis to an outcome. Pure: same inputs, same answer, no model and
 * no I/O. `fileExists` is injected so the citation check stays testable.
 *
 * The ordering matters. Missing evidence always lands on needs_more_context and
 * never on not_actionable, because a conclusion is something we stand behind and
 * a thin run is not.
 */
export function deriveOutcome(
  diagnosis: Diagnosis | null,
  surface: FixSurface,
  fileExists: (path: string) => boolean,
): DerivedDecision {
  if (!diagnosis) {
    return { outcome: 'needs_more_context', reason: 'The investigation produced no usable diagnosis', confidence: 'low' };
  }

  const loc = parseCauseLocation(diagnosis.cause_location);

  if (loc.kind === 'vague') {
    return {
      outcome: 'needs_more_context',
      reason: `The diagnosis did not name a checkable location: ${JSON.stringify(diagnosis.cause_location)}`,
      confidence: 'low',
    };
  }

  if (loc.kind === 'external_system') {
    return {
      outcome: 'not_actionable',
      reason: `The cause is outside this codebase: ${diagnosis.cause_location}`,
      // No line number exists on an external citation, so pass undefined
      // explicitly rather than reading loc.line, which is not on this variant.
      confidence: deriveConfidence(diagnosis, undefined),
    };
  }

  // fileExists must answer false for a directory: `src/api` is not a citation.
  if (!fileExists(loc.path)) {
    return {
      outcome: 'needs_more_context',
      reason: `The diagnosis cites ${loc.path}, which does not exist in the checked-out repository`,
      confidence: 'low',
    };
  }

  if (!isInsideFixSurface(loc.path, surface)) {
    return {
      outcome: 'not_actionable',
      reason: `The cause is at ${diagnosis.cause_location}, which is outside the configured fix surface`,
      confidence: deriveConfidence(diagnosis, loc.line),
    };
  }

  return {
    outcome: 'code_fix',
    reason: `The cause is at ${diagnosis.cause_location}`,
    confidence: deriveConfidence(diagnosis, loc.line),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @opslane/worker test -- classify
```

Expected: 18 PASS, including both invariants and all five vague-location cases.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/classify.ts packages/worker/src/__tests__/classify.test.ts
git commit -m "feat(worker): derive the investigation outcome in code

Two invariants are now testable and both hold: rewording a diagnosis does not
change where the incident lands, and moving the defect does. Neither test could
pass while the model chose the label.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Swap the investigation over to submit_diagnosis

**Files:**
- Modify: `packages/worker/src/investigate.ts`
- Modify: `packages/worker/src/__tests__/investigate.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 6.
- Produces: `InvestigationResult` gains `diagnosis: Diagnosis | null`, `outcome: DiagnosisOutcome` and `decisionReason: string`. `fixable` stays for one release as `outcome === 'code_fix'`, so nothing downstream breaks before Task 8.
- `investigateError` gains a fourth parameter: `surface: FixSurface`.

- [ ] **Step 1: Write the failing test**

Add to `packages/worker/src/__tests__/investigate.test.ts`:

```ts
function diagnosisResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool_use', id: 'dg-1', name: 'submit_diagnosis', input }],
    usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

describe('investigateError with submit_diagnosis', () => {
  it('answers not_actionable when the cause is a remote service', async () => {
    mockMessagesCreate.mockResolvedValueOnce(diagnosisResponse({
      one_line_description: 'The search endpoint exceeded its 10 second budget',
      why_chain: ['User types a query', 'Client calls /api/assets/search', 'No response within 10s'],
      reproduction_steps: ['Search for a term with many matches'],
      cause_location: 'GET /issue-context/api/assets/search (remote service)',
    }));

    const result = await investigateError('test-key', makeInput({
      errorType: 'TimeoutError',
      errorMessage: 'signal timed out',
    }), tempDir, { globs: null });

    expect(result.outcome).toBe('not_actionable');
    expect(result.fixable).toBe(false);
    expect(result.diagnosis?.why_chain).toHaveLength(3);
  });

  it('answers needs_more_context when the tool submits nothing usable', async () => {
    mockMessagesCreate.mockResolvedValueOnce(diagnosisResponse({ one_line_description: 'not sure' }));

    const result = await investigateError('test-key', makeInput(), tempDir, { globs: null });

    expect(result.outcome).toBe('needs_more_context');
    expect(result.diagnosis).toBeNull();
  });

  it('answers code_fix when the cited file exists in the clone', async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'src/App.vue'), '<template></template>');

    mockMessagesCreate.mockResolvedValueOnce(diagnosisResponse({
      one_line_description: 'Null dereference when assets have not loaded',
      why_chain: ['Render runs before fetch resolves', 'assets is null', 'map throws'],
      reproduction_steps: ['Open the panel on a slow connection'],
      cause_location: 'src/App.vue:42',
    }));

    const result = await investigateError('test-key', makeInput(), tempDir, { globs: null });

    expect(result.outcome).toBe('code_fix');
    expect(result.fixable).toBe(true);
  });

  it('answers needs_more_context on budget exhaustion, never a conclusion', async () => {
    process.env['INVESTIGATION_BUDGET_USD'] = '0.0000001';
    mockMessagesCreate.mockResolvedValueOnce(
      toolUseResponse([{ name: 'read_file', input: { path: 'src/App.vue' } }]),
    );

    const result = await investigateError('test-key', makeInput(), tempDir, { globs: null });

    expect(result.outcome).toBe('needs_more_context');
    delete process.env['INVESTIGATION_BUDGET_USD'];
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @opslane/worker test -- investigate
```

Expected: FAIL. `result.outcome` is undefined and `investigateError` takes three parameters.

- [ ] **Step 3: Replace classify_error with submit_diagnosis in investigate.ts**

Delete the `classifyTool` function. In `toolsFor`, return `[submitDiagnosisTool(), readFile, search, listFiles]`. Update every reference to `'classify_error'` in the turn-pressure text, the final-turn `tool_choice`, and the `hasClassification` check.

Replace the terminal branch:

```ts
      if (tc.name === 'submit_diagnosis') {
        const diagnosis = parseDiagnosis(tc.input);
        // statSync, not existsSync: a directory is not a citation, and
        // `src/api` must not pass as if it named a file.
        const isFile = (p: string): boolean => {
          try { return statSync(join(repoPath, p)).isFile(); } catch { return false; }
        };
        const decision = deriveOutcome(diagnosis, surface, isFile);
        return {
          fixable: decision.outcome === 'code_fix',
          confidence: decision.confidence,
          reason: decision.reason,
          diagnosis,
          outcome: decision.outcome,
          decisionReason: decision.reason,
          filesRead,
          findings: lastModelText,
        };
      }
```

Change every early return to carry the new fields. The three failure exits become:

```ts
      return {
        fixable: false, confidence: 'low', reason: 'Investigation API call failed',
        diagnosis: null, outcome: 'needs_more_context', decisionReason: 'Investigation API call failed',
        filesRead, findings: lastModelText,
      };
```

with `'Investigation budget exceeded'` and `'Investigation did not produce a diagnosis'` for the other two.

- [ ] **Step 3b: Update every existing caller and test**

Making `surface` required is a compile break. Find them all before running anything:

```bash
grep -rn "investigateError(" packages/worker/src eval/src --include=*.ts
```

Production has exactly one caller, `index.ts:530`, and Task 8 changes it. Every call in `packages/worker/src/__tests__/investigate.test.ts` needs a fourth argument; `{ globs: null }` preserves the old behaviour for tests that are not about the surface.

```bash
pnpm --filter @opslane/worker build
```

Expected: exactly one `TS2554: Expected 4 arguments, but got 3` at `index.ts`. Any other location means a caller was missed.

Fix that one call **in this task**, not in Task 8, so this commit builds. Task 8 changes what happens after the call; Task 7 only has to keep it compiling:

```ts
    const surface = await db.loadFixSurface(job.projectId);
    const triage = await investigateError(apiKey, { /* unchanged */ }, repoDir, surface);
```

`loadFixSurface` exists from Task 5. Never commit a task knowing the build is red: the next engineer cannot tell your breakage from theirs.

Add the imports:

```ts
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnosis, DiagnosisOutcome } from '@opslane/shared';
import { submitDiagnosisTool, parseDiagnosis } from './diagnosis-schema.js';
import { deriveOutcome } from './classify.js';
import type { FixSurface } from './fix-surface.js';
```

- [ ] **Step 4: Update the prompt so the agent explains rather than judges**

In `buildInvestigationPrompt`, delete the entire `## Classification Rules` section, including the line

```
- The error is purely infrastructure/network (CORS, DNS, timeout, 502, 503) with no application code involvement
```

whose trailing clause can never fire for a browser fetch, and the line

```
When in doubt, classify as fixable with medium/low confidence, we'd rather investigate than miss a real bug.
```

Replace with:

```
## Your Task
Find the ROOT CAUSE of this error. Do not propose fixes, only identify why the error is happening.

- Use your tools to read the relevant code.
- Ask "why" repeatedly until you reach the true cause, not just the symptom.
- Reading is not fixing. Open code anywhere in the repository that helps you explain
  what happened, including code you would not change.
- Report where the cause lives. Do not decide whether we are able to fix it.
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @opslane/worker test -- investigate
```

Expected: all PASS, including the pre-existing tests from Task 1.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/investigate.ts packages/worker/src/__tests__/investigate.test.ts
git commit -m "feat(worker): the investigation submits a diagnosis instead of a verdict

Removes the classification rule whose trailing clause ('with no application code
involvement') could never fire for a browser fetch, and the tie-break that told
the model to answer fixable when unsure.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Route three ways and cut the suggested-mitigation pipe

**Files:**
- Modify: `packages/worker/src/index.ts:525` (the dead replay read), `:530` (the call), `:552-600` (routing)
- Test: `packages/worker/src/__tests__/index.test.ts`

**Interfaces:**
- Consumes: Task 7's `InvestigationResult`.
- Produces: `code_fix` + high confidence creates a fix job; `not_actionable` writes status `insight` and increments `jobsProcessed`; `needs_more_context` writes `needs_human` and increments `jobsFailed`.

- [ ] **Step 1: Write the failing test**

Add to `packages/worker/src/__tests__/index.test.ts`:

```ts
describe('processInvestigateJob routing', () => {
  it('routes not_actionable to insight and counts it as work done', async () => {
    const calls = await runInvestigateJobWith({
      outcome: 'not_actionable',
      decisionReason: 'The cause is outside this codebase: GET /api/assets/search (remote service)',
      diagnosis: {
        one_line_description: 'The search endpoint exceeded its 10 second budget',
        why_chain: ['User types', 'Client calls the endpoint', 'No response in 10s'],
        reproduction_steps: ['Search a common term'],
        cause_location: 'GET /api/assets/search (remote service)',
      },
    });
    expect(calls.status).toBe('insight');
    expect(calls.fixJobCreated).toBe(false);
    expect(calls.counter).toBe('processed');
  });

  it('routes needs_more_context to needs_human and counts it as a failure', async () => {
    const calls = await runInvestigateJobWith({
      outcome: 'needs_more_context',
      decisionReason: 'The investigation produced no usable diagnosis',
      diagnosis: null,
    });
    expect(calls.status).toBe('needs_human');
    expect(calls.counter).toBe('failed');
  });

  it('never sends a suggested mitigation to the fix job', async () => {
    const calls = await runInvestigateJobWith({
      outcome: 'code_fix',
      decisionReason: 'The cause is at src/App.vue:42',
      // Must clear deriveConfidence's high bar (>= 3 chain steps, >= 1 repro
      // step, a line number) or this lands on `investigated` and no fix job is
      // created. Confidence comes from the decision now, not from the model.
      confidence: 'high',
      diagnosis: {
        one_line_description: 'Null dereference rendering the asset list',
        why_chain: ['Render runs before fetch resolves', 'assets is null', 'map throws'],
        reproduction_steps: ['Open the panel on a slow connection'],
        cause_location: 'src/App.vue:42',
      },
    });
    expect(calls.fixJobCreated).toBe(true);
    expect(calls.fields).not.toHaveProperty('suggestedMitigation');
  });
});
```

Implement `runInvestigateJobWith` alongside the existing mocking style in that file, stubbing `investigateError` and capturing the arguments passed to `updateGroupInvestigation` and `updateGroupAndCreateFixJob`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @opslane/worker test -- index
```

Expected: FAIL. Today `not_actionable` has no branch and `suggestedMitigation` is always set.

- [ ] **Step 3: Delete the dead replay read and load the fix surface**

`index.ts:525` assigns `replay` and never reads it, costing a query per investigation. Delete the line. M2 reinstates it as a real input. In its place, load the surface and pass it to the investigation, which is what makes Task 7's fourth parameter compile:

```ts
    const surface = await db.loadFixSurface(job.projectId);

    const triage = await investigateError(apiKey, {
      platform,
      customerRuntime,
      errorType: event?.error_type ?? 'Unknown',
      title: group.title,
      errorMessage: event?.error_message ?? '',
      stackTrace: event?.stack_trace_raw ?? '',
      resolvedStackTrace: resolvedStack ?? framesFromEnvelope(event?.stack_trace_resolved) ?? null,
      breadcrumbs: event?.breadcrumbs ?? '[]',
    }, repoDir, surface);
```

- [ ] **Step 4: Replace the routing block**

Replace `index.ts:552-600` with:

```ts
    if (triage.outcome === 'needs_more_context') {
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
        rootCause: triage.decisionReason,
        confidence: triage.confidence,
        reason: {
          reason_code: 'insufficient_context',
          reason_message: triage.decisionReason,
          remediation: 'Review the error manually; the investigation could not establish a cause.',
        },
      }, job);
      jobsFailed++;
      logger.warn('Investigation: needs_human (no usable diagnosis)', { job_id: job.id, duration_ms: durationMs });

    } else if (triage.outcome === 'not_actionable') {
      // A conclusion we stand behind: terminal, and work done rather than failure.
      // Two different situations share this outcome and want different codes:
      // a cause genuinely outside our code, and a real defect that merely sits
      // outside the configured fix surface. unfixable_infra is wrong for the
      // second, which is an ordinary code bug we are simply not allowed to touch.
      const outsideSurface = triage.decisionReason.includes('outside the configured fix surface');
      const repro = triage.diagnosis?.reproduction_steps ?? [];
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'insight', {
        rootCause: triage.diagnosis?.one_line_description ?? triage.decisionReason,
        confidence: triage.confidence,
        reason: {
          reason_code: outsideSurface ? 'triage_unfixable' : 'unfixable_infra',
          reason_message: triage.decisionReason,
          // `[].join('; ')` is '', and ?? does not fall back on empty string,
          // so db.ts:1450 would reject the write. Check length, not nullishness.
          remediation: repro.length > 0
            ? `Reproduce with: ${repro.join('; ')}`
            : 'Investigate the named system; no reproduction steps were established.',
        },
      }, job);
      jobsProcessed++;
      logger.info('Investigation: conclusion', { job_id: job.id, duration_ms: durationMs });

    } else if (triage.confidence === 'high') {
      // The diagnosis has to reach the fix job, or Task 9 teaches the fix agent
      // to read a field production never sends. `diagnosis` is a new column on
      // the fix-job payload; add it to updateGroupAndCreateFixJob's `fields`
      // type and to the INSERT alongside rootCause.
      const fixResult = await updateGroupAndCreateFixJob(job.errorGroupId, job.projectId, {
        rootCause: triage.diagnosis?.one_line_description ?? triage.decisionReason,
        diagnosis: triage.diagnosis,
        confidence: triage.confidence,
        platform,
      }, job);
      // ... existing created / kind-gate-refused handling, minus suggestedMitigation
    } else {
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'investigated', {
        rootCause: triage.diagnosis?.one_line_description ?? triage.decisionReason,
        confidence: triage.confidence,
      }, job);
      jobsProcessed++;
    }
```

`not_actionable` must not land on `investigated` at any confidence: that state is approval-eligible at `queries.go:1195`, so a human clicking approve would launch a fix agent at something we said has no local fix.

- [ ] **Step 5: Remove suggestedMitigation from every remaining call site**

```bash
grep -rn "suggestedMitigation" packages/worker/src --include=*.ts | grep -v __tests__
```

Every hit in `index.ts` goes. Leave the field on the `db.ts` signature and on `AgentFixInput` for now; Task 9 removes the consumer.

- [ ] **Step 6: Close the unarchive hole before insight is reachable for errors**

This is an M3 item and it cannot wait, because Task 8 is what makes `insight` reachable for an error group. `queries.go:1839`:

```go
SET status = CASE WHEN kind = 'friction' THEN 'insight'::error_group_status
                  ELSE 'investigated'::error_group_status END,
```

`investigated` is approval-eligible at `queries.go:1191`. So archive a conclusion, unarchive it, and a human can now approve a fix run against something we said has no local fix. That is R8 defeated by a side door.

The other three `insight` consumers stay in M3: the approval gate is already safe (an error at `insight` matches neither branch of the `queries.go:1191` predicate, verified), the `009_regression_lifecycle.sql:16-18` index predicate only affects sweep coverage, and analytics only affects reporting.

There is no `previous_status` column, only `archived_at`, so add one:

```sql
-- part of 010_fix_surface.sql, or its own file if you prefer
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS status_before_archive error_group_status;
```

Half of this shipping alone leaves the hole open in both directions, so both sides are part of this step.

Find every archive-side write first, because there may be more than one:

```bash
grep -rn "'archived'" packages/ingestion/db/*.go
```

Archive must capture the previous status only on a real transition, or re-archiving an already-archived group overwrites it with `archived`:

```sql
UPDATE error_groups
   SET status_before_archive = status,
       status = 'archived',
       archived_at = now(),
       updated_at = now()
 WHERE id = $1 AND project_id = $2 AND status <> 'archived'
```

Unarchive restores it, falling back to today's `CASE` for rows archived before this shipped:

```sql
UPDATE error_groups
   SET status = COALESCE(
         status_before_archive,
         CASE WHEN kind = 'friction' THEN 'insight'::error_group_status
              ELSE 'investigated'::error_group_status END),
       status_before_archive = NULL,
       archived_at = NULL,
       updated_at = now()
 WHERE id = $1 AND project_id = $2 AND status = 'archived'
```

Three Go tests, not one: an error group archived from `insight` unarchives to `insight`; a legacy row with a NULL `status_before_archive` still unarchives to `investigated`; and archiving twice does not overwrite the saved status.

```bash
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
(cd packages/ingestion && go test ./... -run 'Archive|Unarchive' -v)
```

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @opslane/worker test
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
(cd packages/ingestion && go build ./... && go test ./...)
```

Expected: all PASS with **zero** skips. Without those exports the Go storage tests `t.Skip` and report `ok` while roughly 30 tests never run, so read the skip count rather than the pass count. The root `AGENTS.md` explains why.

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/index.ts packages/worker/src/__tests__/index.test.ts packages/ingestion/
git commit -m "feat(worker): route investigations three ways and stop forwarding a suggested fix

An accurate diagnosis with no local fix is now a terminal success rather than a
failure. The investigation's remediation text no longer reaches the fix agent as
an instruction; PR #1297 was written by the classifier and implemented by the
fix agent.

Also deletes a dead getReplayForGroup call that cost a query per investigation
and was never read.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: The fix agent receives a diagnosis and submits one back

**Files:**
- Modify: `packages/worker/src/agent-fix.ts:505-520`
- Modify: `packages/worker/src/harness/tool-bridge.ts:172`
- Test: `packages/worker/src/__tests__/agent-fix.test.ts`
- Test: `packages/worker/src/__tests__/tool-bridge.test.ts`

**Interfaces:**
- Consumes: Task 4's `Diagnosis`, Task 6's `deriveOutcome`.
- Produces: `AgentFixInput.investigation` gains `diagnosis?: Diagnosis | null` and loses `suggestedMitigation`. `give_up` is renamed `submit_diagnosis` and takes the same fields the investigation's tool takes plus `change_counterfactual` and `unknowns`.

- [ ] **Step 1: Write the failing test**

Add to `packages/worker/src/__tests__/agent-fix.test.ts`:

```ts
// buildSystemPrompt (agent-fix.ts:395) is module-private. Export it for tests
// as part of Step 3; it is already the single place the handoff is assembled.
it('never puts a suggested mitigation in the prompt', () => {
  const prompt = buildSystemPrompt({
    errorType: 'TypeError', errorMessage: 'x', stackTrace: 'x',
    investigation: {
      rootCause: 'Null dereference',
      suggestedMitigation: 'Increase FETCH_TIMEOUT to 30000',
    },
  } as unknown as AgentFixInput);
  expect(prompt).not.toContain('Suggested mitigation');
  expect(prompt).not.toContain('30000');
});

it('passes the why-chain and reproduction steps through', () => {
  const prompt = buildSystemPrompt({
    errorType: 'TypeError', errorMessage: 'x', stackTrace: 'x',
    investigation: {
      rootCause: 'Null dereference',
      diagnosis: {
        one_line_description: 'Null dereference rendering the asset list',
        why_chain: ['Render runs before fetch resolves', 'assets is null', 'map throws'],
        reproduction_steps: ['Open the panel on a slow connection'],
        cause_location: 'src/AssetList.tsx:42',
      },
    },
  } as unknown as AgentFixInput);
  expect(prompt).toContain('Render runs before fetch resolves');
  expect(prompt).toContain('Open the panel on a slow connection');
  expect(prompt).toContain('src/AssetList.tsx:42');
});
```

Add to `packages/worker/src/__tests__/tool-bridge.test.ts`:

```ts
// The real export is createToolBridge(sandbox, state, platform) at tool-bridge.ts:28.
function bridge() {
  const state = { gaveUp: false, turnCount: 0, toolCallCount: 0 } as unknown as AgentState;
  return createToolBridge({} as unknown as SandboxRuntime, state, 'javascript');
}

it('exposes submit_diagnosis, not give_up', () => {
  const names = bridge().map((t) => t.name);
  expect(names).toContain('submit_diagnosis');
  expect(names).not.toContain('give_up');
});

it('takes no reason_code from the model', () => {
  const tool = bridge().find((t) => t.name === 'submit_diagnosis')!;
  const props = tool.inputSchema.properties as Record<string, unknown>;
  expect(props['reason_code']).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @opslane/worker test -- agent-fix tool-bridge
```

Expected: FAIL on all four.

- [ ] **Step 3: Rewrite the handoff block**

Replace `agent-fix.ts:505-520`:

```ts
  if (input.investigation) {
    const parts = [`## Prior Investigation\nRoot cause: ${input.investigation.rootCause}`];
    const d = input.investigation.diagnosis;
    if (d) {
      // Model-authored text, and the diagnosis is partly quoted from customer
      // error data. Fence it like every other untrusted block in this prompt.
      const chain = d.why_chain.map((w, i) => `${i + 1}. ${w}`).join('\n');
      const repro = d.reproduction_steps.map((x) => `- ${x}`).join('\n');
      parts.push(
        `Cause location: ${d.cause_location}\n` +
        `<untrusted_data>\n` +
        `Why it happened:\n${chain}\n` +
        (repro ? `Reproduction:\n${repro}\n` : '') +
        `</untrusted_data>`,
      );
    }
    if (input.investigation.findings) {
      parts.push(`Findings:\n<untrusted_data>\n${input.investigation.findings}\n</untrusted_data>`);
    }
    if (input.investigation.filesRead && input.investigation.filesRead.length > 0) {
      const uniqueFiles = [...new Set(input.investigation.filesRead)];
      parts.push(`Files already examined: ${uniqueFiles.join(', ')}\nDo NOT re-read these files unless you need to edit them.`);
    }
    if (input.investigation.guidance) {
      parts.push(`User guidance:\n<untrusted_user_data>\n${input.investigation.guidance}\n</untrusted_user_data>`);
    }
    sections.push(parts.join('\n'));
  }
```

The `suggestedMitigation` branch is gone. Remove the field from `AgentFixInput`.

- [ ] **Step 4: Declare the new AgentState field**

`AgentState` is at `packages/worker/src/harness/types.ts:39`. Add one field alongside the existing `gaveUp` and `giveUpReason`:

```ts
  gaveUp: boolean;
  giveUpReason?: { reason_code: string; reason_message: string; remediation: string };
  /** Raw submit_diagnosis input. The caller derives the outcome and fills giveUpReason. */
  submittedDiagnosis?: Record<string, unknown>;
```

Keep `giveUpReason`: it is what `db.ts:1450` reads, and it is still populated, just derived rather than model-chosen.

- [ ] **Step 5: Replace give_up with submit_diagnosis**

In `tool-bridge.ts:172`, keep the `state.gaveUp` flag, but take diagnosis fields instead of a reason code. `createToolBridge` also needs to export `buildSystemPrompt` from `agent-fix.ts` for the tests above:

```ts
    {
      name: 'submit_diagnosis',
      description:
        'Call this when you cannot fix the error in this repository. Report what you found ' +
        'after reading the code. Do not choose what happens next.',
      inputSchema: {
        type: 'object',
        properties: {
          one_line_description: { type: 'string', description: 'What caused the error, in under 30 words' },
          why_chain: { type: 'array', items: { type: 'string' }, description: 'Ordered why-statements, each under 15 words' },
          reproduction_steps: { type: 'array', items: { type: 'string' }, description: 'Steps that reproduce it, each under 15 words' },
          cause_location: { type: 'string', description: 'path/to/file.ts:42, or the external system' },
          change_counterfactual: { type: 'string', description: 'What change here would remove the cause, or why none would' },
          unknowns: { type: 'array', items: { type: 'string' }, description: 'What you could not establish' },
        },
        required: ['one_line_description', 'why_chain', 'reproduction_steps', 'cause_location', 'change_counterfactual'],
      },
      execute: async (input) => {
        state.gaveUp = true;
        state.submittedDiagnosis = input;
        return 'Acknowledged. Ending agent loop.';
      },
    },
```

The first four fields are exactly `submitDiagnosisTool`'s, so `parseDiagnosis` accepts the submission unchanged. Without `one_line_description` and `reproduction_steps` the raw input is not a `Diagnosis` and cannot be passed to `deriveOutcome` at all.

- [ ] **Step 6: Implement the caller that derives the outcome and fills giveUpReason**

The bridge sets `state.submittedDiagnosis` and nothing else. `runAgentFix` has to turn that into a terminal result, and `db.ts:1450` throws if any of the three reason fields is empty, so this cannot be left implicit. In `runAgentFix`, where `state.gaveUp` is currently handled:

```ts
if (state.gaveUp) {
  const diagnosis = parseDiagnosis(state.submittedDiagnosis ?? {});
  const decision = deriveOutcome(diagnosis, input.fixSurface ?? { globs: null }, (p) => {
    try { return statSync(join(repoRoot, p)).isFile(); } catch { return false; }
  });

  const code: ReasonCode =
    decision.outcome === 'not_actionable'
      ? (decision.reason.includes('outside the configured fix surface') ? 'triage_unfixable' : 'unfixable_infra')
      : 'insufficient_context';

  const repro = diagnosis?.reproduction_steps ?? [];
  state.giveUpReason = buildReason(
    code,
    decision.reason,
    repro.length > 0 ? `Reproduce with: ${repro.join('; ')}` : 'Investigate the named cause manually.',
    platform,
  );
}
```

- [ ] **Step 6b: Actually supply the surface to the fix agent**

Adding the optional field is not enough: if nothing passes it, production runs against `{ globs: null }`, the fix agent can never conclude "outside the surface", and it silently disagrees with the investigation that sent it there.

Add `fixSurface?: FixSurface` to `AgentFixInput` in `agent-fix.ts`, then in `processFixJob` (`index.ts:787`) load and pass it:

```ts
    const fixSurface = await db.loadFixSurface(job.projectId);
    // ... and add `fixSurface` to the object handed to runAgentFix / runFixPipeline
```

`pipeline.ts:115` and `:321` also thread `AgentFixInput` fields through; add it in both. Verify nothing is left on the default:

```bash
grep -rn "fixSurface" packages/worker/src --include=*.ts
```

Expected: the type, the `processFixJob` load, both pipeline hops, and the `runAgentFix` consumer. If `processFixJob` is missing, the field is decorative.

Update the prompt text at `agent-fix.ts:411` and `:430` that tells the agent to call `give_up`, and the `## When to Give Up Early` heading at `:423`.

- [ ] **Step 7: Update all remaining references**

```bash
grep -rn "give_up\|gaveUp\|giveUpReason" packages/worker/src eval/src --include=*.ts
```

Search `eval/src` too: `pipeline-caller.ts:103` constructs input for `runAgentFix`. It does not set `suggestedMitigation` today (verified), so removing the field is safe, but confirm rather than assume.

- [ ] **Step 8: Run the full suite**

```bash
pnpm --filter @opslane/worker test
pnpm --filter @opslane/worker build
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/worker/src/agent-fix.ts packages/worker/src/harness/tool-bridge.ts packages/worker/src/harness/types.ts packages/worker/src/index.ts packages/worker/src/pipeline.ts packages/worker/src/__tests__/
git commit -m "feat(worker): the fix agent takes a diagnosis and submits one back

give_up asked the model for a reason_code, and that code was the routing
decision: a one-line assertion and a fully evidenced decline routed identically.
It now reports what it found and the outcome is derived.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Persist the decision as an immutable record

Status is mutable. The decision is not, and every measurement in M4 has to read the decision rather than the current status.

**Files:**
- Create: `packages/ingestion/db/migrations/011_diagnosis_decisions.sql`
- Modify: `packages/worker/src/db.ts`
- Test: `packages/worker/src/__tests__/db.test.ts`

**Interfaces:**
- Consumes: Task 7's `InvestigationResult`.
- Produces: `recordDiagnosisDecision(errorGroupId: string, projectId: string, row: DecisionRow): Promise<void>`.

- [ ] **Step 1: Write the migration**

Create `packages/ingestion/db/migrations/011_diagnosis_decisions.sql`:

```sql
-- 011_diagnosis_decisions.sql, the record of what we concluded.
-- Append-only after 001-010 (010 is fix_surface). IDEMPOTENCY IS MANDATORY: run-migrations.sh
-- re-applies every file on every start.
--
-- Status on error_groups is mutable (archive, unarchive, human correction).
-- Merge-rate analysis has to join on what we decided at the time, not on where
-- the incident later ended up, so the decision gets its own append-only table.
CREATE TABLE IF NOT EXISTS diagnosis_decisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_group_id UUID NOT NULL REFERENCES error_groups(id),
  project_id     UUID NOT NULL REFERENCES projects(id),
  job_id         UUID REFERENCES error_group_jobs(id),
  outcome        TEXT NOT NULL CHECK (outcome IN ('code_fix','not_actionable','needs_more_context')),
  decision_reason TEXT NOT NULL,
  cause_location TEXT,
  diagnosis      JSONB,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One decision per job. A retried job must not leave two rows, or every
-- merge-rate denominator that counts decisions is wrong.
CREATE UNIQUE INDEX IF NOT EXISTS uq_diagnosis_decisions_job
  ON diagnosis_decisions(job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_diagnosis_decisions_group
  ON diagnosis_decisions(error_group_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnosis_decisions_project
  ON diagnosis_decisions(project_id, decided_at DESC);
```

- [ ] **Step 2: Write the failing test**

Add to `packages/worker/src/__tests__/db.test.ts`, following the existing `DATABASE_URL`-gated style in that file:

```ts
it('records a decision and never overwrites an earlier one', async () => {
  const { groupId, projectId } = await seedGroup();

  const base = { diagnosis: null, model: 'claude-sonnet-4-6', promptVersion: 'diagnosis-v1' };

  // Two different jobs on one group: both rows survive.
  await recordDiagnosisDecision(groupId, projectId, {
    ...base, jobId: jobA,
    outcome: 'not_actionable',
    decisionReason: 'The cause is outside this codebase',
    causeLocation: 'GET /api/assets/search (remote service)',
  });
  await recordDiagnosisDecision(groupId, projectId, {
    ...base, jobId: jobB,
    outcome: 'code_fix',
    decisionReason: 'The cause is at src/App.vue:42',
    causeLocation: 'src/App.vue:42',
  });

  const { rows } = await getPool().query(
    'SELECT outcome FROM diagnosis_decisions WHERE error_group_id = $1 ORDER BY decided_at',
    [groupId],
  );
  expect(rows.map((r) => r.outcome)).toEqual(['not_actionable', 'code_fix']);
});

it('is idempotent when the same job is retried', async () => {
  const { groupId, projectId, jobId } = await seedGroupAndJob();
  const row = {
    jobId, outcome: 'code_fix' as const, decisionReason: 'r',
    causeLocation: 'src/App.vue:42', diagnosis: null,
    model: 'claude-sonnet-4-6', promptVersion: 'diagnosis-v1',
  };

  await recordDiagnosisDecision(groupId, projectId, row);
  await recordDiagnosisDecision(groupId, projectId, row);

  const { rows } = await getPool().query(
    'SELECT count(*)::int AS n FROM diagnosis_decisions WHERE job_id = $1', [jobId],
  );
  expect(rows[0]!.n).toBe(1);
});
```

- [ ] **Step 3: Run the test with a database**

```bash
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
(cd packages/ingestion && ./db/run-migrations.sh)
pnpm --filter @opslane/worker test -- db
```

Expected: FAIL, "recordDiagnosisDecision is not exported". If the suite reports **skipped** rather than failed, `DATABASE_URL` did not reach it: fix that before continuing, because a skipped suite proves nothing.

- [ ] **Step 4: Implement it**

Add to `packages/worker/src/db.ts`:

```ts
export interface DecisionRow {
  outcome: DiagnosisOutcome;
  decisionReason: string;
  causeLocation?: string | null;
  diagnosis: Diagnosis | null;
  model: string;
  promptVersion: string;
  jobId?: string | null;
}

/**
 * Append-only by convention and by how we write it, not by database privilege:
 * nothing revokes UPDATE or DELETE on this table. It is "immutable" in the
 * sense that this code never rewrites a row, which is what the measurement
 * needs. A second look at an incident is a second row.
 *
 * ON CONFLICT DO NOTHING makes a retried job idempotent rather than duplicated.
 */
export async function recordDiagnosisDecision(
  errorGroupId: string,
  projectId: string,
  row: DecisionRow,
): Promise<void> {
  await getPool().query(
    `INSERT INTO diagnosis_decisions
       (error_group_id, project_id, job_id, outcome, decision_reason, cause_location, diagnosis, model, prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING`,
    [
      errorGroupId, projectId, row.jobId ?? null, row.outcome, row.decisionReason,
      row.causeLocation ?? null, row.diagnosis === null ? null : JSON.stringify(row.diagnosis),
      row.model, row.promptVersion,
    ],
  );
}
```

- [ ] **Step 5: Call it from every routing branch**

Both writes go in **one transaction**. Sequencing them either way loses data: record first and a failed status write leaves a decision for an incident that never moved; record second and a crash between them loses the decision permanently, because the status transition has already happened and a retry will not repeat it. The unique index stops duplicates, not this.

`updateGroupInvestigation` and `updateGroupAndCreateFixJob` already open their own transactions and take a `JobLease`. Add an optional `decision?: DecisionRow` parameter to both and INSERT inside the existing transaction, rather than calling `recordDiagnosisDecision` separately from `index.ts`. Keep the standalone export for tests.

In `index.ts`, pass the decision alongside the fields at each of the four branches from Task 8:

```ts
    const decision = {
      outcome: triage.outcome,
      decisionReason: triage.decisionReason,
      causeLocation: triage.diagnosis?.cause_location ?? null,
      diagnosis: triage.diagnosis,
      model: process.env['INVESTIGATION_MODEL'] ?? 'claude-sonnet-4-6',
      promptVersion: 'diagnosis-v1',
      jobId: job.id,
    };
    // then: updateGroupInvestigation(..., { ...fields, decision }, job)
    //   or: updateGroupAndCreateFixJob(..., { ...fields, decision }, job)
```

- [ ] **Step 6: Run the tests and confirm nothing skipped**

```bash
pnpm --filter @opslane/worker test 2>&1 | tail -20
```

Expected: PASS with a skip count of 0 for the db suite.

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/db/migrations/011_diagnosis_decisions.sql packages/worker/src/db.ts packages/worker/src/index.ts packages/worker/src/__tests__/db.test.ts
git commit -m "feat: persist the diagnosis decision as an append-only record

Status is mutable; the decision is not. Merge-rate analysis has to join on what
we concluded at the time rather than where the incident later ended up.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Run the hard fixtures through the investigation

Task 3 creates six fixtures and nothing runs them. `eval/src/pipeline-caller.ts:103` calls `runAgentFix` directly, so the harness has never exercised `investigateError`, the derivation, or the routing. Without this task the fixtures are dead files and M0's "re-run the arms" has no runner.

**Files:**
- Create: `eval/src/investigation-runner.ts`
- Create: `eval/src/__tests__/investigation-runner.test.ts`
- Modify: `eval/package.json`

**Interfaces:**
- Consumes: `loadCase` (Task 2), the six fixtures (Task 3), `investigateError` (Task 7).
- Produces: `runInvestigationCase(c: EvalCase, repoPath: string, surface: FixSurface, trials: number): Promise<InvestigationCaseResult>` where `interface InvestigationCaseResult { id: string; expected: 'fix_pr' | 'needs_human' | 'conclusion'; got: DiagnosisOutcome[]; passes: number; trials: number }`.

- [ ] **Step 1: Write the failing test**

Create `eval/src/__tests__/investigation-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { expectedToOutcome, scoreTrials } from '../investigation-runner.js';

describe('expectedToOutcome', () => {
  it('maps the three fixture labels onto the three outcomes', () => {
    expect(expectedToOutcome('fix_pr')).toBe('code_fix');
    expect(expectedToOutcome('conclusion')).toBe('not_actionable');
    expect(expectedToOutcome('needs_human')).toBe('needs_more_context');
  });
});

describe('scoreTrials', () => {
  it('counts only exact outcome matches', () => {
    expect(scoreTrials('conclusion', ['not_actionable', 'not_actionable', 'code_fix']))
      .toEqual({ passes: 2, trials: 3 });
  });

  it('scores zero when nothing matches', () => {
    expect(scoreTrials('fix_pr', ['not_actionable', 'needs_more_context']))
      .toEqual({ passes: 0, trials: 2 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @opslane/eval test -- investigation-runner
```

Expected: FAIL, "Failed to resolve import ../investigation-runner.js".

- [ ] **Step 3: Write the runner**

Create `eval/src/investigation-runner.ts`:

```ts
import type { DiagnosisOutcome } from '@opslane/shared';
// Import from the worker's BUILT output, never its source. Reaching into
// ../../packages/worker/src drags files outside eval's rootDir into its
// program and reproduces the exact TS6059 failure Task 1 deletes.
// Run `pnpm --filter @opslane/worker build` before the eval build.
import type { FixSurface } from '@opslane/worker/dist/fix-surface.js';
import { investigateError } from '@opslane/worker/dist/investigate.js';
import type { EvalCase } from './types.js';

export type ExpectedOutcome = 'fix_pr' | 'needs_human' | 'conclusion';

export function expectedToOutcome(e: ExpectedOutcome): DiagnosisOutcome {
  switch (e) {
    case 'fix_pr': return 'code_fix';
    case 'conclusion': return 'not_actionable';
    case 'needs_human': return 'needs_more_context';
  }
}

export function scoreTrials(expected: ExpectedOutcome, got: DiagnosisOutcome[]): { passes: number; trials: number } {
  const want = expectedToOutcome(expected);
  return { passes: got.filter((g) => g === want).length, trials: got.length };
}

export interface InvestigationCaseResult {
  id: string;
  expected: ExpectedOutcome;
  got: DiagnosisOutcome[];
  passes: number;
  trials: number;
}

/**
 * Runs one fixture through the real investigation N times. N > 1 on purpose:
 * identical configurations scored 7/8, 4/8 and 3/8 across three runs during the
 * spikes, so a single pass says almost nothing.
 */
export async function runInvestigationCase(
  c: EvalCase,
  repoPath: string,
  surface: FixSurface,
  trials: number,
): Promise<InvestigationCaseResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required to run investigation cases');

  const got: DiagnosisOutcome[] = [];
  for (let i = 0; i < trials; i++) {
    const r = await investigateError(apiKey, {
      platform: c.error_event.platform,
      errorType: c.error_event.error.type,
      title: c.error_event.error.message,
      errorMessage: c.error_event.error.message,
      stackTrace: c.error_event.error.stack,
      resolvedStackTrace: null,
      breadcrumbs: JSON.stringify(c.error_event.breadcrumbs),
    }, repoPath, surface);
    got.push(r.outcome);
  }

  const expected = c.expected.outcome as ExpectedOutcome;
  return { id: c.id, expected, ...scoreTrials(expected, got), got };
}
```

- [ ] **Step 4: Make the worker importable from eval**

Do this *before* running the test: `investigation-runner.ts` imports `@opslane/worker/dist/...`, which does not resolve until the dependency and the export map exist.

`@opslane/worker` is not currently a dependency of `eval`, and it exports nothing. Add it as a workspace dependency in `eval/package.json`:

```json
    "@opslane/worker": "workspace:*"
```

and add an `exports` map to `packages/worker/package.json` so `dist/` is reachable:

```json
  "exports": { "./dist/*": "./dist/*" }
```

Then rebuild from a clean state, because `dist/` is gitignored but survives between runs and a stale one proves nothing:

```bash
rm -rf packages/worker/dist eval/dist
pnpm install
pnpm --filter @opslane/worker build && pnpm --filter @opslane/eval build
```

`pnpm install` rewrites `pnpm-lock.yaml`. Stage it in this task's commit or Task 12's `pnpm install --frozen-lockfile` fails on a clean checkout.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @opslane/eval test -- investigation-runner
```

Expected: 3 PASS.

- [ ] **Step 6: Add the script**

In `eval/package.json`, add to `scripts`:

```json
    "eval:investigation": "tsx src/investigation-runner-cli.ts"
```

Create `eval/src/investigation-runner-cli.ts` reading `--trials` (default 6), `--repo` and `--surface`, iterating `eval/cases/hard-*`, and printing a table of `id | expected | passes/trials`.

- [ ] **Step 7: Run the hard set against the real customer clone**

```bash
export ANTHROPIC_API_KEY=...
pnpm --filter @opslane/eval eval:investigation -- --trials 6 --repo /path/to/asset-management-jira --surface 'client/**'
```

Pin the clone to a commit first and record the SHA next to the table, or the numbers are not reproducible:

```bash
git -C /path/to/asset-management-jira rev-parse HEAD
```

Record the table in `docs/design/incident-conclusions.md`, replacing the "What was measured" numbers, which were taken with the old schema. **H4 and its control must disagree.** If both land on the same outcome the fixture pair does not discriminate and Task 3 is not finished.

Scoring the outcome alone is a weak bar and this task does not pretend otherwise: a fabricated but in-surface filename passes a `fix_pr` fixture. Also print `cause_location` per trial and check it by eye against `expected.rca_file`. Automating that check is M4's rubric work.

- [ ] **Step 8: Commit**

```bash
git add eval/src/investigation-runner.ts eval/src/investigation-runner-cli.ts eval/src/__tests__/investigation-runner.test.ts eval/package.json packages/worker/package.json pnpm-lock.yaml docs/design/incident-conclusions.md
git commit -m "feat(eval): run fixtures through the real investigation, repeatedly

The harness has only ever called runAgentFix, so the investigation, the
derivation and the routing were never exercised by any eval. Trials default to
6 because identical configurations scored 7/8, 4/8 and 3/8 across three runs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Prove the PR #1297 case never becomes a code change

**Files:**
- Test: `packages/worker/src/__tests__/pr1297.integration.test.ts` (create)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing. This is the gate.

This is not a full pipeline run: the model is mocked, so it exercises the schema, the derivation and the surface, but not routing, persistence or fix-job creation. Task 8's tests cover routing. A live smoke from event to terminal incident is M2's exit criterion, and the root `AGENTS.md` describes how to run one.

- [ ] **Step 1: Write the end-to-end assertion**

Create `packages/worker/src/__tests__/pr1297.integration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Vitest runs with cwd at packages/worker, so a repo-relative fixture path and
// a bare process.cwd() both resolve wrong. __dirname does not exist under ESM,
// so anchor via import.meta.url. From packages/worker/src/__tests__ the repo
// root is four levels up.
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } })),
}));

import { investigateError } from '../investigate.js';

describe('PR #1297: a slow backend never becomes a code change', () => {
  beforeEach(() => mockMessagesCreate.mockReset());

  it('terminates as a conclusion naming the endpoint', async () => {
    const fixture = JSON.parse(readFileSync(resolve(REPO_ROOT, 'eval/cases/hard-h1-timeout/case.json'), 'utf8'));

    mockMessagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use', id: 'd1', name: 'submit_diagnosis',
        input: {
          one_line_description: 'The asset search endpoint exceeded its 10 second budget',
          why_chain: [
            'User types a query in the asset panel',
            'Client calls GET /issue-context/api/assets/search',
            'The server does not respond within 10 seconds',
            'AbortSignal.timeout fires and rejects the fetch',
          ],
          reproduction_steps: ['Open the asset panel', 'Search a term matching many assets'],
          cause_location: 'GET /issue-context/api/assets/search (remote service)',
        },
      }],
      usage: { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const result = await investigateError('test-key', {
      errorType: fixture.error_event.error.type,
      title: fixture.error_event.error.message,
      errorMessage: fixture.error_event.error.message,
      stackTrace: fixture.error_event.error.stack,
      resolvedStackTrace: null,
      breadcrumbs: JSON.stringify(fixture.error_event.breadcrumbs),
    }, REPO_ROOT, { globs: ['client/**'] });

    expect(result.outcome).toBe('not_actionable');
    expect(result.fixable).toBe(false);
    expect(result.decisionReason).toContain('/issue-context/api/assets/search');
    expect(result.diagnosis?.why_chain.length).toBeGreaterThanOrEqual(3);
  });

  it('still opens a fix for a real local defect', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use', id: 'd2', name: 'submit_diagnosis',
        input: {
          one_line_description: 'Null dereference rendering the asset list',
          why_chain: ['Render runs before the fetch resolves', 'assets is null', 'map throws'],
          reproduction_steps: ['Open the panel on a throttled connection'],
          cause_location: 'packages/worker/src/investigate.ts:1',
        },
      }],
      usage: { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const result = await investigateError('test-key', {
      errorType: 'TypeError', title: 'x', errorMessage: 'x', stackTrace: 'x',
      resolvedStackTrace: null, breadcrumbs: '[]',
    }, REPO_ROOT, { globs: ['packages/**'] });

    expect(result.outcome).toBe('code_fix');
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter @opslane/worker test -- pr1297
```

Expected: 2 PASS.

- [ ] **Step 3: Run the full repository gate**

```bash
# Requires Task 11 to have committed pnpm-lock.yaml after adding the
# @opslane/worker workspace dependency, or this fails immediately.
pnpm install --frozen-lockfile
pnpm -r build
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Expected: all green. Read the **skip** count, not the pass count: database-gated suites report skipped rather than failed when `DATABASE_URL` is unset, so export it first.

- [ ] **Step 4: Rebuild with dists removed, to prove a clean checkout works**

```bash
find . -name dist -type d -not -path '*/node_modules/*' -exec rm -rf {} +
pnpm -r build
```

Expected: PASS. `dist/` is gitignored but survives between runs, so a local build otherwise proves nothing about a fresh clone.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/__tests__/pr1297.integration.test.ts
git commit -m "test(worker): PR #1297 terminates as a conclusion, not a timeout bump

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Out of scope for this plan

Each gets its own plan, and none blocks the above.

**M1.5, prompt borrowings.** Word limits enforced on output, PostHog's two directional tie-breaks, the already-in-flight check via `gh`, a budget stated to the agent in tool calls with a partial diagnosis to land on.

**M2, context.** The `debug-images.ts:36` source-map bug (needs an SDK release), replay evidence reaching the investigation, breadcrumb repeat-collapsing before the 1000-character truncation, the deterministic `failing_request` extractor, pre-loading stack-trace files for the investigation, reading `AGENTS.md`, and query-string redaction.

**M3, consumers.** The four places that assume `insight` implies `kind = 'friction'`: `queries.go:1839` unarchive, the `009_regression_lifecycle.sql:16-18` index predicate, the `queries.go:1191` approval gate, and status-grouped analytics.

**M4, measurement.** Joining `diagnosis_decisions` to `pr_outcomes`, PR open rate next to merge rate, deduplicating the reopen double-count at `queries.go:2960`, and the hand-written rubric from closed PRs.

## Known gaps in this plan

**Confidence is a proxy, not a measurement.** `deriveConfidence` (Task 6) answers `high` when the chain has three or more steps, reproduction steps exist, and the citation carries a line number. Those correlate with a careful run; they do not measure whether the diagnosis is right. A confidently wrong diagnosis with a well-formed chain still opens a PR unattended. An earlier draft hardcoded `high`, which was worse: every parsed citation became an unattended PR regardless of evidence, and Task 8's `investigated` branch was unreachable dead code that looked live.

**The model still influences routing through formatting.** It cannot name an outcome, but `cause_location` is free text, and how it writes that text decides the route. The mitigation is that vagueness now costs it: an unrecognised location routes to `needs_more_context`, a failure, so declining to be specific is not a way to reach a conclusion. What remains is that a model naming a plausible in-surface file it never read reaches `code_fix`. The file-exists check catches invented paths; it does not catch a real file cited for the wrong reason. M4's rubric is what bounds that.

**The judge is unchanged.** `judgeDiff` passed the PR #1297 diff 5 times out of 5 while writing "may temporarily mask" in its own reasoning. This plan removes the two upstream causes and leaves the judge alone, because raising its threshold rests on one genuine-fix diff over five trials.

**One M3 item is pulled forward and three are not.** Task 8 Step 6 fixes unarchive because Task 8 is what makes `insight` reachable for errors. The `009_regression_lifecycle.sql` index predicate, the approval-gate test, and status-grouped analytics stay in M3. The first means a recurring external outage drops out of the inactivity sweep, which is a real if quiet loss of tracking for as long as M3 waits.
