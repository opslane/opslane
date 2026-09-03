# Agent Failures Stay Inside the System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the investigation machinery fails (a model limit, a provider outage, a missing setting, a dead sandbox), the customer never sees it. The incident stays inside the system, the operator is told, and the work re-runs itself once the cause is fixed. The customer sees a diagnosis, a PR, or a genuine evidence-based "could not find the cause", and nothing else.

**Architecture:** Four rules. (1) The read-only agent loop classifies how a run ended correctly: a typed SDK limit result wins over the SDK's follow-on throw, and API failures carry their HTTP status. (2) Every failure that is ours gets a class (`limit`, `agent`, `config`, `transient`) and dead-letters after the number of attempts that class deserves: one for the first three, `max_attempts` for transient. A dead letter no longer flips the incident to `needs_human`; the incident stays in `analyzing`, which no digest lane reads and which the dashboard shows as "Analyzing". (3) The worker re-runs its own dead letters: `limit`, `agent`, and `config` on the next worker boot (a fix for those is a deploy), `transient` on a 1h/4h/16h backoff, three times, then it gives up loudly. (4) Every dead letter, requeue, and give-up is a Slack operator event, a span attribute, and a `/health` counter. The worker also refuses to start half-configured. The incidents stranded on 2026-09-01 are repaired by a one-shot migration that hands them to rule 3.

**Tech Stack:** Node 22 + TypeScript + Vitest (`packages/worker`), `@anthropic-ai/claude-agent-sdk` 0.3.251, Go 1.24 + pgx migrations (`packages/ingestion/db/migrations`), Postgres.

**Spec:** the 2026-09-02 AMFJ 2 diagnosis, three Codex reviews, and the owner's decisions of the same day. Findings this plan implements:

1. `packages/worker/src/harness/sdk-agent.ts:351` overwrites a stop already set from a typed `result` message (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `success`+`is_error`) with `api_error` when SDK 0.3.251 throws `Claude Code returned an error result: Reached maximum number of turns (20)` after yielding the typed result.
2. `packages/worker/src/friction/investigate-friction.ts:229` throws one generic retryable error for every `api_error`, discarding status and usage. Every other non-verdict ending (`no_files_read`, `budget_exhausted`, `no_verdict_submitted`, `truncated_response`, `malformed_verdict`, citation validation) is written to the customer as `needs_human/insufficient_context` (`index.ts:1043`). None of those is a fact about the customer's evidence.
3. `packages/worker/src/db.ts:920-950` `reconcileDeadLetteredInvestigation` turns an abandoned investigate job into a customer-facing `needs_human/worker_runtime_error` card. Nothing re-runs it. Thirteen jobs (9 friction investigate, 4 inquiry) were stranded this way on 2026-09-01 by a missing sandbox template; two more by finding 1.
4. `packages/worker/src/index.ts:1749` lists `OPSLANE_E2B_JAVASCRIPT_TEMPLATE` as optional at startup while `sandbox-runtime.ts:171` requires it for every JavaScript sandbox on the default `e2b` backend.
5. Inquiry and product-context throw on every non-terminal stop and re-run the full budget three times (`inquiry/job.ts:205`, `product-context/job.ts:281`). `route_map` for AMFJ 2 last succeeded 2026-08-23 and has dead-lettered daily since 2026-08-30 on "exceeded its budget" ($0.50, 20 turns, 59 distinct routes). Routes seen since then have no tier or purpose, so their incidents are ranked with default priority.
6. Langfuse sees none of the read-only agent's model calls (the Agent SDK runs a subprocess the in-process Anthropic instrumentation cannot see); friction has no span; no Slack operator event fires on a dead letter (`usage-events.ts`, event list in `docs/design/2026-08-26-usage-events.md`).

Decisions taken (owner, 2026-09-02):

