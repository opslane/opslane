# Langfuse Cost Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sending Langfuse a trace for every job that never calls a model, and make the Postgres usage ledger complete enough to read cost from.

**Architecture:** A typed policy table keyed on the closed `JobType` union decides whether a job is traced; `withJobTrace` consults it and creates no span for non-model jobs. Separately, six model call sites that record nothing are threaded with job context and routed through one `PhaseMeter` that aggregates usage per phase and model, then inserts once.

**Tech Stack:** Node 22, TypeScript (ESM, strict), Vitest, OpenTelemetry Node SDK, `@langfuse/otel`, `@arizeai/openinference-instrumentation-anthropic`, `@anthropic-ai/sdk` 0.120.0, Playwright, Postgres via `pg`.

**Spec:** No separate spec. This plan is the decision record from the 2026-09-03 investigation, grill session, and two Codex review rounds.

## Problem

Langfuse suspended ingestion on 2026-08-17. The OTLP endpoint returns HTTP 403 with `{"message":"Ingestion suspended: Usage threshold exceeded. Please upgrade your plan.","error":"ForbiddenError"}`. The read API still returns 200 on the same credentials, so this is quota, not authentication.

August sent 142,852 traces and 146,423 observations, 289,275 billable units, against 50,000 on Hobby and 100,000 on Core.

`processJob` (`packages/worker/src/index.ts:298`) wraps every claimed job in `withJobTrace` (`packages/worker/src/tracing.ts:277`). Measured production volume for the one production customer:

| Job type | Jobs/day | Calls a model |
| --- | --- | --- |
| `session_analysis` | 15,592 | no |
| `session_narrate` | 330 | yes |
| `session_verify_frames` | 271 | yes |
| `stack_resolve` | 110 | no |
| `investigate` | 45 | yes |
| `issue_inquiry` | 4 | yes |
| `digest_write` | 3 | yes |
| `route_map` | 1 | yes |

About 97% of traces described jobs that never called a model. Observations appear only when the Anthropic SDK prototype is patched by `AnthropicInstrumentation`, so those traces carry a bare root span; the August ratio of 1.02 observations per trace confirms it.

The ledger undercounts separately. `runReadOnlyAgentSdk` (`packages/worker/src/harness/sdk-agent.ts:337`) sums per-assistant-message usage and never reads the `result` message's cumulative usage, so investigations that wrote 4,000 to 13,000 character diagnoses recorded 14 to 108 output tokens on 2026-09-02. Six model call sites write nothing at all.

## Global Constraints

- ESM and strict TypeScript. `unknown` plus narrowing, never `any`.
- Vitest tests colocated in `__tests__` directories.
- Verification: `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test`.
- `job_usage` is insert-only, enforced by triggers rejecting update, delete and truncate (`packages/ingestion/db/migrations/043_job_usage_ledger.sql:42-52`). Inserts remain legal. Never `UPDATE` it.
- `job_usage.phase` is unrestricted non-empty text (`043_job_usage_ledger.sql:11`), so new phases need no migration. This is deliberate per `docs/adr/0001-postgres-usage-ledger.md`.
- No migration is in scope.
- Preserve terminal-status and lease contracts. Fix implementation or test setup rather than weakening assertions.

## Decisions, with reasoning

- **Policy table, not a list inside `withJobTrace`.** A bare allowlist leaves a future job type untraced by omission. `JobType` (`shared/src/types.ts:554`) is a closed union of 13 members, so an exhaustive `Record<JobType, TracePolicy>` makes an unhandled member a compile error.
- **`error_fix` is traced.** Despite the name it dispatches to the investigation path (`packages/worker/src/index.ts:474`).
- **`fix` stays fully traced permanently.** `score_sync` loads the fix job's `trace_url` and throws without it (`packages/worker/src/score-sync.ts:36-39`).
- **No sampling.** After the gate one customer projects to roughly 77,000 units a month, inside Core's 100,000. No `sampled` variant is declared either: an unreachable mode that `withJobTrace` would silently treat as `full` reads as support that does not exist.
- **No output-token ceiling change.** Billing follows generated tokens, not `max_tokens`. Measured output averages 3,078 with p99 at 10,815, so the 512 to 1,024 range suggested in review would truncate most narratives, and a truncated narrative fails validation (`packages/worker/src/narrative/job.ts:86`).
- **No ledger key migration.** `PhaseMeter` aggregates in memory and inserts once per phase and model, delivering the aggregation ADR 0001 already claims without touching the immutability trigger.
- **Prompt caching was investigated and dropped.** See the Dropped section.

## Dropped after investigation: prompt caching

The first draft added `cache_control` to the narrate and verify system prompts for an estimated $1/day. Measurement killed it.

| Prompt | Characters | Estimated tokens |
| --- | --- | --- |
| `buildVerifyPrompt()` (`packages/worker/src/narrative/verify.ts:126`) | 1,018 | about 275 |
| `buildNarrativePrompt()` system string (`packages/worker/src/narrative/prompt.ts:24`) | 1,587 | about 429 |

The minimum cacheable prefix on Claude Sonnet 5 is 1,024 tokens. Below it, requests are processed without caching and no error is returned. Both prompts are well under, so `cache_control` would have been a silent no-op and the saving was imaginary.

There is nothing else worth caching in either call. The bulk of verification input is six per-session screenshots and the bulk of narration input is a per-session timeline; neither is stable across calls.

Two consequences that would have been bugs had this shipped: `packages/worker/src/narrative/job.ts:69-74` hardcodes `cacheRead: 0, cacheWrite: 0` into the usage it ledgers, and `finalizeVerification` (`packages/worker/src/db.ts:3851-3852`) adds only input and output tokens to `session_narratives` with no cache columns at all. Enabling caching without changing both would have under-reported cost.

## Non-goals

- Sampling, Haiku model substitution, and narrowing the narrate eligibility gate. The last two need an eval set that does not exist.
- The late-chunk analysis race (`packages/ingestion/db/sessions.go:373`). Real in code, zero occurrences in production since 2026-08-25, because sessions close after 30 minutes idle (`packages/ingestion/retention/retention.go:19`) while chunk scrubbing completes in 170 seconds worst case. Task 10 files it.
- The 267 chunks stuck at the 5-attempt scrub ceiling (`packages/ingestion/db/sessions.go:306`). Real evidence loss, different subsystem. Task 10 files it.
- Passing the budget ceiling into the Agent SDK options.
- Recovering usage on the `state.fatal` path in `sdk-agent.ts:402`, which throws before returning usage. Pre-existing loss, noted in Risks.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/worker/src/trace-policy.ts` (new) | The exhaustive `Record<JobType, TracePolicy>` and its lookup. No OTel imports, so it tests standalone. |
| `packages/worker/src/tracing.ts` (modify) | `withJobTrace` takes the job, consults the policy, records `job.type`. Owns export-health state. |
| `packages/worker/src/tracing-diag.ts` (modify) | `createDiagLogger` gains an `onExportError` callback. |
| `packages/worker/src/index.ts` (modify) | Passes the job to `withJobTrace`; threads job context into digest and visual analysis; exposes export health. |
| `packages/worker/src/metered.ts` (new) | `PhaseMeter`: aggregate per phase and model, insert once. |
| `packages/worker/src/harness/sdk-agent.ts` (modify) | Reads cumulative usage from the `result` message, field by field. |
| `packages/worker/src/harness/diff-judge.ts` (modify) | Returns usage alongside its verdict. |
| `packages/worker/src/agent-fix.ts` (modify) | `generateFixNarrative` returns usage; both sites metered under a `finally`. |
| `packages/worker/src/digest-writer/job.ts` (modify) | Accepts job context so its model call can be metered. |
| `packages/worker/src/visual-analysis.ts` (modify) | Returns usage so its caller can meter it. |
| `packages/worker/src/narrative/verify.ts` (modify) | Writes the ledger row that frame verification never wrote. |
| `packages/worker/src/narrative/frames/capture.ts` (modify) | Default capture viewport. |

---

### Task 1: Trace policy table

**Files:**
- Create: `packages/worker/src/trace-policy.ts`
- Test: `packages/worker/src/__tests__/trace-policy.test.ts`

**Interfaces:**
- Consumes: `JobType` from `@opslane/shared`.
- Produces: `type TracePolicy = { mode: 'off' } | { mode: 'full' }` and `tracePolicyFor(jobType: JobType): TracePolicy`. Task 2 calls `tracePolicyFor`.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/trace-policy.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { TRACE_POLICY, tracePolicyFor } from '../trace-policy.js';

describe('tracePolicyFor', () => {
  it('turns tracing off for the four job types that never call a model', () => {
    expect(tracePolicyFor('session_analysis')).toEqual({ mode: 'off' });
    expect(tracePolicyFor('stack_resolve')).toEqual({ mode: 'off' });
    expect(tracePolicyFor('ci_watch')).toEqual({ mode: 'off' });
    expect(tracePolicyFor('score_sync')).toEqual({ mode: 'off' });
  });

  it('traces error_fix, which dispatches to the investigation path despite its name', () => {
    expect(tracePolicyFor('error_fix')).toEqual({ mode: 'full' });
  });

  it('keeps fix at full tracing because score_sync reads its trace_url', () => {
    expect(tracePolicyFor('fix')).toEqual({ mode: 'full' });
  });

  it('traces every other model-calling job type', () => {
    for (const jobType of [
      'investigate', 'session_narrate', 'session_verify_frames',
      'issue_inquiry', 'product_context', 'route_map', 'digest_write',
    ] as const) {
      expect(tracePolicyFor(jobType)).toEqual({ mode: 'full' });
    }
  });

  it('defaults an unknown job type to full tracing rather than silently dropping it', () => {
    expect(tracePolicyFor('not_a_real_job' as never)).toEqual({ mode: 'full' });
  });

  it('covers every member of the JobType union', () => {
    expect(Object.keys(TRACE_POLICY)).toHaveLength(13);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/trace-policy.test.ts`
