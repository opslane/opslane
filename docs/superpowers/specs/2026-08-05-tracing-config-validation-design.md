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

- **Tracing must never take production down.** It is observability, not a job dependency. Every failure path degrades to a no-op plus a log line, never to a crash — including inside the diagnostic logger itself.
- **Validation must govern what actually runs.** A resolver whose normalized values are not the values the SDK uses is decoration. The config module owns both validation and application.
- **Fail proportionally.** Losing deep links is not the same as losing all traces, and is not treated the same.
- **A partial config is an error, not a degraded mode.** Half-configured tracing that cannot deliver is worse than none, because it consumes CPU and network to produce nothing while appearing healthy.

## Design

### 1. `resolveTracingConfig(env)`

A pure exported function in `tracing.ts`. No side effects, no environment mutation, no I/O.

```ts
const DELIVERY_VARS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const;
type DeliveryVar = typeof DELIVERY_VARS[number];

export type TracingConfig =
  | { status: 'disabled' }
  | { status: 'incomplete'; missing: DeliveryVar[]; invalid: DeliveryVar[] }
  | {
      status: 'enabled';
      baseUrl: string;                                   // normalized, safe to log
      projectId: string | null;
      credentials: { publicKey: string; secretKey: string };
    };
```

Resolution rules:

- Values are read with a trim. Empty or whitespace-only counts as unset, because Terraform emits `""` for an unset variable.
- If none of the four Langfuse variables is set → `disabled`.
- `LANGFUSE_BASE_URL` is parsed with `new URL()`. It is **invalid** (not merely missing) if it fails to parse, if its protocol is not `http:` or `https:`, or if it carries userinfo (`username` or `password`) — credentials in a URL must never reach a log line. Query and fragment are stripped during normalization, as is any trailing slash, so the stored `baseUrl` is an origin plus path only.
- If any variable is set but a delivery variable is missing or invalid → `incomplete`, carrying both lists.
- Otherwise → `enabled`.

`LANGFUSE_PROJECT_ID` is deliberately not a delivery variable. It only builds `trace_url` deep links and has no bearing on whether spans deliver, so a missing project ID must not discard working traces.

Credentials are carried so the config can be applied (below), nested under `credentials` so nothing logs the config object wholesale. All logging goes through a `describeConfig()` helper returning only `{ host, has_project_id }`. Credentials are never a top-level field and are never logged.

### 2. The resolved config is the only source of truth

This is what makes validation real rather than decorative.

- `LangfuseSpanProcessor` is constructed with **explicit** `publicKey`, `secretKey`, and `baseUrl` from the resolved config. It no longer falls back to reading the environment, so the values that were validated are the values that are used.
- `initTracing` stores the enabled config in a module-level `activeConfig` on success, and clears it on failure or shutdown.
- `buildLangfuseTraceUrl(traceId)` keeps its signature but reads `activeConfig` instead of re-reading `process.env`. It returns null unless a config is active and its `projectId` is non-null.

Without this, a whitespace-only `LANGFUSE_PROJECT_ID` resolves to `null` while the current builder still sees a truthy string and emits a malformed link — validation and behaviour disagreeing in exactly the way this issue is about. No existing test covers `buildLangfuseTraceUrl`, so the signature change is free.

### 3. `initTracing` switches on the resolved config

| Status | Behaviour |
| --- | --- |
| `disabled` | `logger.info('Langfuse tracing disabled')`, return. SDK never loads. |
| `incomplete` | `logger.warn('Langfuse tracing disabled: incomplete config', { missing, invalid })`, return. SDK never loads. |
| `enabled` | Warn if `projectId` is null, install the diag logger, start the SDK, then log success. |

Details that matter:

- **`NodeSDK.start()` returns `void` and is synchronous** in the installed `@opentelemetry/sdk-node@0.220.0`. It registers local components; it performs no handshake and proves nothing about delivery. The success log therefore says **`Langfuse tracing instrumentation enabled`**, with `{ host }`, and claims only what is true. Whether spans actually land is knowable only from the asynchronous diagnostics in section 4 — which is the entire reason that section exists.
- The dynamic imports, `manuallyInstrument`, and `start()` are wrapped in try/catch. On failure: attempt best-effort rollback (`instrumentation.disable?.()` and `nodeSdk.shutdown?.()`, each individually guarded and ignored if they throw), null out `tracer` and `activeConfig`, `logger.warn`, and return normally.
- Rollback is **best effort, not guaranteed**. `manuallyInstrument` patches the Anthropic module prototype before `start()` runs, and `start()` registers global OTel state incrementally, so a mid-initialization throw can leave global state partially mutated. Nulling `tracer` makes our own `withJobTrace`/`traceSpan` pass through, but the spec does not claim a clean no-op, because it cannot be guaranteed. The design goal here is "does not crash and does not silently claim health", not "perfectly unwound".
- The `disabled` path keeps its zero-overhead behaviour — the heavy OTel and Langfuse packages are still imported only on the `enabled` path.