- **Agent failure is a system problem.** A limit stop, an agent that reads no files or never submits, a missing key or template, or an exhausted provider outage is never a `needs_human` card. `needs_human` is reserved for things the customer must act on: a fix that failed with a reason, a repository the worker cannot access, and evidence-based verdicts (`unfixable_no_app_frames`, `unfixable_third_party`, the error lane's `unable_to_establish_cause` when the model itself said so).
- **No pointless retries.** Running out of turns or budget is a signal the job or its budget is wrong. Such a job runs once. It re-runs only after a deploy, which is when a budget or config fix lands. Transient failures (408, 429, 5xx, dropped socket) retry with the queue's existing backoff, then re-run on a longer backoff, then give up.
- **Fix the budgets the evidence says are wrong.** `FRICTION_INVESTIGATION_MAX_TURNS` 20 → 30: both prod runs that hit 20 reached a verdict on their second run at about $0.25. Product context is diagnosed and fixed in Task 6 rather than guessed.
- **No new receipt states, no copy work.** The derived receipt machinery is debt (#452). Once system failures stop writing `needs_human`, the existing "Fix attempt failed" copy is wrong only for evidence-based verdicts, which #452 handles.
- **Startup requires the template only when an E2B key is present on the `e2b` backend.** A stack with no key is a supported dev configuration; the trap is a half-configured E2B. CI's e2e lane plants a canary key (`.github/workflows/ci.yml:306`), so Task 3 plants a canary template beside it.
- **`sdk-agent.ts` keeps its local error-message idiom** rather than importing `safeErrorMessage`, because two test files mock `logger.js` with only `logger` and load `sdk-agent.ts` transitively.

## Glossary

- **Dead letter:** a job the queue has stopped retrying. `error_group_jobs.status = 'dead_letter'`.
- **Limit stop:** the model hit its turn cap, dollar budget, or output-token ceiling.
- **Class:** why a job dead-lettered. `limit` (a cap), `agent` (the model read nothing, submitted nothing, or submitted garbage), `config` (a setting or credential is wrong), `transient` (the provider or network failed for every attempt).
- **Requeue:** flipping a dead-lettered job back to `pending` on the same row. The schema's comment on `uq_one_job_per_episode_type_version` (`054_pipeline_quality.sql:200`) already names this as the sanctioned retry path: "retries reclaim the same row".

## Global Constraints

- Work on the current branch `abhishekray07/agent-fail-v2` (already off `main`); every task commits here.
- ESM and strict TypeScript; `unknown` plus narrowing, never `any`. Vitest tests colocated in `__tests__`.
- `dead_letter` is still written only by `failJob`. Task 4 adds one explicit way to reach it before `max_attempts` (`{ exhaust: true }`) and records `attempts` truthfully. Requeue is the only path out of `dead_letter`, and it lives in one function.
- Do not clear `needs_human_at` when a group leaves `needs_human` (`db.test.ts:872`).
- The investigate handler accepts a group in `new`, `queued`, `analyzing`, or `candidate` (`index.ts:544`); a requeued job needs no status change on the group.
- Migrations live in `packages/ingestion/db/migrations`, are replayed on every ingestion boot with no ledger (`069_verdict_gated_investigation.sql:3-5`), so every statement must be idempotent and take the advisory lock the way 069 does.
- Worker checks: `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test`. Ingestion: `go build ./... && go test ./...` from `packages/ingestion`. DB-gated suites skip without `DATABASE_URL`; read the skip count.
- Commit after each task. Commit messages end with `Claude-Session: https://claude.ai/code/session_01T1VdbG2Ybtp2Een7v8E9yr`.

## Deployment order

1. Commit and apply the deploy repo's terraform change that sets `OPSLANE_E2B_JAVASCRIPT_TEMPLATE` on the worker task (`~/deploy/terraform/ecs.tf`, currently uncommitted). Task 3 makes the worker refuse to start without it.
2. Deploy ingestion first (migration 071 runs on its boot and repairs the stranded groups), then the worker (its boot requeues them).
3. Watch the operator Slack channel: expect `job_requeued` events for the repaired groups within a minute of the worker starting, then verdicts or `awaiting_approval` within the hour.

---

### Task 1: Typed SDK results win over the follow-on throw

**Files:**
- Modify: `packages/worker/src/harness/sdk-agent.ts:309-358`
- Test: `packages/worker/src/harness/__tests__/sdk-agent.test.ts:9,45,227-281`

**Interfaces:**
- Produces: unchanged signature `runReadOnlyAgentSdk(input: ReadOnlyRunInput): Promise<ReadOnlyRunResult>`. New guarantees: (a) once a typed **error or limit** `result` has classified the run, a later throw never changes `stop`, `apiErrorStatus`, or `apiErrorDetail`; a `success` result with `is_error === false` does not shield a later throw; (b) a throw whose message starts with `Claude Code returned an error result: Reached maximum number of turns` with no typed error result seen classifies as `turns_exhausted`; (c) `error_max_structured_output_retries` and any unknown error subtype classify as `api_error` with the SDK's text.

- [ ] **Step 1: Extend the fake so an assistant turn can be truncated**

`sdk-agent.test.ts` line 9:

```ts
  | { kind: 'assistant'; id?: string; text?: string; usage?: Partial<typeof DEFAULT_USAGE>; stopReason?: 'max_tokens' }
```

line 45: `stop_reason: action.stopReason ?? null,`.

- [ ] **Step 2: Write the failing tests**

Append inside `describe('how a run ends', ...)` after `'reports a thrown query as an api_error carrying its status'`:

```ts
  it('keeps turns_exhausted when the SDK throws after the typed max-turns result', async () => {
    sdk.actions.push(
      { kind: 'result', subtype: 'error_max_turns' },
      { kind: 'throw', error: new Error('Claude Code returned an error result: Reached maximum number of turns (20)') },
    );
    const out = await runReadOnlyAgentSdk(fakeInput());
    expect(out.stop).toBe('turns_exhausted');
    expect(out.apiErrorDetail).toBeUndefined();
    expect(sdk.returned).toHaveBeenCalled();
  });

  it('keeps budget when the SDK throws after the typed max-budget result', async () => {
    sdk.actions.push(
      { kind: 'result', subtype: 'error_max_budget_usd' },
      { kind: 'throw', error: new Error('Claude Code returned an error result: budget exceeded') },
    );
    expect((await runReadOnlyAgentSdk(fakeInput())).stop).toBe('budget');
  });

  it('keeps the typed api_error detail when the SDK throws afterwards', async () => {
    sdk.actions.push(
      { kind: 'result', subtype: 'success', isError: true },
      { kind: 'throw', error: new Error('Claude Code returned an error result: failed') },
    );
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({ stop: 'api_error', apiErrorStatus: 503, apiErrorDetail: 'failed' });
  });

  it('classifies a throw-only max-turns exit as turns_exhausted', async () => {
    sdk.actions.push({ kind: 'throw', error: new Error('Claude Code returned an error result: Reached maximum number of turns (20)') });
    expect((await runReadOnlyAgentSdk(fakeInput())).stop).toBe('turns_exhausted');
  });

  it('does not read an unrelated error that mentions turns as a limit', async () => {
    sdk.actions.push({ kind: 'throw', error: Object.assign(new Error('upstream 502: Reached maximum number of turns proxy page'), { status: 502 }) });
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({ stop: 'api_error', apiErrorStatus: 502 });
  });

  it('treats the structured-output retry limit as an api_error with its text', async () => {
    sdk.actions.push({ kind: 'result', subtype: 'error_max_structured_output_retries' });
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({ stop: 'api_error', apiErrorDetail: 'query failed' });
  });

  it('does not let a successful result shield a later transport failure', async () => {
    sdk.actions.push(
      { kind: 'result', subtype: 'success' },
      { kind: 'throw', error: Object.assign(new Error('stream died'), { status: 529 }) },
    );
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({ stop: 'api_error', apiErrorStatus: 529 });
  });

  it('does not let a truncated assistant turn hide a real transport failure', async () => {
    sdk.actions.push(
      { kind: 'assistant', text: 'partial', stopReason: 'max_tokens' },
      { kind: 'throw', error: Object.assign(new Error('stream died'), { status: 529 }) },
    );
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({ stop: 'api_error', apiErrorStatus: 529 });
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @opslane/worker exec vitest run src/harness/__tests__/sdk-agent.test.ts`
Expected: tests 1, 2, 4 FAIL on `stop`; test 3 FAILS on `apiErrorDetail`; test 6 FAILS (`no_tool_call`); tests 5, 7, 8 already PASS and pin behavior.

- [ ] **Step 4: Implement precedence**

In `sdk-agent.ts`, keep line 307 (`let lastModelText = '';`) and replace lines 309-358 (from `let stop: ReadOnlyStop = 'no_tool_call';` through the closing brace of the `catch`) with:

```ts
  let stop: ReadOnlyStop = 'no_tool_call';
  let apiErrorStatus: number | undefined;
  let apiErrorDetail: string | undefined;
  // Set once a typed error or limit `result` has classified the run. SDK
  // 0.3.251 enqueues that result and then errors the stream when the
  // subprocess exits non-zero, so the catch must not reinterpret a run the
  // SDK already explained. Only error/limit results set this: a successful
  // result followed by a stream failure is still a failure, and `truncated`
  // from an assistant message is not a terminal result at all.
  let typedErrorSeen = false;
  let costUsd = 0;
  const q = query({ prompt: input.firstMessage, options: buildQueryOptions(input, state) });

  try {
    for await (const message of q) {
      const next = usageFromMessage(message);
      if (next && message.type === 'assistant') {
        const id = message.message.id;
        const previous = seenUsage.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        addUsage(usage, {
          input: Math.max(0, next.input - previous.input),
          output: Math.max(0, next.output - previous.output),
          cacheRead: Math.max(0, next.cacheRead - previous.cacheRead),
          cacheWrite: Math.max(0, next.cacheWrite - previous.cacheWrite),
        });
        seenUsage.set(id, next);
        costUsd = calculateCost(usage, pricingFor(input.model));
        for (const block of message.message.content) {
          if (block.type === 'text') lastModelText = block.text;
        }
        if (message.error === 'max_output_tokens' || message.message.stop_reason === 'max_tokens') stop = 'truncated';
      }
      if (message.type === 'result') {
        if (message.subtype === 'error_max_turns') {
          stop = 'turns_exhausted';
          typedErrorSeen = true;
        } else if (message.subtype === 'error_max_budget_usd') {
          stop = 'budget';
          typedErrorSeen = true;
        } else if (message.subtype === 'success') {
          if (message.is_error) {
            stop = 'api_error';
            apiErrorDetail = message.result;
            if ('api_error_status' in message && typeof message.api_error_status === 'number') {
              apiErrorStatus = message.api_error_status;
            }
            typedErrorSeen = true;
          }
        } else {
          // error_during_execution, error_max_structured_output_retries, and
          // any subtype a later SDK adds: fail closed as an API error.
          stop = 'api_error';
          apiErrorDetail = message.errors.join('; ');
          typedErrorSeen = true;
        }
      }
      if (state.fatal) break;
      if (state.captured) { stop = 'terminal'; break; }
      if (costUsd > input.budgetUsd) { stop = 'budget'; break; }
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (state.fatal) {
      // The tool handler already recorded the machine death; fall through.
    } else if (typedErrorSeen) {
      logger.info('diagnose: SDK threw after a typed result; keeping the typed classification', { stop, error: detail });
    } else if (/^Claude Code returned an error result: Reached maximum number of turns/.test(detail)) {
      stop = 'turns_exhausted';
    } else {
      stop = 'api_error';
      apiErrorDetail = detail;
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number') apiErrorStatus = status;
      logger.warn('diagnose: SDK query failed', { error: apiErrorDetail, status: apiErrorStatus });
    }
  } finally {
```

Keep the `finally` and everything after it. If `tsc` rejects `message.errors` on the union, use `'errors' in message ? message.errors.join('; ') : String(message.subtype)`.

- [ ] **Step 5: Run to verify they pass, commit**

Run: `pnpm --filter @opslane/worker exec vitest run src/harness/__tests__/sdk-agent.test.ts`
Expected: PASS.

```bash
git add packages/worker/src/harness/sdk-agent.ts packages/worker/src/harness/__tests__/sdk-agent.test.ts
git commit -m "fix(worker): a typed SDK limit result survives the follow-on throw

Claude-Session: https://claude.ai/code/session_01T1VdbG2Ybtp2Een7v8E9yr"
```

---

### Task 2: Failure classes, and friction stops writing system failures to the customer

**Files:**
- Create: `packages/worker/src/harness/model-failure-policy.ts`, `packages/worker/src/harness/__tests__/model-failure-policy.test.ts`
- Modify: `packages/worker/src/harness/errors.ts` (append `NonRetryableJobError`)
- Modify: `packages/worker/src/friction/investigate-friction.ts:16,47-67,228-230`
- Modify: `packages/worker/src/index.ts:747-771` (error lane), `:952-970` (missing key), `:1042-1075` (friction incomplete and model failure)
- Modify: `packages/worker/src/inquiry/job.ts:204-207`, `packages/worker/src/product-context/job.ts:280-283`
- Test: `packages/worker/src/friction/__tests__/investigate-friction.test.ts:141-156`, `packages/worker/src/__tests__/index.test.ts:1189-1260`, inquiry and product-context model-call tests

**Interfaces:**
- Produces: `type DeadLetterClass = 'limit' | 'agent' | 'config' | 'transient'` and `classifyModelFailure(input: { status?: number; detail: string }): 'deterministic' | 'oversized' | 'transient'` in `model-failure-policy.ts`.
- Produces: `class NonRetryableJobError extends Error { name = 'NonRetryableJobError'; readonly deadLetterClass: DeadLetterClass; readonly stop?: string; readonly costUsd?: number }`.
- Produces: `FrictionInvestigationResult` gains `{ status: 'model_failure'; apiErrorStatus?: number; apiErrorDetail: string; investigatedCommit; usage; costUsd }`.
- The mapping every caller uses:

| Run ended with | Class | Attempts |
| --- | --- | --- |
| `turns_exhausted`, `budget`, `truncated` | `limit` | 1 |
| `no_tool_call`, `no_evidence`, malformed or unverifiable verdict | `agent` | 1 |
| `api_error` with deterministic 4xx (schema, model id, auth), oversized prompt, missing key or token | `config` | 1 |
| `api_error` with 408, 429, 5xx, or no status | `transient` | `max_attempts` (existing backoff) |

- [ ] **Step 1: Policy module and its test**

Create `packages/worker/src/harness/__tests__/model-failure-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyModelFailure, deadLetterClassForStop } from '../model-failure-policy.js';

describe('classifyModelFailure', () => {
  it('treats a request-construction 4xx as deterministic', () => {
    expect(classifyModelFailure({ status: 400, detail: 'tools.0.input_schema: maxItems' })).toBe('deterministic');
    expect(classifyModelFailure({ status: 401, detail: 'invalid x-api-key' })).toBe('deterministic');
  });
  it('treats 408, 429, 5xx, and no status as transient', () => {
    for (const status of [408, 429, 500, 529, undefined]) {
      expect(classifyModelFailure({ ...(status === undefined ? {} : { status }), detail: 'x' })).toBe('transient');
    }
  });
  it('recognises an oversized prompt', () => {
    expect(classifyModelFailure({ status: 400, detail: 'prompt is too long: 210000 tokens' })).toBe('oversized');
  });
});

describe('deadLetterClassForStop', () => {
  it('maps caps to limit and agent misbehaviour to agent', () => {
    expect(deadLetterClassForStop('turns_exhausted')).toBe('limit');
    expect(deadLetterClassForStop('budget')).toBe('limit');
    expect(deadLetterClassForStop('truncated')).toBe('limit');
    expect(deadLetterClassForStop('no_tool_call')).toBe('agent');
    expect(deadLetterClassForStop('no_evidence')).toBe('agent');
  });
});
```

Create `packages/worker/src/harness/model-failure-policy.ts`:

```ts
/**
 * Why a read-only agent job failed, and therefore how it is retried. A job
 * that ran out of turns or budget is a signal that the job or its budget is
 * wrong; re-running it buys the same answer at full price. It runs once and
 * re-runs after the next deploy. Only a provider or network failure earns
 * the queue's backoff retries. None of these is the customer's problem, so
 * none of them becomes a needs_human card.
 */
export type DeadLetterClass = 'limit' | 'agent' | 'config' | 'transient';
export type ModelFailureClass = 'deterministic' | 'oversized' | 'transient';

const OVERSIZED = /prompt is too long|too many tokens|exceeds? .*(context|token)/i;

export function classifyModelFailure(input: { status?: number; detail: string }): ModelFailureClass {
  const { status, detail } = input;
  if (status === 400 && OVERSIZED.test(detail)) return 'oversized';
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) return 'deterministic';
  return 'transient';
}

export function deadLetterClassForStop(stop: string): DeadLetterClass {
  switch (stop) {
    case 'turns_exhausted':
    case 'budget':
    case 'truncated':
      return 'limit';
    default:
      return 'agent';
  }
}
```

Append to `packages/worker/src/harness/errors.ts`:

```ts
import type { DeadLetterClass } from './model-failure-policy.js';

/**
 * A job outcome that retrying cannot change. The poller dead-letters it in
 * one execution and records the class so the requeue policy knows when it
 * is worth running again (Task 4).
 */
export class NonRetryableJobError extends Error {
  override readonly name = 'NonRetryableJobError';
  constructor(
    message: string,
    readonly deadLetterClass: DeadLetterClass,
    readonly detail: { stop?: string; costUsd?: number } = {},
  ) {
    super(message);
  }
}
```

Run: `pnpm --filter @opslane/worker exec vitest run src/harness/__tests__/model-failure-policy.test.ts`
Expected: PASS.

- [ ] **Step 2: Friction returns model failures**

In `investigate-friction.ts`, extend the union at lines 47-67 with the `model_failure` member (fields in Interfaces), and replace lines 228-230 with:

```ts
    case 'api_error':
      // Not thrown: the handler owns the policy and must record usage first.
      return {
        status: 'model_failure',
        ...(run.apiErrorStatus === undefined ? {} : { apiErrorStatus: run.apiErrorStatus }),
        apiErrorDetail: run.apiErrorDetail ?? 'model call failed',
        investigatedCommit: input.investigatedCommit,
        usage: run.usage,
        costUsd: run.costUsd,
      };
```

Line 16: `const MAX_TURNS = Number(process.env['FRICTION_INVESTIGATION_MAX_TURNS'] ?? 30);`. Update the row in `docs/reference/environment-variables.md` if present.

Replace the friction test at lines 141-144 (`'rethrows infrastructure failures so the poller retries'`) with:

```ts
  it('returns a model failure carrying status and the usage already paid', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(response([tool('list_files', { path: '.' })], USAGE))
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }));
    const out = await investigateFriction('key', input());
    expect(out).toMatchObject({ status: 'model_failure', apiErrorStatus: 529 });
    if (out.status !== 'model_failure') throw new Error('unreachable');
    expect(out.usage.input).toBe(USAGE.input_tokens);
    expect(out.costUsd).toBeGreaterThan(0);
  });
```

(`response`, `tool`, `USAGE` are that file's helpers, lines 146-150. If the shared fake surfaces the rejection as an `is_error` result, assert the status it forwards.)

- [ ] **Step 3: Friction handler: every non-verdict ending is a system failure**

In `index.ts`, the friction handler after `recordJobUsage` (line 1032) and `checkAbort`. Replace the whole `if (result.status === 'incomplete') { ... return; }` block (lines 1043-1075) with:

```ts
    if (result.status === 'model_failure') {
      const failureClass = classifyModelFailure({
        ...(result.apiErrorStatus === undefined ? {} : { status: result.apiErrorStatus }),
        detail: result.apiErrorDetail,
      });
      const statusText = result.apiErrorStatus === undefined ? '' : ` (HTTP ${result.apiErrorStatus})`;
      if (failureClass === 'transient') {
        // The queue's own backoff retries this up to max_attempts; the
        // final failure dead-letters as class transient (poller default).
        throw new Error(`Friction investigation model unavailable${statusText}: ${result.apiErrorDetail}`);
      }
      // Deterministic 4xx and oversized input: an operator problem. Once.
      throw new NonRetryableJobError(
        `Friction investigation model request rejected${statusText}: ${result.apiErrorDetail}`,
        'config',
        { stop: 'api_error', costUsd: result.costUsd },
      );
    }
    if (result.status === 'incomplete') {
      // The model ran out of room, read nothing, submitted nothing, or
      // submitted something unverifiable. None of that is a fact about the
      // customer's evidence; it is ours to fix. The decision row is still
      // written for forensics; the group stays in analyzing.
      await db.recordFrictionIncompleteDecision(job.errorGroupId, job.projectId, {
        outcome: 'incomplete' as const,
        decisionReason: result.reason,
        causeLocation: null,
        diagnosis: {
          evidence: result.rejected?.evidence ?? [],
          agentTaskBrief: result.rejected?.agentTaskBrief ?? null,
          investigatedCommit: result.investigatedCommit,
        },
        model: FRICTION_INVESTIGATION_MODEL,
        promptVersion: 'friction-diagnosis-v3',
        jobId: job.id,
        basis: 'friction_classify' as const,
        confidence: 'low' as const,
      });
      const stop = result.reason.split(':')[0] ?? 'incomplete';
      const deadLetterClass = ['budget_exhausted', 'truncated_response'].includes(stop) ? 'limit' : 'agent';
      throw new NonRetryableJobError(`Friction investigation incomplete: ${result.reason}`, deadLetterClass, {
        stop, costUsd: result.costUsd,
      });
    }
```

`db.recordFrictionIncompleteDecision` is the decision-only write. Today `updateGroupInvestigation(..., 'needs_human', { decision })` writes the decision row and the group status together; read `updateGroupInvestigation` in `db.ts` (find with `grep -n "export async function updateGroupInvestigation" packages/worker/src/db.ts`), extract the `diagnosis_decisions` insert it performs into a new exported `recordFrictionIncompleteDecision(errorGroupId, projectId, decision)` that performs only that insert, and call it from both places. If the decision insert is inseparable from the status write (a single transaction with a status guard), skip the forensic row for incompletes and say so in the commit message; the dead letter's `last_error` carries the reason.

Add the imports: `import { classifyModelFailure } from './harness/model-failure-policy.js';` and `NonRetryableJobError` from `./harness/errors.js`.

- [ ] **Step 4: Missing operator config is config, not needs_human**

`index.ts:955-965` (friction) and the equivalent in `processInvestigateJob` (`grep -n "missing_llm_key\|missing_github_token" packages/worker/src/index.ts`): replace each `updateGroupInvestigation(..., 'needs_human', { reason: { reason_code: 'missing_llm_key' ... } })` with

```ts
    throw new NonRetryableJobError('ANTHROPIC_API_KEY environment variable is not set', 'config');
```

(and the GitHub-token equivalent). `repo_access_denied` stays `needs_human`: the customer must grant access.

- [ ] **Step 5: Error lane uses the same policy**

`index.ts:747-771`: replace the `if (triage.stop === 'api_error') { ... }` block with:

```ts
    if (triage.stop === 'api_error') {
      const status = triage.apiErrorStatus;
      const detail = triage.apiErrorDetail ?? 'model call failed';
      const statusText = status === undefined ? '' : ` (HTTP ${status})`;
      if (classifyModelFailure({ ...(status === undefined ? {} : { status }), detail }) === 'transient') {
        throw new Error(`Investigation model unavailable${statusText}: ${detail}`);
      }
      throw new NonRetryableJobError(`Investigation model request rejected${statusText}: ${detail}`, 'config', {
        stop: 'api_error', costUsd: triage.costUsd,
      });
    }
```

This removes the "exhausted budget falls through to `unable_to_establish_cause`" path: a provider outage is no longer written to the customer as an evidence verdict. `unable_to_establish_cause` still happens when the model itself reports it cannot verify a cause (the `triage.outcome === 'incomplete'` branch at line 815), which is a real verdict. Find the tests in `index.test.ts` that assert the old fallthrough (`grep -n "unable_to_establish_cause" packages/worker/src/__tests__/index.test.ts`) and split them: the model-said-so case keeps `needs_human`; the api-error-exhausted case now expects a thrown `Error`.

- [ ] **Step 6: Inquiry and product-context**

`inquiry/job.ts:204-207`:

```ts
  if (result.stop !== 'terminal' || result.terminalInput === null) {
    if (result.stop === 'api_error') {
      const c = classifyModelFailure({ ...(result.apiErrorStatus === undefined ? {} : { status: result.apiErrorStatus }), detail: result.apiErrorDetail ?? '' });
      if (c === 'transient') throw new Error(inquiryStopMessage(result.stop));
      throw new NonRetryableJobError(inquiryStopMessage(result.stop), 'config', { stop: result.stop, costUsd: result.costUsd });
    }
    throw new NonRetryableJobError(inquiryStopMessage(result.stop), deadLetterClassForStop(result.stop), {
      stop: result.stop, costUsd: result.costUsd,
    });
  }
```

Identical shape in `product-context/job.ts:280-283` with `productContextStopMessage`. Check `toInfraError` (`inquiry/job.ts:248`) passes a `NonRetryableJobError` through unchanged; if it wraps, add `if (err instanceof NonRetryableJobError) return err;` at its top with a one-line test.

- [ ] **Step 7: Handler tests**

In `index.test.ts` `describe('friction worker path')`, add:

```ts
  const modelFailure = (status: number | undefined, detail: string) => ({
    status: 'model_failure' as const, investigatedCommit: 'abc123', costUsd: 0.4,
    usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 0 },
    ...(status === undefined ? {} : { apiErrorStatus: status }), apiErrorDetail: detail,
  });

  it('records usage, then retries a transient failure through the queue', async () => {
    vi.mocked(investigateFriction).mockResolvedValue(modelFailure(529, 'overloaded'));
    await expect(processInvestigateJob(makeJob(), new AbortController().signal))
      .rejects.toThrow(/model unavailable \(HTTP 529\)/);
    expect(db.recordJobUsage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.4 }));
    expect(db.updateGroupInvestigation).not.toHaveBeenCalled();
  });

  it('dead-letters a deterministic 4xx once, as config', async () => {
    vi.mocked(investigateFriction).mockResolvedValue(modelFailure(401, 'invalid x-api-key'));
    const err = await processInvestigateJob(makeJob(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableJobError);
    expect((err as NonRetryableJobError).deadLetterClass).toBe('config');
    expect(db.updateGroupInvestigation).not.toHaveBeenCalled();
  });

  it('never writes an incomplete investigation to the customer', async () => {
    vi.mocked(investigateFriction).mockResolvedValue({
      status: 'incomplete', reason: 'no_verdict_submitted: the model never called classify_friction',
      investigatedCommit: 'abc123', costUsd: 0.3, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const err = await processInvestigateJob(makeJob(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableJobError);
    expect((err as NonRetryableJobError).deadLetterClass).toBe('agent');
    expect(db.updateGroupInvestigation).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'needs_human', expect.anything(), expect.anything());
  });

  it('classifies a spend ceiling as limit', async () => {
    vi.mocked(investigateFriction).mockResolvedValue({
      status: 'incomplete', reason: 'budget_exhausted: spend ceiling reached before a verdict',
      investigatedCommit: 'abc123', costUsd: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const err = await processInvestigateJob(makeJob(), new AbortController().signal).catch((e: unknown) => e);
    expect((err as NonRetryableJobError).deadLetterClass).toBe('limit');
  });
```

Import `NonRetryableJobError` in the test. Update the existing friction tests that expected `needs_human`/`insufficient_context` for incompletes (`grep -n "insufficient_context" packages/worker/src/__tests__/index.test.ts`) to the new expectation. Add the two inquiry and product-context cases (limit stop → `NonRetryableJobError` with class `limit`; `api_error` 529 → plain `Error`).

- [ ] **Step 8: Run, build, commit**

Run: `pnpm --filter @opslane/worker exec vitest run src/harness src/friction src/inquiry src/product-context src/__tests__/index.test.ts && pnpm --filter @opslane/worker build`

```bash
git add packages/worker/src docs/reference/environment-variables.md
git commit -m "fix(worker): a system failure is a classed dead letter, never a needs_human card

Limit stops, agent misbehaviour, and bad config dead-letter once with a
class; provider failures use the queue's backoff. Friction, inquiry,
product-context and the error lane share one policy, and friction's turn
cap is 30 because both prod runs that hit 20 reached a verdict with room.

Claude-Session: https://claude.ai/code/session_01T1VdbG2Ybtp2Een7v8E9yr"
```

---

### Task 3: The worker refuses to start with an E2B key and no JavaScript template

**Files:**
- Create: `packages/worker/src/startup-env.ts`, `packages/worker/src/__tests__/startup-env.test.ts`
- Modify: `packages/worker/src/index.ts:1741-1757`, `.github/workflows/ci.yml:306`, `docs/reference/environment-variables.md:132`, `packages/worker/e2b-javascript/README.md`

**Interfaces:**
- Produces: `requiredEnvMissing(env): string[]`, `optionalEnvMissing(env): string[]`. Empty or whitespace counts as missing (`sandbox-runtime.ts:167` trims).

- [ ] **Step 1: Test**

Create `packages/worker/src/__tests__/startup-env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { optionalEnvMissing, requiredEnvMissing } from '../startup-env.js';

const base = { DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't' };

describe('requiredEnvMissing', () => {
  it('always requires DATABASE_URL', () => {
    expect(requiredEnvMissing({})).toContain('DATABASE_URL');
  });
  it('requires the JavaScript template once an E2B key is set on the default backend', () => {
    expect(requiredEnvMissing({ ...base, E2B_API_KEY: 'e2b' })).toEqual(['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
    expect(requiredEnvMissing({ ...base, E2B_API_KEY: 'e2b', OPSLANE_SANDBOX_BACKEND: 'e2b' })).toEqual(['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
  });
  it('treats an empty Compose interpolation as missing', () => {
    expect(requiredEnvMissing({ ...base, E2B_API_KEY: 'e2b', OPSLANE_E2B_JAVASCRIPT_TEMPLATE: '' })).toEqual(['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
    expect(requiredEnvMissing({ ...base, E2B_API_KEY: 'e2b', OPSLANE_E2B_JAVASCRIPT_TEMPLATE: '  ' })).toEqual(['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']);
  });
  it('keeps a stack without any E2B key starting, and the local backend too', () => {
    expect(requiredEnvMissing(base)).toEqual([]);
    expect(requiredEnvMissing({ ...base, E2B_API_KEY: '', OPSLANE_E2B_JAVASCRIPT_TEMPLATE: '' })).toEqual([]);
    expect(requiredEnvMissing({ ...base, E2B_API_KEY: 'e2b', OPSLANE_SANDBOX_BACKEND: 'local' })).toEqual([]);
  });
});

describe('optionalEnvMissing', () => {
  it('lists the keys whose absence only fails the jobs that need them', () => {
    expect(optionalEnvMissing({ DATABASE_URL: 'x' })).toEqual(['ANTHROPIC_API_KEY', 'E2B_API_KEY', 'GITHUB_TOKEN']);
  });
});
```

- [ ] **Step 2: Module**

Create `packages/worker/src/startup-env.ts`:

```ts
/**
 * Startup environment contract, split from main() so it is testable. An E2B
 * key on the e2b backend requires OPSLANE_E2B_JAVASCRIPT_TEMPLATE: a worker
 * deployed with the key and no template accepted work and dead-lettered
 * every JavaScript read-only job for fifty minutes on 2026-09-01. A stack
 * with no E2B key keeps starting, and so does the local harness backend.
 */
const ALWAYS_REQUIRED = ['DATABASE_URL'] as const;
const OPTIONAL = ['ANTHROPIC_API_KEY', 'E2B_API_KEY', 'GITHUB_TOKEN'] as const;

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

export function requiredEnvMissing(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = ALWAYS_REQUIRED.filter((key) => !present(env[key]));
  const backend = env['OPSLANE_SANDBOX_BACKEND']?.trim().toLowerCase() || 'e2b';
  if (backend === 'e2b' && present(env['E2B_API_KEY']) && !present(env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE'])) {
    missing.push('OPSLANE_E2B_JAVASCRIPT_TEMPLATE');
  }
  return missing;
}

export function optionalEnvMissing(env: NodeJS.ProcessEnv): string[] {
  return OPTIONAL.filter((key) => !present(env[key]));
}
```

- [ ] **Step 3: Wire main(), CI, docs**

`index.ts:1741-1757` becomes:

```ts
  const missingRequired = requiredEnvMissing(process.env);
  for (const key of missingRequired) logger.error('Missing required environment variable', { key });
  if (missingRequired.length > 0) process.exit(1);
  for (const key of optionalEnvMissing(process.env)) {
    logger.warn('Optional environment variable not set — jobs requiring it will fail', { key });
  }
```

with `import { optionalEnvMissing, requiredEnvMissing } from './startup-env.js';`.

`.github/workflows/ci.yml:306`, add below the canary key: `OPSLANE_E2B_JAVASCRIPT_TEMPLATE: opslane-e2e-canary-template`.

`docs/reference/environment-variables.md:132`: requirement column `when E2B_API_KEY is set`; append "The worker refuses to start when `E2B_API_KEY` is set and this is not." `packages/worker/e2b-javascript/README.md`: one sentence saying the same.

- [ ] **Step 4: Run, commit**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/startup-env.test.ts && pnpm --filter @opslane/worker build && docker compose config --quiet`

```bash
git add packages/worker/src/startup-env.ts packages/worker/src/__tests__/startup-env.test.ts packages/worker/src/index.ts .github/workflows/ci.yml docs/reference/environment-variables.md packages/worker/e2b-javascript/README.md
git commit -m "fix(worker): refuse to start with an E2B key and no JavaScript template

Claude-Session: https://claude.ai/code/session_01T1VdbG2Ybtp2Een7v8E9yr"
```

---

### Task 4: Dead letters are classed, stay inside the system, and re-run themselves

**Files:**
- Create: `packages/ingestion/db/migrations/071_dead_letter_class.sql`
- Modify: `packages/worker/src/db.ts:841-950` (`failJob`, delete `reconcileDeadLetteredInvestigation`'s status write), append `requeueDeadLetters`
- Modify: `packages/worker/src/poller.ts:160-168`
- Modify: `packages/worker/src/index.ts:1728-1740` (boot), `:1836` (reaper interval)
- Test: `packages/worker/src/__tests__/poller.test.ts:115`, `packages/worker/src/__tests__/db.test.ts` (DB-gated)

**Interfaces:**
- Schema: `error_group_jobs.dead_letter_class TEXT CHECK (IN ('limit','agent','config','transient'))`, `requeues INTEGER NOT NULL DEFAULT 0`, `requeued_at TIMESTAMPTZ`, `dead_lettered_at TIMESTAMPTZ`.
- Produces: `failJob(jobId, workerId, leaseGeneration, error, options?: { exhaust?: boolean; deadLetterClass?: DeadLetterClass })`. With `exhaust`, `dead_letter` now and `attempts + 1` (truthful). A dead letter without a class is `transient`.
- Produces: `requeueDeadLetters(trigger: 'boot' | 'interval'): Promise<RequeuedJob[]>`. `boot` requeues every `limit`/`agent`/`config` dead letter with `requeues < 3`. `interval` requeues `transient` dead letters whose `dead_lettered_at` is older than `1h × 4^requeues` (1h, 4h, 16h) with `requeues < 3`. Both flip the same row to `pending`, reset `attempts` to 0, set `worker_id`, `claimed_at`, `lease_expires_at` to NULL, `available_at = now()`, `requeues + 1`, `requeued_at = now()`. A dead letter at `requeues = 3` is left alone; Task 5 announces it as given up.
- Removes: the `needs_human/worker_runtime_error` write in `reconcileDeadLetteredInvestigation`. A dead-lettered investigate job leaves its group in `analyzing`, which is now the intended state: invisible to every digest lane (`onCardStatusSQL` at `actionable.go:104`, `receiptItemsFromClause` at `build.go:81`), shown as "Analyzing" on the dashboard (`status-recipes.ts:42`), and accepted by the investigate handler on requeue.
- Backfill in 071: every `needs_human` group with `reason_code = 'worker_runtime_error'` whose `terminal_fix_job_id` is a dead-lettered `investigate` job goes back to `analyzing` with the reason fields cleared, `terminal_fix_job_id` cleared, and the job classed `config` with `requeues = 0`. The next worker boot re-runs them. `needs_human_at` is retained.

- [ ] **Step 1: Migration**

Create `packages/ingestion/db/migrations/071_dead_letter_class.sql`:

```sql
-- 071_dead_letter_class.sql
BEGIN;
-- Replayed on every ingestion boot with no ledger; every statement below is
-- idempotent and the lock keeps concurrent boots from racing the backfill.
SELECT pg_advisory_xact_lock(hashtext('071_dead_letter_class'));

-- Why a job dead-lettered decides when the worker re-runs it (worker
-- db.ts requeueDeadLetters): limit/agent/config after the next deploy,
-- transient on a 1h/4h/16h backoff, three times, then it is left alone.
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS dead_letter_class TEXT;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS requeues INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMPTZ;
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'error_group_jobs_dead_letter_class_check') THEN
    ALTER TABLE error_group_jobs ADD CONSTRAINT error_group_jobs_dead_letter_class_check
      CHECK (dead_letter_class IS NULL OR dead_letter_class IN ('limit','agent','config','transient'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_error_group_jobs_dead_letter_requeue
  ON error_group_jobs (dead_letter_class, requeues, dead_lettered_at)
  WHERE status = 'dead_letter';

-- Decision 2026-09-02: an abandoned investigation is a system failure, not a
-- needs_human card. Repair the incidents the old reconciler stranded
-- (2026-09-01 missing template, max-turns misclassification): back to
-- analyzing, and the dead job classed config so the next worker boot re-runs
-- it. needs_human_at is retained on purpose. Idempotent: once repaired the
-- predicate is false.
WITH stranded AS (
  SELECT g.id AS group_id, g.project_id, j.id AS job_id
    FROM error_groups g
    JOIN error_group_jobs j ON j.id = g.terminal_fix_job_id AND j.project_id = g.project_id
   WHERE g.status = 'needs_human'
     AND g.reason_code = 'worker_runtime_error'
     AND j.job_type = 'investigate'
     AND j.status = 'dead_letter'
     AND j.dead_letter_class IS NULL
),
groups AS (
  UPDATE error_groups g
     SET status = 'analyzing', reason_code = NULL, reason_message = NULL, remediation = NULL,
         terminal_fix_job_id = NULL, updated_at = now()
    FROM stranded s
   WHERE g.id = s.group_id AND g.project_id = s.project_id
  RETURNING s.job_id
)
UPDATE error_group_jobs j
   SET dead_letter_class = 'config', requeues = 0, dead_lettered_at = COALESCE(j.dead_lettered_at, j.updated_at)
  FROM groups
 WHERE j.id = groups.job_id;

COMMIT;
```

Check how the migration runner handles `BEGIN`/`COMMIT` inside files by reading 069 to its end and matching it exactly. Add a Go test in `packages/ingestion/db` following the pattern of `migration_069_test.go` (if present; `ls packages/ingestion/db/migration_0*_test.go`): seed a `needs_human`/`worker_runtime_error` group whose terminal job is a dead-lettered investigate, run the migrations, assert the group is `analyzing` with reason fields NULL and `needs_human_at` retained, and the job has `dead_letter_class = 'config'`; run the migrations again and assert nothing changes.

- [ ] **Step 2: Failing poller tests**

Beside `'should call failJob when processJob throws'` (`poller.test.ts:115`):

```ts
  it('exhausts a NonRetryableJobError in one attempt with its class', async () => {
    const { NonRetryableJobError } = await import('../harness/errors.js');
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);
    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new NonRetryableJobError('Inquiry ran out of turns', 'limit', { stop: 'turns_exhausted', costUsd: 0.31 }));
    const poller = createPoller({ intervalMs: 1000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFailJob).toHaveBeenCalledWith(job.id, 'test-worker', job.leaseGeneration, 'Inquiry ran out of turns',
      { exhaust: true, deadLetterClass: 'limit' });
    await poller.stop();
  });

  it('retries an ordinary failure through the queue', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);
    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockRejectedValue(new Error('socket hang up'));
    const poller = createPoller({ intervalMs: 1000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFailJob).toHaveBeenCalledWith(job.id, 'test-worker', job.leaseGeneration, 'socket hang up', undefined);
    await poller.stop();
  });
```

Update the existing assertion at line 115's test to the five-argument form.

- [ ] **Step 3: Failing DB tests**

In `db.test.ts`, in the DB-gated describe that exercises `failJob` (find with `grep -n "failJob" packages/worker/src/__tests__/db.test.ts`), using that file's insert/claim helpers:

```ts
  it('exhausts in one attempt and records the class', async () => {
    const jobId = await insertPendingJob({ maxAttempts: 3 });
    const claimed = await claimJob(workerId);
    await failJob(jobId, workerId, claimed!.leaseGeneration, 'ran out of turns', { exhaust: true, deadLetterClass: 'limit' });
    const row = (await pool.query(`SELECT status, attempts, dead_letter_class, dead_lettered_at FROM error_group_jobs WHERE id = $1`, [jobId])).rows[0];
    expect(row).toMatchObject({ status: 'dead_letter', attempts: 1, dead_letter_class: 'limit' });
    expect(row.dead_lettered_at).not.toBeNull();
  });

  it('a max-attempts dead letter is classed transient', async () => {
    const jobId = await insertPendingJob({ maxAttempts: 1 });
    const claimed = await claimJob(workerId);
    await failJob(jobId, workerId, claimed!.leaseGeneration, 'socket hang up');
    expect((await pool.query(`SELECT dead_letter_class FROM error_group_jobs WHERE id = $1`, [jobId])).rows[0].dead_letter_class).toBe('transient');
  });

  it('a dead-lettered investigation leaves its group in analyzing', async () => {
    const { groupId, jobId } = await insertAnalyzingGroupWithClaimedInvestigateJob(); // compose from the file's helpers
    await failJob(jobId, workerId, leaseGenerationOf(jobId), 'template missing', { exhaust: true, deadLetterClass: 'config' });
    expect((await pool.query(`SELECT status, reason_code FROM error_groups WHERE id = $1`, [groupId])).rows[0])
      .toMatchObject({ status: 'analyzing', reason_code: null });
  });

  it('boot requeues limit, agent, and config dead letters once each, up to three times', async () => {
    const ids = await Promise.all((['limit', 'agent', 'config', 'transient'] as const).map((c) => deadLetteredJob(c)));
    const first = await requeueDeadLetters('boot');
    expect(first.map((r) => r.id).sort()).toEqual(ids.slice(0, 3).sort());
    for (const id of ids.slice(0, 3)) {
      const row = (await pool.query(`SELECT status, attempts, requeues, worker_id FROM error_group_jobs WHERE id = $1`, [id])).rows[0];
      expect(row).toMatchObject({ status: 'pending', attempts: 0, requeues: 1, worker_id: null });
    }
    await pool.query(`UPDATE error_group_jobs SET status = 'dead_letter', requeues = 3 WHERE id = ANY($1)`, [ids.slice(0, 3)]);
    expect(await requeueDeadLetters('boot')).toEqual([]);
  });

  it('interval requeues transient dead letters on a 1h/4h/16h backoff', async () => {
    const id = await deadLetteredJob('transient');
    expect(await requeueDeadLetters('interval')).toEqual([]);
    await pool.query(`UPDATE error_group_jobs SET dead_lettered_at = now() - interval '61 minutes' WHERE id = $1`, [id]);
    expect((await requeueDeadLetters('interval')).map((r) => r.id)).toEqual([id]);
    await pool.query(`UPDATE error_group_jobs SET status = 'dead_letter', dead_lettered_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    expect(await requeueDeadLetters('interval')).toEqual([]); // requeues=1 needs 4h
    await pool.query(`UPDATE error_group_jobs SET dead_lettered_at = now() - interval '5 hours' WHERE id = $1`, [id]);
    expect((await requeueDeadLetters('interval')).map((r) => r.id)).toEqual([id]);
  });
```

`deadLetteredJob(class)` inserts a job row directly in `dead_letter` with the class, `requeues = 0`, `dead_lettered_at = now()`; write it as a local helper in the test file. Compose `insertAnalyzingGroupWithClaimedInvestigateJob` from the file's existing group and job seeds.

- [ ] **Step 4: failJob**

`db.ts:841`: signature per Interfaces. In the UPDATE, `$5`/`$6` are the backoff base and cap; add `$7::boolean` (exhaust) and `$8::text` (class). Every `attempts + 1 >= max_attempts` test becomes `($7::boolean OR attempts + 1 >= max_attempts)`. Add to SET:

```sql
           dead_letter_class = CASE
             WHEN $7::boolean OR attempts + 1 >= max_attempts THEN COALESCE($8::text, 'transient')
             ELSE dead_letter_class
           END,
           dead_lettered_at = CASE
             WHEN $7::boolean OR attempts + 1 >= max_attempts THEN now()
             ELSE dead_lettered_at
           END,
```

and `RETURNING status, job_type, project_id, error_group_id, attempts, dead_letter_class`. Parameters: `[..., RETRY_BACKOFF_CAP_SECONDS, options?.exhaust === true, options?.deadLetterClass ?? null]`.

Delete the `updateGroupStatus(..., 'needs_human', ...)` call inside `reconcileDeadLetteredInvestigation` (lines 936-947) and the `if (group.rows[0]?.status !== 'analyzing') return;` guard; the function body becomes a single `logger.info('Investigation dead-lettered; group stays in analyzing for requeue', { error_group_id, job_id })`. Rename it `logDeadLetteredInvestigation` and update its call site at line 908. Update the JSDoc above it to say why.

Append `requeueDeadLetters`:

```ts
export interface RequeuedJob { id: string; jobType: JobType; projectId: string; errorGroupId: string | null; deadLetterClass: string; requeues: number }

/**
 * The only path out of dead_letter. `boot` re-runs the classes whose fix is
 * a deploy (limit, agent, config); `interval` re-runs transient failures on
 * a 1h/4h/16h backoff. Three requeues, then the row is left alone and Task 5
 * announces it as given up.
 */
export async function requeueDeadLetters(trigger: 'boot' | 'interval'): Promise<RequeuedJob[]> {
  const classes = trigger === 'boot' ? ['limit', 'agent', 'config'] : ['transient'];
  const { rows } = await getPool().query<{
    id: string; job_type: JobType; project_id: string; error_group_id: string | null; dead_letter_class: string; requeues: number;
  }>(
    `UPDATE error_group_jobs
        SET status = 'pending'::job_status, attempts = 0, worker_id = NULL, claimed_at = NULL,
            lease_expires_at = NULL, available_at = now(), requeues = requeues + 1, requeued_at = now(),
            last_error = NULL, updated_at = now()
      WHERE status = 'dead_letter'
        AND dead_letter_class = ANY($1::text[])
        AND requeues < 3
        AND ($2::boolean OR dead_lettered_at <= now() - make_interval(hours => power(4, requeues)::int))
      RETURNING id, job_type, project_id, error_group_id, dead_letter_class, requeues`,
    [classes, trigger === 'boot'],
  );
  return rows.map((r) => ({
    id: r.id, jobType: r.job_type, projectId: r.project_id, errorGroupId: r.error_group_id,
    deadLetterClass: r.dead_letter_class, requeues: r.requeues,
  }));
}
```

Check `session_analysis` dead letters: `reconcileDeadLetteredSessionAnalysis` (line 902) releases claimed signals; a requeued session-analysis job must be able to reclaim them. Read that function; if requeue would strand signals, exclude `job_type = 'session_analysis'` from `requeueDeadLetters` with a comment and a test, and file it in Task 8's follow-ups.

- [ ] **Step 5: Poller and boot**

`poller.ts:168`:

```ts
        const nonRetryable = err instanceof Error && err.name === 'NonRetryableJobError'
          ? (err as { deadLetterClass?: string; detail?: { stop?: string; costUsd?: number } })
          : null;
        const failed = await failJob(job.id, workerId, job.leaseGeneration, message,
          nonRetryable ? { exhaust: true, deadLetterClass: nonRetryable.deadLetterClass as never } : undefined);
```

(type the class properly by importing `DeadLetterClass`; the `as never` is only if the import creates a cycle.) Add `non_retryable: nonRetryable !== null, stop: nonRetryable?.detail?.stop, cost_usd: nonRetryable?.detail?.costUsd` to the `Job failed` log fields.

`index.ts` `main()`, after the clone sweep (line 1739) and after the required-env check, add:

```ts
  const requeued = await requeueDeadLetters('boot');
  if (requeued.length > 0) {
    logger.info('Requeued dead letters on boot', { count: requeued.length, classes: requeued.map((r) => r.deadLetterClass) });
  }
```

At the reaper interval (line 1836, `requeueStaleJobs()`), add a sibling call `requeueDeadLetters('interval')` on the same cadence, logging the count when non-zero. Task 5 turns both into Slack events.

- [ ] **Step 6: Run, build, commit**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/poller.test.ts src/__tests__/db.test.ts && pnpm --filter @opslane/worker build && (cd packages/ingestion && go build ./... && DATABASE_URL=$DATABASE_URL go test ./db)`

```bash
git add packages/ingestion/db/migrations/071_dead_letter_class.sql packages/ingestion/db packages/worker/src
git commit -m "feat(worker): dead letters are classed, stay inside the system, and re-run themselves

An abandoned investigation no longer becomes a needs_human card; the group
stays in analyzing, invisible to the digest. limit/agent/config dead letters
re-run on the next worker boot, transient ones on a 1h/4h/16h backoff, three
times. Migration 071 repairs the incidents stranded on 2026-09-01.

Claude-Session: https://claude.ai/code/session_01T1VdbG2Ybtp2Een7v8E9yr"
```

---

### Task 5: Every dead letter, requeue, and give-up is visible

**Files:**
- Modify: `packages/worker/src/tracing.ts` (append `annotateActiveSpan`), `packages/worker/src/harness/sdk-agent.ts` (annotate before return), `packages/worker/src/friction/investigate-friction.ts:214` (span)
- Modify: `packages/worker/src/db.ts` (`failJob` emits `job_dead_lettered`; `requeueDeadLetters` emits `job_requeued` and `job_given_up`)
- Modify: `packages/worker/src/index.ts:1767-1790` (`/health` gains `dead_letters_24h`), `packages/worker/src/db.ts` (`getDeadLetterCounts`)
- Modify: `docs/design/2026-08-26-usage-events.md`, `docs/reference/environment-variables.md`
- Test: `sdk-agent.test.ts`, `db.test.ts`, `packages/worker/src/__tests__/health.test.ts` (or wherever `computeHealthStatus` is tested; `grep -rn "computeHealthStatus" packages/worker/src/__tests__`)

**Interfaces:**
- Produces: `annotateActiveSpan(attrs)`; span attributes `agent.stop`, `agent.cost_usd`, `agent.files_read`, `agent.input_tokens`, `agent.output_tokens`, optional `agent.api_error_status`, `agent.api_error_detail` (200 chars).
- Produces Slack operator events: `job_dead_lettered` {job_id, project_id, job_type, class, attempts, requeues, last_error (300 chars, scrubbed)}, `job_requeued` {job_id, project_id, job_type, class, requeues, trigger}, `job_given_up` {job_id, project_id, job_type, class, last_error} emitted when a dead letter reaches `requeues = 3` (checked inside `failJob` when the new dead letter's `requeues` is already 3).
- Produces: `/health` JSON gains `dead_letters_24h: [{ job_type, class, count }]` from `getDeadLetterCounts()`, sampled with the queue depth.

- [ ] **Step 1: Span attributes**

`sdk-agent.test.ts`: add beside the SDK mock

```ts
const tracing = vi.hoisted(() => ({ annotate: vi.fn() }));
vi.mock('../../tracing.js', () => ({ annotateActiveSpan: tracing.annotate }));
```

with `tracing.annotate.mockClear()` in `beforeEach`, and:

```ts
  it('annotates the enclosing span with how the run ended and what it cost', async () => {
    sdk.actions.push({ kind: 'assistant', text: 'looking' }, { kind: 'result', subtype: 'error_max_turns' });
    await runReadOnlyAgentSdk(fakeInput());
    expect(tracing.annotate).toHaveBeenCalledWith(expect.objectContaining({
      'agent.stop': 'turns_exhausted', 'agent.cost_usd': expect.any(Number),
      'agent.input_tokens': 100, 'agent.output_tokens': 20, 'agent.files_read': 0,
    }));
  });
```

Append to `tracing.ts` (it already imports `trace` and `context` from `@opentelemetry/api`):

```ts
/** Attach attributes to whichever span is active; no-op without tracing. */
export function annotateActiveSpan(attributes: Record<string, string | number | boolean>): void {
  const span = trace.getSpan(context.active());
  if (!span) return;
  for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
}
```

In `sdk-agent.ts`, import it and, immediately before the final `return {` of `runReadOnlyAgentSdk`, add:

```ts
  annotateActiveSpan({
    'agent.stop': stop, 'agent.cost_usd': costUsd, 'agent.files_read': state.filesRead.size,
    'agent.input_tokens': usage.input, 'agent.output_tokens': usage.output,
    ...(apiErrorStatus === undefined ? {} : { 'agent.api_error_status': apiErrorStatus }),
    ...(apiErrorDetail === undefined ? {} : { 'agent.api_error_detail': apiErrorDetail.slice(0, 200) }),
  });
```

In `investigate-friction.ts:214`, wrap the run the way `inquiry/job.ts:189` does: `traceSpan('friction.investigate', { 'friction.model': FRICTION_INVESTIGATION_MODEL, 'friction.max_turns': MAX_TURNS, 'friction.budget_usd': BUDGET_USD }, () => runReadOnlyAgentSdk({...}))`, importing `traceSpan` from `../tracing.js`.

- [ ] **Step 2: Slack events**

In `db.ts` `failJob`, after `COMMIT` (line 906):

```ts
    if (row && row.status === 'dead_letter') {
      emitUsageEvent('job_dead_lettered', {
        job_id: jobId, project_id: row.project_id, job_type: row.job_type,
        class: row.dead_letter_class ?? 'transient', attempts: String(row.attempts), requeues: String(row.requeues),
        last_error: scrubSecrets(error).slice(0, 300),
      });
      if (row.requeues >= 3) {
        emitUsageEvent('job_given_up', {
          job_id: jobId, project_id: row.project_id, job_type: row.job_type,
          class: row.dead_letter_class ?? 'transient', last_error: scrubSecrets(error).slice(0, 300),
        });
      }
    }
```

(add `requeues` to the RETURNING list and row type). In `requeueDeadLetters`, after the query, one `emitUsageEvent('job_requeued', {...})` per row with `trigger`. Import `emitUsageEvent` from `./usage-events.js` and `scrubSecrets` from `./harness/redact.js` if not already imported in `db.ts`.

DB tests: mock `../usage-events.js` in `db.test.ts`; assert `job_dead_lettered` with `class: 'limit'` on the exhaust test, no event on a non-final ordinary failure, `job_requeued` with `trigger: 'boot'` on the boot test, and `job_given_up` when a job with `requeues = 3` dead-letters again.

- [ ] **Step 3: /health**

Append to `db.ts`:

```ts
export async function getDeadLetterCounts(): Promise<Array<{ jobType: string; deadLetterClass: string; count: number }>> {
  const { rows } = await getPool().query<{ job_type: string; dead_letter_class: string | null; count: string }>(
    `SELECT job_type, dead_letter_class, count(*)::text AS count
       FROM error_group_jobs
      WHERE status = 'dead_letter' AND dead_lettered_at > now() - interval '24 hours'
      GROUP BY 1, 2`,
  );
  return rows.map((r) => ({ jobType: r.job_type, deadLetterClass: r.dead_letter_class ?? 'unclassed', count: Number(r.count) }));
}
```

In `index.ts`, sample it beside `getQueueDepth()` (line 1809) into a module-level `deadLetterCounts`, and add `dead_letters_24h: deadLetterCounts.map((d) => ({ job_type: d.jobType, class: d.deadLetterClass, count: d.count }))` to the `/health` JSON (line 1767-1790). Health status stays as it is; the counts are for the operator and for the Task 8 completion-rate check. Document the field in `docs/reference/environment-variables.md`'s `HEALTH_PORT` row.

- [ ] **Step 4: Document events, run, commit**

`docs/design/2026-08-26-usage-events.md`: add the three events with their fields and the sentence "`attempts` is the number of executions that actually ran; `requeues` how many times the worker has re-run the dead letter."

Run: `pnpm --filter @opslane/worker exec vitest run src/harness src/friction src/__tests__/db.test.ts src/__tests__/poller.test.ts && pnpm --filter @opslane/worker build`

```bash
git add packages/worker/src docs/design/2026-08-26-usage-events.md docs/reference/environment-variables.md
git commit -m "feat(worker): dead letters, requeues, and give-ups are visible in the span, Slack, and /health

Claude-Session: https://claude.ai/code/session_01T1VdbG2Ybtp2Een7v8E9yr"
```

---

### Task 6: The route classifier works again for AMFJ 2

**Files:**
- Modify: `packages/worker/src/product-context/job.ts:255-270` (budget), possibly `packages/worker/src/product-context/*.ts` (batching)
- Test: `packages/worker/src/product-context/__tests__/` (existing), one local reproduction record in the PR

**Why:** `route_map` for AMFJ 2 last succeeded 2026-08-23 and has dead-lettered on "exceeded its budget" every day since 2026-08-30 (`$0.50`, 20 turns, hard-coded at `product-context/job.ts:264-265`; 59 distinct routes with live incidents). Routes seen since Aug 23 have no tier or purpose, so their incidents get default priority weighting (`priority/sweeper.go:94-108`) and blank route context in cards and investigation prompts. After Task 4 the job runs once a day and re-runs after each deploy, so a fix here lands on the next boot.

- [ ] **Step 1: Reproduce locally and measure**

Run the worker against the AMFJ repository (`~/asset-management-jira`, branch `master`; the memory notes say prod deploys from it) with the local harness backend (`OPSLANE_SANDBOX_BACKEND=local OPSLANE_RELIABILITY_HARNESS=1`) and a real `ANTHROPIC_API_KEY`, enqueue one `route_map` job for a local project pointed at that repo, and capture from the Task 5 span attributes: `agent.stop`, `agent.cost_usd`, `agent.files_read`, and the number of routes `prepared.routes` discovered (log it at `product-context/job.ts:322`). Record the three numbers in the PR. Then run once more with `budgetUsd: 2.0, maxTurns: 60` to learn what the job actually needs.

- [ ] **Step 2: Decide the fix from the measurement**

Two acceptable outcomes; pick by the numbers:

- If the second run completes with all discovered routes classified: scale the budget with the route count. In `job.ts:264-265` replace the constants with `maxTurns: Math.min(80, 20 + Math.ceil(input.routes.length / 2))` and `budgetUsd: Math.min(3, 0.5 + 0.03 * input.routes.length)`, and make both overridable by `PRODUCT_CONTEXT_MAX_TURNS` / `PRODUCT_CONTEXT_BUDGET_USD`. Add a unit test for the scaling function (extract it as `productContextLimits(routeCount)`).
- If it does not, or the cost is over $3: batch. Split `prepared.routes` into groups of 20, run the model once per group with the group's routes only, merge claims before `groundRouteClaims`. Add a test that a 45-route input produces three model calls and one merged claim set.

Either way the acceptance check is the same and is run in Step 3.

- [ ] **Step 3: Acceptance**

Locally, with the AMFJ repo: the `route_map` job completes, and `SELECT count(*) FROM route_map WHERE project_id = $1` equals the number of routes discovered in Step 1, and no `job_dead_lettered` event fired. Record the SQL result in the PR. In prod, after deploy, confirm within 24 hours that AMFJ 2's `route_map` job completed and `SELECT max(created_at) FROM route_map WHERE project_id = '5a64d496-0dd0-48a3-aebd-f2ad636e3b44'` is newer than the deploy.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/product-context
git commit -m "fix(worker): the route classifier fits its budget again

Claude-Session: https://claude.ai/code/session_01T1VdbG2Ybtp2Een7v8E9yr"
```

---

### Task 7: Gate, live smoke, follow-ups, PR

- [ ] **Step 1: Repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Export `DATABASE_URL` from a Compose Postgres first; report the skip count.

- [ ] **Step 2: Live smoke, in this order**

Worktree stack per `AGENTS.md` (free port triple, migrations, `scripts/seed-e2e.sql`, rebuilt ingestion and worker). Point `USAGE_EVENTS_SLACK_WEBHOOK` at a test channel or the in-network sink. Promotion needs three distinct sessions on the same dead control (`promotion.ts:11`).

1. **Startup guard.** Worker with `E2B_API_KEY=x` and no template exits naming the template. Start it again with `OPSLANE_E2B_JAVASCRIPT_TEMPLATE=does-not-exist`.
2. **A system failure stays inside.** Promote friction incident A. Expected: the investigate job `dead_letter` with `dead_letter_class = 'transient'` (a `SandboxImageError` is thrown as an ordinary error today; if Task 2 classes it, expect `config`) and `attempts = 3`; the group stays `analyzing`; one `job_dead_lettered` Slack event; the incident does not appear in a digest sweep run now; the dashboard shows it as "Analyzing".
3. **Boot requeue.** Stop the worker, restart it with the real template. Expected: `job_requeued` with `trigger=boot` for incident A's job within a minute (if its class is `transient`, first `UPDATE error_group_jobs SET dead_letter_class = 'config' WHERE id = ...` to exercise the boot path, and note it), then a verdict or `awaiting_approval` for incident A, never `needs_human/worker_runtime_error`.
4. **Limit stop is one execution.** Restart with `FRICTION_INVESTIGATION_MAX_TURNS=1`, promote incident B. Expected in every case: either a verdict, or one `job_dead_lettered` event with `class` `limit` or `agent` and `attempts = 1`, the group in `analyzing`, and no digest card. Do not assert the stop text; the model may submit within one turn.
5. **Backoff requeue.** For incident B's dead letter (if any), `UPDATE error_group_jobs SET dead_letter_class = 'transient', dead_lettered_at = now() - interval '2 hours' WHERE id = ...`, wait one reaper interval, expect `job_requeued` with `trigger=interval`.
6. **/health** reports `dead_letters_24h` with the rows above.

Record the SQL and events in the PR.

- [ ] **Step 3: Follow-ups**

From the repository root, search first (`gh issue list --state all --search "<keywords>"`), then:

- Comment on #451 that this PR implements the auto-retry (Task 4) and the alert (Task 5), and close it when the PR merges.
- Comment on #71 that Task 2 gives every read-only lane transient-aware retries and no longer terminalizes an outage as `needs_human`; close when merged.
- Link #452 (receipt-line debt) from the PR body; note that with system failures out of `needs_human`, its remaining wrong case is evidence-based verdicts.
- File "Read-only agent model calls are invisible in Langfuse" (subprocess; Task 5's attributes are the interim) if no open issue covers it.
- File anything Task 4 excluded (session-analysis requeue) if it came up.

- [ ] **Step 4: PR**

Push and open a PR against `main` titled `fix: agent failures stay inside the system and re-run themselves`. Body: the six findings, the decisions, the deployment order (terraform, then ingestion, then worker), the smoke evidence, the Task 6 measurements, and the issue links. End with `https://claude.ai/code/session_01T1VdbG2Ybtp2Een7v8E9yr`.
