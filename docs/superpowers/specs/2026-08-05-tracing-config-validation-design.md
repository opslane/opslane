# Worker tracing: fail loud on partial Langfuse config

Design for [opslane-oss#290](https://github.com/opslane/opslane-oss/issues/290).

## Problem

`initTracing()` treats the presence of `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` as "tracing is configured", and never checks `LANGFUSE_BASE_URL`. When the keys are set but the base URL is not, the worker still starts the OTel SDK, still builds a `LangfuseSpanProcessor`, and still creates a span for every job — but `@langfuse/otel` falls back to its only hardcoded host, so every export goes to the wrong Langfuse region and is rejected.

Nothing logs. Production lost more than 33 hours of traces this way, and the state was indistinguishable from healthy tracing both from inside the process and from the logs.

Four gaps compound:

1. `tracing.ts:25-27` validates only the two keys.
2. `tracing.ts` never calls `diag.setLogger`, and OpenTelemetry routes exporter errors through `diag`, which is a no-op until a logger is installed.
3. Nothing logs tracing state at startup, so the three possible states (off / on / on-but-undeliverable) are indistinguishable.
4. `index.ts:288-296` persists `trace_url` fire-and-forget with `.catch(() => {})`.

## Principles

- **Tracing must never take production down.** It is observability, not a job dependency. Every failure path here degrades to a no-op plus a log line, never to a crash.
- **Fail proportionally.** Losing deep links is not the same as losing all traces, and is not treated the same.
- **A partial config is an error, not a degraded mode.** Half-configured tracing that cannot deliver is worse than no tracing, because it consumes CPU and network to produce nothing while appearing healthy.

## Design

### 1. `resolveTracingConfig(env)`

A pure exported function in `tracing.ts`. No side effects, no environment mutation, no I/O.

```ts
const DELIVERY_VARS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const;

export type TracingConfig =
  | { status: 'disabled' }
  | { status: 'incomplete'; missing: string[] }
  | { status: 'enabled'; baseUrl: string; projectId: string | null };
```

Resolution rules:

- Values are read with a trim. Empty or whitespace-only counts as unset, because Terraform can emit `""` for an unset variable.
- If none of the four Langfuse variables is set → `disabled`.
- If any is set but one or more of `DELIVERY_VARS` is missing → `incomplete`, carrying the missing names.
- Otherwise → `enabled`, carrying `baseUrl` and `projectId` (null when `LANGFUSE_PROJECT_ID` is unset).

`LANGFUSE_PROJECT_ID` is deliberately not in `DELIVERY_VARS`. It only builds `trace_url` deep links and has no bearing on whether spans deliver, so a missing project ID must not discard working traces.

The return type never carries key values. The Langfuse SDK reads those from the environment itself, so there is no reason to move secrets through our code where a future log line could pick them up.

### 2. `initTracing` switches on the resolved config

| Status | Behaviour |
| --- | --- |
| `disabled` | `logger.info('Langfuse tracing disabled')`, return. SDK never loads. |
| `incomplete` | `logger.warn('Langfuse tracing disabled: incomplete config', { missing })`, return. SDK never loads. |
| `enabled` | Warn if `projectId` is null, start the SDK, then `logger.info('Langfuse tracing enabled', { host: baseUrl })`. |

Details that matter:

- The `enabled` log fires **after** `nodeSdk.start()` resolves, so the worker never claims tracing is on when it is not.
- The dynamic imports and `nodeSdk.start()` are wrapped in try/catch. On failure: `logger.warn`, leave `tracer` null, return normally. Today a throw there propagates out of `main()` and kills the worker, which contradicts the first principle above.
- The `disabled` path keeps its current zero-overhead behaviour — the heavy OTel and Langfuse packages are still only imported on the `enabled` path.

### 3. OTel diagnostics

Install `diag.setLogger` at `DiagLogLevel.WARN`, routed into the worker's JSON logger, so exporter rejections surface instead of vanishing.

The processor flushes every 5 seconds, so an unthrottled logger emits roughly 17k lines per day during a sustained outage — the kind of noise that gets filtered out and then ignored. A minimal throttle keeps the channel readable: one timestamp and one counter. Log immediately if more than 60 seconds have passed since the last emission; otherwise increment the counter and include the suppressed count on the next line that does emit.

### 4. `trace_url` persistence

In `index.ts:288-296`, replace `.catch(() => {})` with a handler that logs at WARN with the job ID and the error.

A `false` return (rowCount 0) stays ignored. That means the lease moved on, which is routine under normal operation and already covered by the lease contract; warning on it would train people to ignore the line.

## Testing

`resolveTracingConfig` is pure, so its branches are table-driven cases taking a plain object — no `process.env` mutation, no OTel SDK, no network:

- No Langfuse variables → `disabled`.
- Keys set, `LANGFUSE_BASE_URL` missing → `incomplete` with `missing: ['LANGFUSE_BASE_URL']`. This is the production failure.
- `LANGFUSE_BASE_URL` set to `""` → treated as missing.
- Only `LANGFUSE_PROJECT_ID` set → `incomplete`, listing all three delivery variables.
- All three delivery variables set, no project ID → `enabled` with `projectId: null`.
- All four set → `enabled` with both values.
- Returned object never contains a key value.

The existing tests in `packages/worker/src/__tests__/tracing.test.ts` only exercise the disabled path, which is why this bug shipped without coverage. They stay as-is; the new cases are added alongside.

Not covered by unit tests: that `@langfuse/otel` actually falls back to a default host when `LANGFUSE_BASE_URL` is unset. That is upstream behaviour, verified by reading the installed package, and asserting it would only pin someone else's implementation detail.

## Out of scope

- The deployment configuration that produced the partial environment. Tracked in the private infra repo; that fix and this one are independent, and this one is worth doing regardless of how the Terraform is corrected.
- Exposing tracing state on `/health`. That endpoint is documented as a queue-shape report, and widening its contract is a separate decision.
- The unrelated investigation-budget defect found during the same incident.

## Verification

```bash
pnpm --filter @opslane/worker build
pnpm --filter @opslane/worker test
```