### 4. OTel diagnostics adapter

`diag.setLogger` is installed at `DiagLogLevel.WARN` on the enabled path only. OTel's `DiagLogger` is five methods each typed `(message: string, ...args: unknown[]) => void`, while the worker logger takes a message plus a JSON-serializable fields object and calls `JSON.stringify` **unguarded**. Forwarding OTel's arguments straight through would therefore throw a `TypeError` on a circular value, inside OTel's own call path — violating the no-crash principle. It could also surface request headers, including authorization.

The adapter must:

- Implement all five methods (`verbose`, `debug`, `info`, `warn`, `error`); the first three are dropped at WARN level.
- Emit only a normalized, length-bounded message string. Extra `args` are **never** forwarded as objects — at most, `Error` instances contribute their `message` (bounded), and everything else is discarded. No header, URL, or credential material is ever passed through.
- Never throw. The whole body is wrapped in try/catch with an empty handler; a broken logger must not break the caller.
- Throttle **per fingerprint**, not globally. A single global timestamp would let one noisy error mask a different, more important one for a full minute.

Fingerprint is the level plus the normalized message. Each entry holds a last-emitted timestamp and a suppressed count. Emit when `now - last >= 60_000`, including the suppressed count since the previous emission; otherwise increment. The fingerprint map is capped (50 entries, oldest evicted) so a high-cardinality message cannot leak memory.

Suppressed counts are flushed in `shutdownTracing()`, so a burst that ends before the next window still reports its total rather than disappearing.

### 5. `trace_url` persistence

In `index.ts:288-296`, replace `.catch(() => {})` with a handler that logs at WARN with `job_id` and a normalized error string.

A `false` return (rowCount 0) stays ignored. That means the lease moved on, which is routine and already covered by the lease contract; warning on it would train people to ignore the line.

## Testing

**Resolution** — `resolveTracingConfig` is pure, so these are table-driven cases over a plain object:

- No Langfuse variables → `disabled`.
- Keys set, `LANGFUSE_BASE_URL` missing → `incomplete`, `missing: ['LANGFUSE_BASE_URL']`. This is the production failure.
- `LANGFUSE_BASE_URL` set to `""` or whitespace → treated as missing.
- `LANGFUSE_BASE_URL` set to `ftp://x`, to unparseable junk, or carrying userinfo → `incomplete`, listed under `invalid`.
- Trailing slash, query, and fragment are stripped from the normalized `baseUrl`.
- Only `LANGFUSE_PROJECT_ID` set → `incomplete`, listing all three delivery variables.
- Whitespace-only `LANGFUSE_PROJECT_ID` with a complete trio → `enabled` with `projectId: null`.
- All four set → `enabled` with both values.
- Credentials never appear as a top-level field; `describeConfig()` output contains neither key.

**Behaviour** — the issue asks for the initialization paths, and classification alone does not prove them. With the four dynamic imports mocked:

- `incomplete` config does not import or start the SDK, and logs the warning with the missing/invalid lists.
- `enabled` config starts the SDK, constructs `LangfuseSpanProcessor` with the explicit normalized `baseUrl` and credentials, and logs the instrumentation line exactly once.
- An import or `start()` throw is swallowed, logged at WARN, leaves `tracer` null, and attempts rollback.
- The diag adapter: survives a circular argument without throwing, drops non-`Error` args, emits at most one line per fingerprint per window with a suppressed count, and keeps distinct fingerprints independent.
- `buildLangfuseTraceUrl` returns null when no config is active and when `projectId` is null.
- `trace_url` rejection logs `job_id` and a normalized error.

The existing tests in `packages/worker/src/__tests__/tracing.test.ts` only exercise the disabled path, which is why this bug shipped without coverage. They stay, with one fix: line 52 calls the async `initTracing()` without awaiting it, so it currently asserts nothing.

Not covered: that `@langfuse/otel` falls back to a default host when `LANGFUSE_BASE_URL` is unset. That is upstream behaviour, verified by reading the installed package, and section 2 makes it unreachable by passing `baseUrl` explicitly.

## Out of scope

- The deployment configuration that produced the partial environment. Tracked in the private infra repo; the two fixes are independent.
- Exposing tracing state on `/health`. That endpoint is documented as a queue-shape report, and widening its contract is a separate decision.
- The unrelated investigation-budget defect found during the same incident.

## Verification

```bash
pnpm --filter @opslane/worker build
pnpm --filter @opslane/worker test
```