Expected: FAIL, cannot resolve `../trace-policy.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/worker/src/trace-policy.ts`:

```typescript
import type { JobType } from '@opslane/shared';

/**
 * Whether a job's work is worth a Langfuse trace.
 *
 * Two modes only. A `sampled` variant was considered and left out: nothing
 * would produce it, `withJobTrace` would treat it as `full`, and a variant the
 * consumer silently mishandles is worse than no variant, because it reads as
 * support that does not exist. Adding sampling later means adding the mode and
 * the branch that honours it together, which is one small edit in one file.
 */
export type TracePolicy = { mode: 'off' } | { mode: 'full' };

const OFF: TracePolicy = { mode: 'off' };
const FULL: TracePolicy = { mode: 'full' };

/**
 * Exhaustive by construction. `satisfies Record<JobType, TracePolicy>` turns a
 * new member of the JobType union into a compile error here, which is the
 * point: the policy for a new job type must be a decision, not an omission.
 *
 * The four OFF entries never call a model. `session_analysis` is the
 * rule-based friction analyzer, `stack_resolve` does source-map resolution,
 * `ci_watch` polls CI, and `score_sync` posts to Langfuse's own scoring API.
 * Together they were about 97% of August's trace volume and produced bare root
 * spans with no generations.
 */
export const TRACE_POLICY = {
  session_analysis: OFF,
  stack_resolve: OFF,
  ci_watch: OFF,
  score_sync: OFF,

  // Dispatches to the investigation path (index.ts:474).
  error_fix: FULL,
  investigate: FULL,
  // Must stay FULL: score_sync loads this job's trace_url and throws without
  // it (score-sync.ts:36-39).
  fix: FULL,
  session_narrate: FULL,
  session_verify_frames: FULL,
  issue_inquiry: FULL,
  product_context: FULL,
  route_map: FULL,
  digest_write: FULL,
} satisfies Record<JobType, TracePolicy>;

export function tracePolicyFor(jobType: JobType): TracePolicy {
  // A skewed deploy can claim a job type this build has never heard of.
  // Defaulting to FULL costs quota; defaulting to OFF loses the trace for a
  // paid job with no signal it happened. Quota is the cheaper mistake.
  return TRACE_POLICY[jobType] ?? FULL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/trace-policy.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/trace-policy.ts packages/worker/src/__tests__/trace-policy.test.ts
git commit -m "feat(worker): a typed trace policy per job type"
```

---

### Task 2: Gate withJobTrace on the policy and record job type

**Files:**
- Modify: `packages/worker/src/tracing.ts:277-303`
- Modify: `packages/worker/src/index.ts:301-306`
- Modify: `packages/worker/src/__tests__/tracing.test.ts:39,47`
- Modify: `packages/worker/src/__tests__/tracing-init.test.ts:217`
- Modify: `packages/worker/src/__tests__/python-production-path.test.ts:54`
- Test: `packages/worker/src/__tests__/trace-policy-gate.test.ts`

**Interfaces:**
- Consumes: `tracePolicyFor` from Task 1.
- Produces: `withJobTrace<T>(job: TraceableJob, fn: () => Promise<T>): Promise<T>` and the exported `TraceableJob` interface. Replaces the four-argument form.

A full scan found six files referencing `withJobTrace`. Three break and must be edited: the production caller and two test files calling it positionally. A fourth, `python-production-path.test.ts:54`, mocks the old four-parameter shape; its mock would pass `undefined` as `fn` under the new signature. Current tests there call `processJobInner` directly, so it is latent rather than failing, which is exactly why it must be fixed now rather than discovered later. `index.test.ts:156` uses an argument-agnostic `vi.fn()` and needs no change.

The current signature also loses information: `job.error_group_id` receives `errorGroupId ?? sourceId ?? 'unknown'` (`index.ts:303`), flattening three identifiers into one mislabeled attribute.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/trace-policy-gate.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { withJobTrace } from '../tracing.js';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    jobType: 'session_analysis' as const,
    projectId: 'proj-1',
    errorGroupId: null,
    sourceId: null,
    sessionId: 'sess-1',
    attempts: 0,
    ...overrides,
  };
}

describe('withJobTrace', () => {
  it('runs the work and returns its value when tracing is uninitialised', async () => {
    const fn = vi.fn().mockResolvedValue('done');
    await expect(withJobTrace(job(), fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('propagates the error the work threw', async () => {
    const boom = new Error('boom');
    await expect(withJobTrace(job(), () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('runs the work for a policy-off job type', async () => {
    const fn = vi.fn().mockResolvedValue(1);
    await expect(withJobTrace(job({ jobType: 'stack_resolve' }), fn)).resolves.toBe(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('runs the work for a traced job type', async () => {
    const fn = vi.fn().mockResolvedValue(2);
    await expect(withJobTrace(job({ jobType: 'investigate' }), fn)).resolves.toBe(2);
    expect(fn).toHaveBeenCalledOnce();
  });
});
```

These four cases all exit through `if (!tracer) return fn()`, so on their own they prove only that the wrapper is transparent. Add one case with tracing actually initialised, which is the only way to prove a policy-off job creates no span. Follow the initialisation and span-capture pattern already used in `packages/worker/src/__tests__/tracing.test.ts` rather than inventing a new harness:

```typescript
  it('creates no span for a policy-off job type when tracing is initialised', async () => {
    // Use tracing.test.ts's existing init + exporter-stub setup here.
    await withJobTrace(job({ jobType: 'session_analysis' }), async () => 'x');
    expect(exportedSpans()).toHaveLength(0);
    await withJobTrace(job({ jobType: 'investigate' }), async () => 'x');
    expect(exportedSpans()).toHaveLength(1);
    expect(exportedSpans()[0]!.attributes['job.type']).toBe('investigate');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/trace-policy-gate.test.ts`
Expected: FAIL. `withJobTrace` still takes four positional arguments.

- [ ] **Step 3: Replace withJobTrace**

In `packages/worker/src/tracing.ts`, add to the imports:

```typescript
import { tracePolicyFor } from './trace-policy.js';
import type { JobType } from '@opslane/shared';
```

Replace lines 277-303:

```typescript
/**
 * The subset of a claimed job that tracing needs. Structural rather than
 * `ClaimedJob` so tests and callers need not build a full lease.
 */
export interface TraceableJob {
  id: string;
  jobType: JobType;
  projectId: string;
  errorGroupId: string | null;
  sourceId: string | null;
  sessionId: string | null;
  episodeId?: string | null;
  runId?: string | null;
  attempts: number;
}

/**
 * Run a job's work, tracing it only when its type is worth tracing.
 *
 * A policy-off job returns `fn()` directly and creates no span. That is safe
 * precisely because the off list is the set of job types that never call a
 * model: were one of them to call Anthropic, the patched SDK prototype would
 * open its own root span and the trace would reappear unparented.
 */
export async function withJobTrace<T>(job: TraceableJob, fn: () => Promise<T>): Promise<T> {
  if (!tracer) return fn();
  if (tracePolicyFor(job.jobType).mode === 'off') return fn();

  return tracer.startActiveSpan('process-job', async (span: Span) => {
    // job.type first: without it a trace cannot be filtered or grouped by what
    // it was, which is why the pre-existing traces were unusable.
    span.setAttribute('job.type', job.jobType);
    span.setAttribute('job.id', job.id);
    span.setAttribute('job.project_id', job.projectId);
    span.setAttribute('job.attempt', job.attempts);
    // Separate optional attributes, never coalesced. The old code wrote
    // `errorGroupId ?? sourceId ?? 'unknown'` into one field, which mislabels a
    // source id as an error group id and hides the difference from a reader.
    if (job.errorGroupId) span.setAttribute('job.error_group_id', job.errorGroupId);
    if (job.sourceId) span.setAttribute('job.source_id', job.sourceId);
    if (job.sessionId) span.setAttribute('job.session_id', job.sessionId);
    if (job.episodeId) span.setAttribute('job.episode_id', job.episodeId);
    if (job.runId) span.setAttribute('job.run_id', job.runId);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}
```

- [ ] **Step 4: Update the production caller**

In `packages/worker/src/index.ts`, replace lines 301-306:

```typescript
    await withJobTrace(job, () => processJobInner(job, signal));
```

- [ ] **Step 5: Update the three affected test files**

In `packages/worker/src/__tests__/tracing.test.ts`, replace the calls at lines 39 and 47. Keep the assertions:

```typescript
      const result = await withJobTrace(
        { id: 'job-1', jobType: 'investigate', projectId: 'proj-1', errorGroupId: 'eg-1', sourceId: null, sessionId: null, attempts: 0 },
        async () => {
```

Apply the same object at line 47.

In `packages/worker/src/__tests__/tracing-init.test.ts:217`:

```typescript
    expect(await tracing.withJobTrace(
      { id: 'j', jobType: 'investigate', projectId: 'p', errorGroupId: 'e', sourceId: null, sessionId: null, attempts: 0 },
      async () => 'ok',
    )).toBe('ok');
```

In `packages/worker/src/__tests__/python-production-path.test.ts:54`, replace the mock:

```typescript
  withJobTrace: vi.fn((_job: unknown, fn: () => unknown) => fn()),
```

- [ ] **Step 6: Run tests and build**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/trace-policy-gate.test.ts src/__tests__/tracing.test.ts src/__tests__/tracing-init.test.ts src/__tests__/python-production-path.test.ts src/__tests__/index.test.ts`
Expected: PASS. Do not weaken any assertion to get there.

Run: `pnpm --filter @opslane/worker build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/tracing.ts packages/worker/src/index.ts packages/worker/src/__tests__/
git commit -m "feat(worker): trace only the jobs that call a model"
```

---

### Task 3: Export circuit breaker and health signal

**Files:**
- Modify: `packages/worker/src/tracing-diag.ts:155-170`
- Modify: `packages/worker/src/tracing.ts`
- Modify: `packages/worker/src/index.ts`
- Test: `packages/worker/src/__tests__/tracing-export-health.test.ts`

**Interfaces:**
- Consumes: `createDiagLogger(throttle, redact, now)` (`tracing-diag.ts:155`).
- Produces: `getTracingExportHealth(): { failures: number; lastError: string | null; lastErrorAt: string | null; suspended: boolean }` from `tracing.ts`, plus an internal `shutdownTracingOnce()`.

The outage ran unnoticed for 17 days. `LangfuseSpanProcessor` surfaces no export result, so the diag logger is the only seam that sees failures.

Reentrancy matters here. `shutdownTracing` (`tracing.ts:252`) awaits a flush that can itself emit export errors, which re-enter this callback. The `exportSuspended` flag is therefore set **before** the shutdown call, and the shutdown is fired without awaiting, so a nested failure returns immediately and cannot recurse or deadlock the flush.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/tracing-export-health.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { DiagThrottle, createDiagLogger } from '../tracing-diag.js';

describe('createDiagLogger onExportError', () => {
  it('calls back once per export error', () => {
    const onExportError = vi.fn();
    const logger = createDiagLogger(new DiagThrottle(), (t) => t, () => 0, onExportError);
    logger.error('OTLPExporterError: Forbidden');
    expect(onExportError).toHaveBeenCalledWith('OTLPExporterError: Forbidden');
  });

  it('fires even for a throttled line, so a long outage does not look quieter', () => {
    const onExportError = vi.fn();
    const logger = createDiagLogger(new DiagThrottle(), (t) => t, () => 0, onExportError);
    logger.error('OTLPExporterError: Forbidden');
    logger.error('OTLPExporterError: Forbidden');
    logger.error('OTLPExporterError: Forbidden');
    expect(onExportError).toHaveBeenCalledTimes(3);
  });

  it('does not call back for unrelated diagnostics', () => {
    const onExportError = vi.fn();
    const logger = createDiagLogger(new DiagThrottle(), (t) => t, () => 0, onExportError);
    logger.warn('some unrelated otel notice');
    expect(onExportError).not.toHaveBeenCalled();
  });

  it('survives a throwing callback', () => {
    const logger = createDiagLogger(new DiagThrottle(), (t) => t, () => 0, () => {
      throw new Error('callback broke');
    });
    expect(() => logger.error('OTLPExporterError: Forbidden')).not.toThrow();
  });

  it('is optional, so existing callers keep working', () => {
    const logger = createDiagLogger(new DiagThrottle(), (t) => t, () => 0);
    expect(() => logger.error('OTLPExporterError: Forbidden')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/tracing-export-health.test.ts`
Expected: FAIL, `createDiagLogger` takes three parameters.

- [ ] **Step 3: Add the callback**

In `packages/worker/src/tracing-diag.ts`, change the signature at line 155 and the head of `emit`:

```typescript
export function createDiagLogger(
  throttle: DiagThrottle,
  redact: (text: string) => string,
  now: () => number = Date.now,
  onExportError?: (text: string) => void,
): DiagLogger {
  const emit =
    (level: 'warn' | 'error') =>
    (message: string, ...args: unknown[]): void => {
      try {
        const text = normalizeDiagMessage(message, args, redact);
        // Fire before the throttle. The throttle keeps the log readable;
        // suppressing a line must not also suppress the count, or a sustained
        // outage would look quieter the longer it lasted.
        if (onExportError && text.includes('OTLPExporterError')) {
          try {
            onExportError(text);
          } catch {
            // A broken callback must never take down diagnostics.
          }
        }
        const suppressed = throttle.admit(`${level}:${text}`, now());
        if (suppressed === null) return;
        const fields: Record<string, unknown> = { component: 'otel' };
```

Leave the rest of the function unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/tracing-export-health.test.ts src/__tests__/tracing-diag.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the breaker**

In `packages/worker/src/tracing.ts`, add module state near line 33:

```typescript
/**
 * Export health. Langfuse suspended ingestion on 2026-08-17 and the worker
 * exported into a 403 for 17 days with nothing noticing, while cost reporting
 * silently fell back to a source nobody had checked.
 *
 * The counter is lifetime, not consecutive: this seam sees failures only, with
 * no success signal to reset on, so calling it "consecutive" would be a lie
 * that hides a slow leak of intermittent errors. The threshold is therefore a
 * lifetime budget for one process, which a healthy process never approaches.
 */
const EXPORT_FAILURE_LIMIT = 50;
let exportFailures = 0;
let exportLastError: string | null = null;
let exportLastErrorAt: string | null = null;
let exportSuspended = false;
/** Serializes breaker shutdown against any other shutdown already running. */
let shutdownInFlight: Promise<void> | null = null;

export function getTracingExportHealth(): {
  failures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  suspended: boolean;
} {
  return {
    failures: exportFailures,
    lastError: exportLastError,
    lastErrorAt: exportLastErrorAt,
    suspended: exportSuspended,
  };
}

function noteExportError(text: string): void {
  exportFailures += 1;
  exportLastError = text.slice(0, 300);
  exportLastErrorAt = new Date().toISOString();
  if (exportFailures < EXPORT_FAILURE_LIMIT || exportSuspended) return;
  // Set the flag BEFORE shutting down. shutdownTracing awaits a flush that can
  // emit further export errors which re-enter this function; the flag makes
  // that re-entry a no-op. Not awaited, so a nested failure cannot deadlock
  // the flush that produced it.
  exportSuspended = true;
  safeWarn('Langfuse export suspended after sustained failures', {
    failures: exportFailures,
    last_error: exportLastError,
  });
  void shutdownTracingOnce();
}
```

Wrap `shutdownTracing` so the breaker cannot start a second teardown against the same `sdk`, `diagThrottle` and global OTel state while a normal shutdown is already running:

```typescript
/** At most one teardown at a time, whoever asks. */
function shutdownTracingOnce(): Promise<void> {
  shutdownInFlight ??= shutdownTracing().finally(() => { shutdownInFlight = null; });
  return shutdownInFlight;
}
```

Route the process's own shutdown path through `shutdownTracingOnce` too.

In `initTracing`, reset `exportFailures`, `exportLastError`, `exportLastErrorAt` and `exportSuspended`, and pass `noteExportError` as the fourth argument to `createDiagLogger`.

Known limitation, deliberately not solved here: `initTracing` returns early on `initialized === true`, so calling it while a breaker shutdown is still settling silently drops the restart, and `shutdownWithTimeout`'s five-second timeout can clear `initialized` while the underlying `sdk.shutdown()` is still running. In-process restart after a breaker trip is therefore unreliable. A process restart is not affected. Do not add an in-process restart path on top of this without fixing that first.

- [ ] **Step 6: Expose it on health**

In `packages/worker/src/index.ts`, add `getTracingExportHealth` to the existing `./tracing.js` import at line 36. The health object literal is at `index.ts:1777`; add a property beside `jobs_failed`. Serialize the fields explicitly, because the health payload is snake_case throughout and spreading the accessor's camelCase keys would break that contract:

```typescript
      tracing_export: (() => {
        const health = getTracingExportHealth();
        return {
          failures: health.failures,
          last_error: health.lastError,
          last_error_at: health.lastErrorAt,
          suspended: health.suspended,
        };
      })(),
```

- [ ] **Step 7: Add the new export to the two tracing mocks**

`packages/worker/src/__tests__/index.test.ts:153` and `packages/worker/src/__tests__/python-production-path.test.ts:51` mock `../tracing.js` with an explicit factory, so a new named export must be added or the import fails to resolve. Add to both:

```typescript
  getTracingExportHealth: vi.fn(() => ({
    failures: 0, lastError: null, lastErrorAt: null, suspended: false,
  })),
```

- [ ] **Step 8: Test the threshold and the breaker, not just the callback**

Add to `packages/worker/src/__tests__/tracing-export-health.test.ts` cases that drive `noteExportError` past `EXPORT_FAILURE_LIMIT` and assert that `getTracingExportHealth().suspended` flips exactly once and that a re-entrant call during teardown does not start a second shutdown. Export `noteExportError` for test, or drive it through the diag logger with a stubbed shutdown. Without these, requirement R5 is only asserting that a callback fires.

- [ ] **Step 9: Verify and commit**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`

```bash
git add packages/worker/src/tracing-diag.ts packages/worker/src/tracing.ts packages/worker/src/index.ts packages/worker/src/__tests__/
git commit -m "feat(worker): stop exporting into a dead Langfuse endpoint silently"
```

---

### Task 4: Read cumulative usage from the Agent SDK result message

**Files:**
- Modify: `packages/worker/src/harness/sdk-agent.ts:276-296, 355-376`
- Test: `packages/worker/src/harness/__tests__/sdk-agent-usage.test.ts`

**Interfaces:**
- Produces: `applyResultUsage(target: TokenUsage, message: unknown): boolean`, exported for test. Returns whether anything was applied.

Production evidence: investigations on 2026-09-02 recorded 62 output tokens on average while writing 4,000 to 13,000 character diagnoses.

**Reading the result message is necessary but not sufficient, and this is the whole difficulty of the task.** The terminal MCP tool handler sets `state.captured` (`sdk-agent.ts:232`). The loop checks it at the bottom of every iteration and breaks (`:378`). So on the normal successful path, where the agent submits its diagnosis through the terminal tool, the loop exits before the SDK ever yields its `result` message. A fix that only reads `result` would leave the production undercount exactly as it is. The same applies to the `state.fatal` and budget breaks at `:377` and `:379`.

The fix is therefore two parts. Read the result when it arrives, and on a `captured` break, keep draining the stream until the result arrives rather than leaving immediately. Draining is bounded, because a stream that never produces a result must not hang the job.

Overwrite rather than add is correct, because the result's usage is cumulative for the whole query and adding would double-count the assistant-message sums. But a naive overwrite corrupts: a result carrying `input_tokens` and `output_tokens` while omitting the cache fields would zero accumulated cache usage. Each field is overwritten only when the result actually carries it.

Unverified and worth settling during implementation: whether the Agent SDK reliably emits a `result` message after the terminal tool has been called, and how many messages it takes. Step 5 bounds the drain so that a stream which never yields one costs a few extra messages rather than a hang. If measurement shows the result never arrives on this path, fall back to keeping the assistant-message sums and open a separate issue, because at that point the undercount is an SDK reporting question rather than a loop-control one.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/harness/__tests__/sdk-agent-usage.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { applyResultUsage } from '../sdk-agent.js';

const accumulated = () => ({ input: 5, output: 9, cacheRead: 700, cacheWrite: 80 });

describe('applyResultUsage', () => {
  it('overwrites with cumulative usage from a success result', () => {
    const target = accumulated();
    expect(applyResultUsage(target, {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 120, output_tokens: 9_400,
        cache_read_input_tokens: 250_000, cache_creation_input_tokens: 31_000,
      },
    })).toBe(true);
    expect(target).toEqual({ input: 120, output: 9_400, cacheRead: 250_000, cacheWrite: 31_000 });
  });

  it('applies usage from an error result, because a failed run still cost money', () => {
    const target = accumulated();
    expect(applyResultUsage(target, {
      type: 'result', subtype: 'error_max_turns',
      usage: { input_tokens: 10, output_tokens: 20 },
    })).toBe(true);
    expect(target.input).toBe(10);
    expect(target.output).toBe(20);
  });

  it('keeps accumulated cache usage when the result omits the cache fields', () => {
    const target = accumulated();
    applyResultUsage(target, {
      type: 'result', subtype: 'error_max_turns',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(target.cacheRead).toBe(700);
    expect(target.cacheWrite).toBe(80);
  });

  it('changes nothing when the result carries no usage', () => {
    const target = accumulated();
    expect(applyResultUsage(target, { type: 'result', subtype: 'success' })).toBe(false);
    expect(target).toEqual(accumulated());
  });

  it('changes nothing for a non-result message', () => {
    const target = accumulated();
    expect(applyResultUsage(target, { type: 'assistant' })).toBe(false);
    expect(target).toEqual(accumulated());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/harness/__tests__/sdk-agent-usage.test.ts`
Expected: FAIL, `applyResultUsage` is not exported.

- [ ] **Step 3: Add the applier**

In `packages/worker/src/harness/sdk-agent.ts`, after `usageFromMessage` (ends line 285):

```typescript
/**
 * Install cumulative usage from the SDK's terminal `result` message.
 *
 * The result's usage is authoritative for the whole query, so this overwrites
 * rather than adds; adding would double-count the per-assistant-message sums
 * already accumulated. Each field is overwritten only when the result actually
 * carries it, because a partial result that omits the cache fields must not
 * zero cache usage that the assistant messages already reported.
 *
 * Error subtypes are read too: a run that exhausted its turns still paid.
 */
export function applyResultUsage(target: TokenUsage, message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as { type?: unknown; usage?: unknown };
  if (record.type !== 'result') return false;
  if (typeof record.usage !== 'object' || record.usage === null) return false;
  const usage = record.usage as Record<string, unknown>;
  const assign = (key: string, field: keyof TokenUsage): boolean => {
    const value = usage[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    target[field] = value;
    return true;
  };
  let applied = false;
  applied = assign('input_tokens', 'input') || applied;
  applied = assign('output_tokens', 'output') || applied;
  applied = assign('cache_read_input_tokens', 'cacheRead') || applied;
  applied = assign('cache_creation_input_tokens', 'cacheWrite') || applied;
  return applied;
}
```

- [ ] **Step 4: Use it in the loop**

Inside the existing `if (message.type === 'result') {` block at line 355, as its first statement:

```typescript
      if (message.type === 'result') {
        // Authoritative for the whole query. The per-assistant-message sums
        // remain the fallback for a stream that ends without a result.
        if (applyResultUsage(usage, message)) {
          costUsd = calculateCost(usage, pricingFor(input.model));
          resultUsageSeen = true;
        }
```

Declare `let resultUsageSeen = false;` beside `costUsd` before the loop.

- [ ] **Step 5: Drain to the result on the captured break**

This is the step that actually fixes the undercount. Replace the three break conditions at lines 377-379:

```typescript
      if (state.fatal) break;
      if (state.captured) {
        stop = 'terminal';
        // Do NOT break here. The terminal tool handler set state.captured
        // while the SDK was mid-turn, so the cumulative `result` message has
        // not been yielded yet. Breaking now is what makes production record
        // double-digit output tokens for multi-thousand-token diagnoses.
        // Drain a bounded number of further messages to reach it.
        if (resultUsageSeen) break;
        if (++drainedAfterCapture > MAX_DRAIN_AFTER_CAPTURE) break;
        continue;
      }
      if (costUsd > input.budgetUsd) { stop = 'budget'; break; }
```

Declare beside it, above the loop:

```typescript
/**
 * How many messages to keep reading after the terminal tool fired, waiting for
 * the SDK's cumulative `result`. Bounded so a stream that never yields one
 * costs a few messages rather than hanging the job.
 */
const MAX_DRAIN_AFTER_CAPTURE = 20;
```

and `let drainedAfterCapture = 0;` beside `resultUsageSeen`.

- [ ] **Step 6: Test the drain**

Add to `packages/worker/src/harness/__tests__/sdk-agent-usage.test.ts`:

```typescript
  it('keeps reading after capture until the result message arrives', () => {
    // Documents the loop contract this task changes: a captured submission
    // must not end the stream before the cumulative result is seen.
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    applyResultUsage(usage, {
      type: 'result', subtype: 'success',
      usage: { input_tokens: 120, output_tokens: 9_400 },
    });
    expect(usage.output).toBe(9_400);
  });
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @opslane/worker exec vitest run src/harness/__tests__/`
Expected: PASS. Watch specifically for regressions in any test asserting that a captured submission ends the run promptly; the run still ends, just after the result.

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/harness/sdk-agent.ts packages/worker/src/harness/__tests__/sdk-agent-usage.test.ts
git commit -m "fix(worker): read cumulative agent usage from the result message"
```

---

### Task 5: PhaseMeter

**Files:**
- Create: `packages/worker/src/metered.ts`
- Modify: `packages/worker/src/db.ts:410`
- Test: `packages/worker/src/__tests__/metered.test.ts`

**Interfaces:**
- Consumes: `recordJobUsage` (`db.ts:424`), `calculateCost` (`packages/agent-core/src/tool-loop.ts:242`), `pricingFor` (`packages/worker/src/harness/agent-loop.ts:24`).
- Produces: `class PhaseMeter` with `add(model: string, usage: TokenUsage): void` and `flush(): Promise<void>`; `usageFromResponse(response: unknown): TokenUsage`. Tasks 6, 7 and 8 use both.

Two behaviours are deliberate. `flushed` is set only after the writes complete, so a mid-flush crash does not mark unwritten usage as written. And `add` after `flush` logs loudly rather than silently discarding, because a caller doing that has a bug that would otherwise show up as a quiet undercount.

One limitation to know: `recordJobUsage` swallows its own database errors (`db.ts:451-455`), so the meter cannot detect a failed insert. Making the ledger durable is out of scope and noted in Risks.

- [ ] **Step 1: Extend UsagePhase**

In `packages/worker/src/db.ts`, replace line 410:

```typescript
export type UsagePhase =
  | 'investigation' | 'fix' | 'judge' | 'product_context' | 'inquiry' | 'narrate'
  // Added 2026-09-03. Each of these ran a model and wrote nothing.
  // `diff_judge` is distinct from `judge` on purpose: the verification judge
  // already writes `judge` (agent-fix.ts:1402-1410) and defaults to Sonnet 5,
  // while the diff judge always uses Haiku. Sharing a phase would let one
  // silently drop the other under ON CONFLICT DO NOTHING if FIX_JUDGE_MODEL
  // were ever set to Haiku.
  | 'verify' | 'digest_write' | 'visual_analysis' | 'fix_narrative' | 'diff_judge';
```

No migration: `job_usage.phase` is unrestricted non-empty text (`043_job_usage_ledger.sql:11`) and the triggers reject only update, delete and truncate (`:42-52`).

- [ ] **Step 2: Write the failing test**

Create `packages/worker/src/__tests__/metered.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { PhaseMeter, usageFromResponse } from '../metered.js';

const usage = (output: number) => ({ input: 10, output, cacheRead: 100, cacheWrite: 5 });

describe('PhaseMeter', () => {
  it('writes nothing when no call was made', async () => {
    const record = vi.fn();
    await new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record }).flush();
    expect(record).not.toHaveBeenCalled();
  });

  it('sums repeat calls on the same model into one row', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(100));
    meter.add('claude-sonnet-5', usage(50));
    await meter.flush();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({
      jobId: 'j', execution: 0, phase: 'diff_judge', model: 'claude-sonnet-5',
      usage: { input: 20, output: 150, cacheRead: 200, cacheWrite: 10 },
    });
  });

  it('keeps one row per model when a phase falls back to another tier', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-haiku-4-5-20251001', usage(10));
    meter.add('claude-sonnet-5', usage(20));
    await meter.flush();
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('never throws out of flush, because metering must not fail a job', async () => {
    const record = vi.fn().mockRejectedValue(new Error('db down'));
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(1));
    await expect(meter.flush()).resolves.toBeUndefined();
  });

  it('is idempotent, so a double flush cannot double-count', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(1));
    await meter.flush();
    await meter.flush();
    expect(record).toHaveBeenCalledOnce();
  });

  it('does not double-write when two flushes race', async () => {
    // Two `finally` blocks on the same meter would both clear a boolean guard.
    const record = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(1));
    await Promise.all([meter.flush(), meter.flush()]);
    expect(record).toHaveBeenCalledOnce();
  });

  it('retries only the model whose write failed', async () => {
    const record = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(1));
    await meter.flush();
    expect(record).toHaveBeenCalledOnce();
  });

  it('reads a zero for a usage field the response omits', () => {
    expect(usageFromResponse({ usage: { input_tokens: 4, output_tokens: 6 } }))
      .toEqual({ input: 4, output: 6, cacheRead: 0, cacheWrite: 0 });
  });

  it('reads all zeros from a response with no usage at all', () => {
    expect(usageFromResponse(null)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/metered.test.ts`
Expected: FAIL, cannot resolve `../metered.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/worker/src/metered.ts`:

```typescript
import { calculateCost } from '@opslane/agent-core';
import { recordJobUsage, type TokenUsage, type UsagePhase } from './db.js';
import { pricingFor } from './harness/agent-loop.js';
import { logger, safeErrorMessage } from './logger.js';

type RecordFn = (entry: {
  jobId: string;
  execution: number;
  phase: UsagePhase;
  model: string;
  usage: TokenUsage;
  costUsd: number;
}) => Promise<void>;

/**
 * Accumulates a phase's token usage and writes one ledger row per model.
 *
 * The ledger is insert-only and keyed (job, execution, phase, model) with
 * ON CONFLICT DO NOTHING, so a second insert for the same key is discarded and
 * the first writer wins even when it holds only partial usage. Aggregating
 * here is what makes ADR 0001's claim that inner retries "aggregate into their
 * phase row" true, and it needs no migration and no UPDATE against the
 * immutability trigger.
 *
 * One meter owns one (job, execution, phase). Two meters on the same key would
 * still collide, which is why phases are distinct per call site.
 */
export class PhaseMeter {
  private readonly totals = new Map<string, TokenUsage>();
  private flushed = false;

  constructor(
    private readonly opts: {
      jobId: string;
      execution: number;
      phase: UsagePhase;
      record?: RecordFn;
    },
  ) {}

  add(model: string, usage: TokenUsage): void {
    if (this.flushed) {
      // Loud, because the alternative is a quiet undercount that looks like
      // the model simply used fewer tokens.
      logger.error('phase meter received usage after flush', {
        job_id: this.opts.jobId, phase: this.opts.phase, model,
      });
      return;
    }
    const prior = this.totals.get(model);
    if (!prior) {
      this.totals.set(model, { ...usage });
      return;
    }
    prior.input += usage.input;
    prior.output += usage.output;
    prior.cacheRead += usage.cacheRead;
    prior.cacheWrite += usage.cacheWrite;
  }

  /**
   * Best-effort and idempotent. Never throws: metering must not fail a job.
   *
   * The guard is a promise, not a boolean. Two `finally` blocks racing on the
   * same meter would both pass a boolean guard and write twice; awaiting the
   * in-flight promise makes the second call a no-op that still waits for the
   * first to finish.
   *
   * A model whose write succeeds is removed from `totals`, so a later flush
   * retries only what actually failed rather than silently giving up on it.
   */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush();
    return this.flushing;
  }

  private flushing: Promise<void> | null = null;

  private async doFlush(): Promise<void> {
    const record = this.opts.record ?? recordJobUsage;
    for (const [model, usage] of [...this.totals]) {
      try {
        await record({
          jobId: this.opts.jobId,
          execution: this.opts.execution,
          phase: this.opts.phase,
          model,
          usage,
          costUsd: Number(calculateCost(usage, pricingFor(model)).toFixed(4)),
        });
        // Drop only what was written. Anything left is retryable.
        this.totals.delete(model);
      } catch (err: unknown) {
        logger.error('phase meter flush failed', {
          job_id: this.opts.jobId, phase: this.opts.phase, model,
          error: safeErrorMessage(err),
        });
      }
    }
    // Set last: a crash mid-flush must not mark unwritten usage as written.
    this.flushed = true;
  }
}

/** Narrow an Anthropic response's usage block into the ledger's shape. */
export function usageFromResponse(response: unknown): TokenUsage {
  const usage = (response as { usage?: Record<string, unknown> } | null)?.usage;
  const read = (key: string): number => {
    const value = usage?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    input: read('input_tokens'),
    output: read('output_tokens'),
    cacheRead: read('cache_read_input_tokens'),
    cacheWrite: read('cache_creation_input_tokens'),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/metered.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/metered.ts packages/worker/src/db.ts packages/worker/src/__tests__/metered.test.ts
git commit -m "feat(worker): a phase meter that aggregates before it writes"
```

---

### Task 6: Ledger frame verification

**Files:**
- Modify: `packages/worker/src/narrative/verify.ts:225-252`
- Modify: `packages/worker/src/narrative/__tests__/verify.test.ts:5`
- Test: same file, extended

Frame verification calls a model (`verify.ts:225-229`) and stores its tokens only on `session_narratives` via `finalizeVerification` (`db.ts:3851-3852`), never in `job_usage`. The job and the response are both already in scope, so no plumbing is needed.

Two traps. `verify.test.ts:5` mocks `../../db.js` without `recordJobUsage`; importing `PhaseMeter` adds that named dependency and the mock will fail to resolve it. And a standalone test that only drives `PhaseMeter` directly proves nothing about this file, because it passes before the behaviour exists. The test therefore goes in the existing suite and drives `processFrameVerification`.

- [ ] **Step 1: Extend the existing db mock**

In `packages/worker/src/narrative/__tests__/verify.test.ts`, add `recordJobUsage` to the `../../db.js` mock at line 5:

```typescript
  recordJobUsage: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 2: Write the failing test**

Add to the same file, using its existing harness for building a verification job:

```typescript
  it('writes a verify ledger row for the model that ran', async () => {
    const { recordJobUsage } = await import('../../db.js');
    await processFrameVerification(/* the suite's existing job + deps fixture */);
    expect(recordJobUsage).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'verify', model: 'claude-sonnet-5' }),
    );
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/narrative/__tests__/verify.test.ts`
Expected: FAIL, `recordJobUsage` never called.

- [ ] **Step 4: Meter the call**

In `packages/worker/src/narrative/verify.ts`, add the import:

```typescript
import { PhaseMeter } from '../metered.js';
```

Wrap the model call at line 225. The flush belongs in a `finally` because the invalid-output path at line 231 returns early:

```typescript
  const meter = new PhaseMeter({
    jobId: job.id, execution: job.attempts, phase: 'verify',
  });
  let response;
  try {
    response = await deps.client.complete({
      system: buildVerifyPrompt(),
      user: `OBSERVATIONS_START\n${JSON.stringify(narrative.observations)}\nOBSERVATIONS_END\nTIMELINE_START\n${timeline.lines.map((line, index) => `L${index + 1} ${line.t}`).join('\n')}\nTIMELINE_END`,
      images: captureResult.frames.map((frame) => ({ mediaType: 'image/png', base64: frame.png.toString('base64') })),
    });
    meter.add(deps.client.modelName, {
      input: response.inputTokens, output: response.outputTokens,
      cacheRead: 0, cacheWrite: 0,
    });
  } finally {
    // Covers the early return on invalid output, which has already paid.
    // A rejected `complete()` is NOT covered: nothing was added, so this
    // flushes an empty meter. Usage on a thrown call is lost, same as
    // everywhere else in the codebase, and is not solved here.
    await meter.flush();
  }
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @opslane/worker exec vitest run src/narrative/ && pnpm --filter @opslane/worker build`

```bash
git add packages/worker/src/narrative/verify.ts packages/worker/src/narrative/__tests__/verify.test.ts
git commit -m "feat(worker): ledger the frame verification model call"
```

---

### Task 7: Return usage from the diff judge and the fix narrative

**Files:**
- Modify: `packages/worker/src/harness/diff-judge.ts:18, 92-106, 119`
- Modify: `packages/worker/src/agent-fix.ts:278-292, 1274-1294, 1438-1450, 1494-1509`
- Test: `packages/worker/src/__tests__/diff-judge-usage.test.ts`

Neither site can be metered as-is. `judgeDiff` discards its response (`diff-judge.ts:119`) and `generateFixNarrative` discards its own (`agent-fix.ts:290-292`).

The enclosing function is `runAgentFixCore(input: AgentFixInput)` (`agent-fix.ts:500`). There is no `job` variable in scope. It does not need one: `input.usageContext` already exists and the per-tier `finally` at `agent-fix.ts:1494-1509` already writes phase `fix` through it with `recordJobUsage`. That block is the right home for these two meters, which avoids wrapping the whole cascade loop and avoids disturbing its `continue` and four returns.

Three traps this task exists to avoid:

- The diff judge always calls Haiku (`diff-judge.ts:94` uses `JUDGE_MODEL`), never the caller's `tier.model`. Metering `tier.model` would attribute Haiku tokens to Sonnet and overprice them. The trace attribute at `agent-fix.ts:1279` and the log at `:1291` are wrong in the same way and are corrected here too.
- `judgeDiff` throws at `diff-judge.ts:103` when the response has no tool-use block. The response was already paid for at that point, so returning usage only on the success path still loses it. Usage is reported through a callback fired the moment the response arrives, before any parsing.
- The existing per-tier `finally` already guards on non-zero usage before writing. Follow that shape rather than inventing another.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/diff-judge-usage.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { JUDGE_MODEL } from '../harness/diff-judge.js';

describe('diff judge', () => {
  it('exports the model it actually calls, which is Haiku not the caller tier', () => {
    expect(JUDGE_MODEL).toBe('claude-haiku-4-5-20251001');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/diff-judge-usage.test.ts`
Expected: FAIL, `JUDGE_MODEL` is not exported.

- [ ] **Step 3: Report judge usage through a callback**

In `packages/worker/src/harness/diff-judge.ts`, export the model constant at line 18:

```typescript
export const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
```

A callback rather than a return value, because `judgeDiff` throws at line 103 on a malformed response that has already been paid for. Add an optional parameter to its signature and fire it immediately after the response arrives, before any parsing:

```typescript
  const response = await client.messages.create({ /* unchanged */ });
  // Before parsing. The throw below at "Judge returned no tool_use block"
  // happens on a response that already cost money; returning usage only on
  // the success path would lose exactly those calls, which the existing
  // malformed-response tests in diff-judge.test.ts deliberately exercise.
  onUsage?.(usageFromResponse(response));

  const toolUse = response.content.find(b => b.type === 'tool_use');
```

Import `usageFromResponse` from `../metered.js`. `DiffJudgeResult` is unchanged, so no existing test expectation needs extending.

- [ ] **Step 4: Return usage from generateFixNarrative**

In `packages/worker/src/agent-fix.ts`, change `generateFixNarrative` to return usage alongside the narrative. At lines 290-292:

```typescript
  return {
    narrative: parseFixNarrative(
      toolUse?.type === 'tool_use' ? toolUse.input : undefined,
      fallbackInput,
    ),
    usage: usageFromResponse(response),
  };
```

Update its declared return type and its single call site at line 1441 to read `.narrative`.

- [ ] **Step 5: Meter both in the existing per-tier finally**

Declare both meters immediately before the cascade loop at `agent-fix.ts:861`, guarded on the same `input.usageContext` the fix phase already uses:

```typescript
    const judgeMeter = input.usageContext
      ? new PhaseMeter({ ...input.usageContext, phase: 'diff_judge' })
      : null;
    const narrativeMeter = input.usageContext
      ? new PhaseMeter({ ...input.usageContext, phase: 'fix_narrative' })
      : null;
```

At the judge call (line 1278), pass the callback and correct both the trace attribute and the log, which currently name `tier.model` for a call that always runs Haiku:

```typescript
        const judgeResult = await traceSpan(
          'diff-judge',
          { 'judge.model': JUDGE_MODEL, 'judge.tier': tierIdx },
          () => judgeDiff(apiKey, { /* unchanged */ }, (usage) => judgeMeter?.add(JUDGE_MODEL, usage)),
        );

        logger.info('Diff judge result', {
          model: JUDGE_MODEL,
```

At the narrative call (line 1441):

```typescript
            const generated = await traceSpan(/* ...unchanged... */);
            narrative = generated.narrative;
            narrativeMeter?.add(FIX_NARRATIVE_MODEL, generated.usage);
```

Then flush both inside the **existing** per-tier `finally` at lines 1494-1509, after the `recordJobUsage` call already there:

```typescript
      } finally {
        const usage = agentState.tokenUsage;
        if (/* existing guard, unchanged */) {
          await recordJobUsage({ /* unchanged */ });
        }
        // Same block, so every early return and `continue` in the cascade is
        // already covered without wrapping the loop.
        await judgeMeter?.flush();
        await narrativeMeter?.flush();
      }
```

Because the meters are created once outside the loop but flushed inside it, a second tier's `add` would land after the first tier's flush. `PhaseMeter` logs that loudly rather than dropping it silently, which is the signal that these should move to per-tier meters. If the cascade routinely runs more than one tier, create both meters inside the loop instead and give the phase a tier suffix so the ledger key stays unique.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/diff-judge.test.ts src/__tests__/agent-fix.test.ts src/__tests__/diff-judge-usage.test.ts && pnpm --filter @opslane/worker build`
Expected: PASS. The callback is optional and `DiffJudgeResult` is unchanged, so existing expectations should not need editing. If any do, extend them rather than loosening them.

```bash
git add packages/worker/src/harness/diff-judge.ts packages/worker/src/agent-fix.ts packages/worker/src/__tests__/
git commit -m "feat(worker): ledger the diff judge and fix narrative calls"
```

---

### Task 8: Thread job context into digest write and visual analysis

**Files:**
- Modify: `packages/worker/src/digest-writer/job.ts:87, 491, 591`
- Modify: `packages/worker/src/index.ts:391-394, 1537-1542`
- Modify: `packages/worker/src/visual-analysis.ts:25-27`
- Modify: `packages/worker/src/__tests__/index.test.ts:1540`
- Test: `packages/worker/src/__tests__/digest-writer.test.ts` (extend)

Neither site can be metered without plumbing. `index.ts:391-394` discards the job before calling `writeDigest`, and `runVisualAnalysis` receives no job context (`visual-analysis.ts:25-27`) though its caller owns the job (`index.ts:1537-1542`).

For the digest, the context is bound into the dependency rather than threaded as a new parameter. `DigestWriterDependencies.askModel` is typed as `(candidates: DigestCandidate[]) => Promise<unknown>` (`job.ts:87`) and is invoked with one argument at `:626`. Adding a parameter to `writeDigest` and `askDigestModel` alone would not connect them, because `defaultDependencies()` (`:591`) binds the bare function in between. Closing over the context instead leaves `askModel`'s signature and every existing stub untouched.

- [ ] **Step 1: Bind job context into the default dependency**

In `packages/worker/src/digest-writer/job.ts`, give `defaultDependencies` an optional context and close over it:

```typescript
function defaultDependencies(
  /** Optional: with no context the model call runs unmetered, as today. */
  jobContext?: { jobId: string; execution: number },
): DigestWriterDependencies {
```

and where it builds the object, bind rather than pass through, so `askModel` keeps its one-argument shape:

```typescript
    askModel: (candidates) => askDigestModel(candidates, jobContext),
```

Then meter inside `askDigestModel` at line 491:

```typescript
async function askDigestModel(
  candidates: DigestCandidate[],
  jobContext?: { jobId: string; execution: number },
): Promise<unknown> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  const meter = jobContext ? new PhaseMeter({ ...jobContext, phase: 'digest_write' }) : null;
  try {
    const response = await createAnthropicClient(apiKey).messages.create({ /* unchanged */ });
    meter?.add(DIGEST_MODEL, usageFromResponse(response));
    return /* unchanged */;
  } finally {
    await meter?.flush();
  }
}
```

`writeDigest`'s own signature is unchanged.

- [ ] **Step 2: Pass the bound dependencies at the dispatch**

In `packages/worker/src/index.ts`, replace lines 391-394:

```typescript
  if (job.jobType === 'digest_write') {
    if (!job.runId) throw new Error(`Digest writer job ${job.id} missing run_id`);
    await writeDigest(job.runId, job.projectId, defaultDependencies({
      jobId: job.id, execution: job.attempts,
    }));
    return;
  }
```

Export `defaultDependencies` from `digest-writer/job.ts` so `index.ts` can call it.

- [ ] **Step 3: Update the exact assertion this breaks**

`packages/worker/src/__tests__/index.test.ts:1540` asserts the two-argument call. Widen it to admit the dependencies argument without weakening what it checks:

```typescript
    expect(writeDigest).toHaveBeenCalledWith('run-1', 'proj-1', expect.anything());
```

- [ ] **Step 4: Same for visual analysis**

In `packages/worker/src/visual-analysis.ts`, add an optional `jobContext` to `VisualAnalysisInput`, meter around the `messages.create` at line 46 against the literal model `'claude-sonnet-4-5-20250929'`, and flush in a `finally`. Then at `packages/worker/src/index.ts:1537`, add `jobContext: { jobId: job.id, execution: job.attempts }` to the existing argument object. `runVisualAnalysis`'s only other caller is `visual-analysis.test.ts`, which an optional field leaves working.

- [ ] **Step 5: Extend the digest writer test**

In `packages/worker/src/__tests__/digest-writer.test.ts`, pin that the unmetered path still works:

```typescript
  it('writes a digest without job context, unmetered', async () => {
    await expect(writeDigest('run-1', 'proj-1', testDependencies())).resolves.toBeDefined();
  });
```

Use the file's existing dependency-stub helper rather than inventing one.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/digest-writer.test.ts src/__tests__/digest-writer.integration.test.ts src/__tests__/index.test.ts src/__tests__/visual-analysis.test.ts && pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`

```bash
git add packages/worker/src/digest-writer/job.ts packages/worker/src/visual-analysis.ts packages/worker/src/index.ts packages/worker/src/__tests__/
git commit -m "feat(worker): ledger the digest and visual analysis model calls"
```

---

### Task 9: Halve the verification capture viewport

**Files:**
- Modify: `packages/worker/src/narrative/frames/capture.ts:24`
- Test: `packages/worker/src/narrative/__tests__/capture-viewport.test.ts`

Verification captures three moments as before-and-after pairs, six screenshots at 1440 by 900 (`capture.ts:24-26`). At roughly `width * height / 750` tokens that is about 1,730 each and 10,400 total, which matches the measured 12,945-token verification input almost exactly. Halving each dimension quarters the pixels, an estimated $4.20 per day.

The prompt already tells the model to judge content rather than polish and warns that reconstructions may be missing styles (`verify.ts:127`), so detail below this was never relied on. Legibility is still checked by hand in Step 4.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/narrative/__tests__/capture-viewport.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE_VIEWPORT } from '../frames/capture.js';

describe('DEFAULT_CAPTURE_VIEWPORT', () => {
  it('is half the old 1440x900, which quarters the pixels', () => {
    expect(DEFAULT_CAPTURE_VIEWPORT).toEqual({ width: 720, height: 450 });
  });

  it('keeps the 16:10 aspect ratio the replay harness renders at', () => {
    expect(DEFAULT_CAPTURE_VIEWPORT.width / DEFAULT_CAPTURE_VIEWPORT.height).toBeCloseTo(1.6, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/narrative/__tests__/capture-viewport.test.ts`
Expected: FAIL, `DEFAULT_CAPTURE_VIEWPORT` is not exported.

- [ ] **Step 3: Export and use the constant**

In `packages/worker/src/narrative/frames/capture.ts`, above `captureFrames`:

```typescript
/**
 * Capture size for verification frames.
 *
 * Six frames at 1440x900 cost roughly 10,400 image tokens per verification,
 * about 80% of that call's input. Half in each dimension is a quarter of the
 * pixels. The verify prompt asks the model to judge content and says
 * reconstructions may be missing styles, so finer detail was never load-bearing.
 */
export const DEFAULT_CAPTURE_VIEWPORT = { width: 720, height: 450 } as const;
```

Then replace line 24:

```typescript
  const viewport = opts.viewport ?? { ...DEFAULT_CAPTURE_VIEWPORT };
```

- [ ] **Step 4: Confirm the frames are still legible**

No unit test can settle this. Capture a frame at the new size from a real replay and look at it. If page text is unreadable at 720 by 450, stop and use 1024 by 640 instead, which still saves about half.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @opslane/worker test`

```bash
git add packages/worker/src/narrative/frames/capture.ts packages/worker/src/narrative/__tests__/capture-viewport.test.ts
git commit -m "perf(narrative): capture verification frames at half scale"
```

---

### Task 10: File the two deferred findings ([#460](https://github.com/opslane/opslane/issues/460), [#461](https://github.com/opslane/opslane/issues/461))

**Files:** none. Produces two GitHub issues.

- [ ] **Step 1: File the late-chunk analysis race**

Run from the repository root so `gh` infers the remote:

```bash
gh issue create --title "Late-chunk re-analysis cannot fire while a session is analyzing" --body "$(cat <<'EOF'
`MarkChunkScrubbed` re-enqueues session analysis only for sessions in `closed`,
`analyzed`, or `analysis_failed` (packages/ingestion/db/sessions.go:373). The
worker sets a session to `analyzing` when it claims the job
(packages/worker/src/index.ts:1224), and a second guard skips the enqueue while
a job is `pending` or `claimed`. A chunk that becomes readable during an
analysis run is blocked twice, the worker finishes against a stale chunk list,
and the session is marked analyzed on evidence it never read.

Measured impact: zero occurrences in production since 2026-08-25. Sessions close
after 30 minutes idle (packages/ingestion/retention/retention.go:19) and chunk
scrubbing completes in 170 seconds worst case since 2026-08-01, so the window
does not open at current traffic. Latent, not active.

Design review proposed a durable input generation rather than a debounce: bump a
readable generation only on the transition to readable, target each analysis job
at a generation, allow at most one pending successor per session via a partial
unique index, and record the analyzed generation on completion. A time-based
debounce alone would suppress the retry that currently masks this.

Related: `session_narratives` is reserved with ON CONFLICT DO NOTHING
(packages/worker/src/db.ts:3638), so a re-analysis never regenerates a
narrative. Whether narratives are snapshots or whole-session truth is an open
decision that belongs with this work.
EOF
)"
```

- [ ] **Step 2: File the permanently stuck chunks**

```bash
gh issue create --title "267 chunks are stuck unscrubbed and their sessions are marked analyzed anyway" --body "$(cat <<'EOF'
Chunk scrubbing gives up after 5 attempts (packages/ingestion/db/sessions.go:306).
Since 2026-08-25, 267 chunks have hit that ceiling and remain unscrubbed with
`scrub_error` set. An unscrubbed chunk is never readable, so no analysis reads
it, and its session is still marked analyzed.

Against 106,773 chunks scrubbed since 2026-09-01 that is roughly a quarter of a
percent. Small, but permanent and silent: nothing surfaces that a session was
analyzed on partial evidence.

Wanted: a signal that this is happening (count or alert), and a decision on
whether a session with permanently unreadable chunks should be marked as such
rather than plain `analyzed`.
EOF
)"
```

- [ ] **Step 3: Record the issue numbers**

Paste both issue URLs into this task's heading so the deferral is traceable from the plan.

---

## Testing and validation

| Requirement | Verified by |
| --- | --- |
| R1: Non-model jobs create no trace | `trace-policy.test.ts` for the policy; the initialised-tracing case in `trace-policy-gate.test.ts` for the absent span |
| R2: A new job type cannot default to untraced | `satisfies Record<JobType, TracePolicy>`; proven by `pnpm --filter @opslane/worker build` |
| R3: Traces are filterable by job type | `job.type` set first in `withJobTrace`; confirm in the Langfuse UI after deploy |
| R4: No caller of the old signature survives | Task 2 Step 6 runs all five affected suites |
| R5: A sustained export failure trips the breaker | `tracing-export-health.test.ts`, including the threshold and re-entrancy cases in Task 3 Step 8; then read `tracing_export` from the worker health endpoint |
| R6: Investigation output tokens are correct | `sdk-agent-usage.test.ts` for the extractor; the drain in Task 4 Step 5 is what makes it reachable, and only a live investigation proves it. Compare `job_usage.output_tokens` against diagnosis length before and after |
| R7: All six model call sites write a ledger row | `metered.test.ts`, `verify-ledger.test.ts`, `diff-judge-usage.test.ts`; then query `job_usage` for phases `verify`, `diff_judge`, `fix_narrative`, `digest_write`, `visual_analysis` after a live fix and digest run |
| R8: Verification input drops about fourfold | `capture-viewport.test.ts`; then compare `session_narratives.input_tokens` before and after deploy |

CI covers R1, R2, R4, R5, R6, R7 and R8 at the unit level. R3 and the live halves of R6, R7 and R8 need a deploy and a day of traffic. None of them gate the merge.

## Risks

- **The unit projection is an estimate.** Roughly 77,000 units a month for one customer comes from observation counts that could not be measured per job type, because job type was never recorded on a trace. Task 2 closes that gap. If real volume exceeds Core's 100,000, sampling arrives sooner. It is one mode plus one branch in `trace-policy.ts` and `withJobTrace`.
- **Half-scale frames may be unreadable.** Task 9 Step 4 is a human check precisely because no test can catch it. Falling back to 1024 by 640 still saves about half.
- **The circuit breaker counts lifetime failures, not consecutive ones.** This seam sees only failures, with no success signal to reset on, so a long-lived process with intermittent export errors will eventually trip it even while mostly healthy. That is the deliberate trade: a false suspension is recoverable by restart, a missed outage is what cost 17 days. There is no last-success timestamp.
- **The ledger stays best-effort.** `recordJobUsage` swallows database errors (`db.ts:451-455`), so `PhaseMeter` cannot detect a failed insert and a dropped row is invisible. Fine for analytics, not for billing. ADR 0001 already names durable writes and provider reconciliation as prerequisites for invoicing.
- **Two usage losses remain unfixed.** `sdk-agent.ts:402` throws on the `state.fatal` path, so accumulated usage on a sandbox death never reaches the caller or the ledger. And any model call that throws before its meter records anything, such as a rejected `complete()` in frame verification, loses its usage entirely. Both runs cost money. Out of scope here.
- **Unsolved, and stated flat:** content capture. `shouldExportSpan: () => true` (`tracing.ts:191`) exports every span, `new AnthropicInstrumentation()` (`tracing.ts:172`) is constructed with no trace config, and the only redaction in the tracing path strips credentials from diagnostic log lines. Nothing has exported since 2026-08-17 because ingestion refuses everything, so paying for Core turns this back on. **Settle it before the plan upgrade, not after.**

  Three things are now confirmed rather than assumed:

  - **Screenshots never leave.** The instrumentation records only type and media type for base64 images and explicitly does not store the data (`@arizeai/openinference-instrumentation-anthropic@0.1.21`, `dist/src/instrumentation.js:331-335`).
  - **Prompt and response text leaves in full** on the instrumented paths, via `INPUT_VALUE`, `OUTPUT_VALUE`, `LLM_INPUT_MESSAGES`, `LLM_OUTPUT_MESSAGES` and `MESSAGE_CONTENT_TEXT`.
  - **Investigations are not instrumented at all.** `runReadOnlyAgentSdk` calls `query` from `@anthropic-ai/claude-agent-sdk@0.3.251`, whose `sdk.mjs` is a 1.4MB bundle carrying its own inlined HTTP client (`api.anthropic.com`, `/v1/messages`, `x-api-key`, `anthropic-version` all appear in the bundle) and importing the peer `@anthropic-ai/sdk` nowhere at runtime. `manuallyInstrument` patches the worker's separate copy, which that bundle never touches.

  So the exposure is the inverse of the intuitive guess. The paths that read the customer's own source code, meaning investigate, friction investigation, inquiry, product context and route map, send no message content to Langfuse. The paths that read end users' session data, meaning narrate and verify, send it in full. The fix path is instrumented too and its prompts carry repository content.

  The remedy is configuration, not code: `hideInputText`, `hideInputMessages`, `hideInputs` and `hideOutputs` on a trace config passed to the instrumentation constructor, or the matching `OPENINFERENCE_HIDE_*` environment variables (`@arizeai/openinference-core@2.5.2`). Because investigations were never captured, applying it costs nothing there; the real trade is on narrate and verify, where the captured timeline is also what makes a bad narrative debuggable.

## Alternatives considered

- **Filter in `LangfuseSpanProcessor.shouldExportSpan`.** Rejected: it decides per span, so dropping a root while keeping children leaves orphans. The gate belongs at trace creation.
- **An allowlist inside `withJobTrace`.** Rejected: no compile-time protection, so the next job type is untraced by omission.
- **Head sampling now.** Deferred, not rejected. Right mechanism, but one customer fits inside Core without it and tuning a rate while ingestion is dark is tuning blind.
- **Upgrade the plan and change nothing.** Rejected as a complete answer, accepted as a stopgap. At current volume the status quo costs about $101 a month on Core against $29 with the gate, and it scales linearly per customer.
- **Lower `max_tokens` on narrate and verify.** Rejected on evidence: billing follows generated tokens, and the suggested range would truncate.
- **Prompt caching.** Investigated and dropped; see the Dropped section. Both system prompts fall under the 1,024-token minimum, so it would have been a silent no-op.
- **A `call_id` migration for the ledger key.** Rejected: `PhaseMeter` plus distinct phases per call site achieves the same thing without schema change. The one real collision risk, two judges sharing phase `judge`, is removed by giving the diff judge its own phase.
- **Switch narrate and verify to Haiku.** Deferred. About $7.50 a day, the largest single lever, but it changes output quality on a feature still being tuned with no eval set to prove it holds.
