# Tracing Config Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker refuse to start Langfuse tracing on a partial config, log its tracing state at startup, and surface export failures — so a misconfiguration is loud instead of a silent 33-hour blind spot.

**Architecture:** A pure resolver classifies the Langfuse environment into `disabled` / `incomplete` / `enabled` and normalizes the values. The resolved config is then the *only* source of truth: it is passed explicitly to `LangfuseSpanProcessor` and consumed by the trace-URL builder, so nothing re-reads `process.env` behind the validator's back. A throttled, crash-proof diagnostic adapter routes OpenTelemetry's internal errors into the worker's JSON logger.

**Tech Stack:** TypeScript (ESM, strict), Vitest, `@opentelemetry/api` 1.9.1, `@opentelemetry/sdk-node` 0.220.0, `@langfuse/otel` 5.9.1.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-tracing-config-validation-design.md`. Issue: opslane-oss#290.
- ESM and strict TypeScript. Use `unknown` plus narrowing instead of `any`.
- Tests are Vitest, colocated in `packages/worker/src/__tests__/`.
- `logger` (`packages/worker/src/logger.ts`) exposes exactly `info`, `warn`, `error`. **There is no `debug` level.**
- `logger.log` calls `JSON.stringify` on its fields **unguarded** — never pass a value that may be circular.
- Tracing must never crash the worker. Every new failure path degrades to a log line and returns normally.
- Credentials (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) must never appear in a log line, and never as a top-level field on a loggable object.
- `NodeSDK.start()` returns `void` synchronously — it proves local registration only, never delivery.
- Verification for every task: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`.

## File Structure

`tracing.ts` is 207 lines today and would roughly double. Split by responsibility so each file has one job and its tests sit beside it:

- **Create `packages/worker/src/tracing-config.ts`** — environment resolution and normalization. Pure, no I/O, no OTel imports. Owns `TracingConfig`, `resolveTracingConfig`, `normalizeBaseUrl`, `describeConfig`.
- **Create `packages/worker/src/tracing-diag.ts`** — the OTel diagnostic adapter. Owns `DiagThrottle`, `normalizeDiagMessage`, `createDiagLogger`.
- **Modify `packages/worker/src/tracing.ts`** — SDK lifecycle and span helpers. Consumes the two files above. Keeps `initTracing`, `shutdownTracing`, `withJobTrace`, `traceSpan`, `getActiveTraceId`, `buildLangfuseTraceUrl`, `getToolSpanAttributes`.
- **Modify `packages/worker/src/index.ts:288-296`** — `trace_url` failure logging.

---

### Task 1: Config resolver

**Files:**
- Create: `packages/worker/src/tracing-config.ts`
- Test: `packages/worker/src/__tests__/tracing-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DeliveryVar = 'LANGFUSE_PUBLIC_KEY' | 'LANGFUSE_SECRET_KEY' | 'LANGFUSE_BASE_URL'`; `type TracingConfig`; `type EnabledTracingConfig = Extract<TracingConfig, { status: 'enabled' }>`; `resolveTracingConfig(env: Record<string, string | undefined>): TracingConfig`; `normalizeBaseUrl(value: string): string | null`; `describeConfig(config: TracingConfig): Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/tracing-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveTracingConfig, normalizeBaseUrl, describeConfig } from '../tracing-config.js';

const KEYS = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
};

describe('resolveTracingConfig', () => {
  it('returns disabled when no Langfuse variables are set', () => {
    expect(resolveTracingConfig({})).toEqual({ status: 'disabled' });
    expect(resolveTracingConfig({ PATH: '/usr/bin' })).toEqual({ status: 'disabled' });
  });

  it('returns incomplete when keys are set but the base URL is missing', () => {
    // This is the exact production failure this work exists to prevent.
    expect(resolveTracingConfig({ ...KEYS })).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });

  it('treats empty and whitespace-only values as unset', () => {
    // Terraform emits "" for an unset variable.
    expect(resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: '' })).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
    expect(resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: '   ' })).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });

  it('reports a malformed base URL as invalid rather than missing', () => {
    for (const bad of ['ftp://example.com', 'not a url', 'https://user:pw@example.com']) {
      expect(resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: bad })).toEqual({
        status: 'incomplete',
        missing: [],
        invalid: ['LANGFUSE_BASE_URL'],
      });
    }
  });

  it('lists every missing delivery variable when only the project id is set', () => {
    expect(resolveTracingConfig({ LANGFUSE_PROJECT_ID: 'proj-1' })).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });

  it('returns enabled with a null project id when only the trio is set', () => {
    const config = resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com' });
    expect(config).toEqual({
      status: 'enabled',
      baseUrl: 'https://us.cloud.langfuse.com',
      projectId: null,
      credentials: { publicKey: 'pk-lf-test', secretKey: 'sk-lf-test' },
    });
  });

  it('treats a whitespace-only project id as absent', () => {
    const config = resolveTracingConfig({
      ...KEYS,
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
      LANGFUSE_PROJECT_ID: '   ',
    });
    expect(config).toMatchObject({ status: 'enabled', projectId: null });
  });

  it('returns enabled with both values when all four are set', () => {
    const config = resolveTracingConfig({
      ...KEYS,
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
      LANGFUSE_PROJECT_ID: 'proj-1',
    });
    expect(config).toMatchObject({ status: 'enabled', projectId: 'proj-1' });
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes, query, and fragment', () => {
    expect(normalizeBaseUrl('https://us.cloud.langfuse.com/')).toBe('https://us.cloud.langfuse.com');
    expect(normalizeBaseUrl('https://example.com/base/')).toBe('https://example.com/base');
    expect(normalizeBaseUrl('https://example.com/?a=1#frag')).toBe('https://example.com');
  });

  it('rejects non-http protocols, junk, and embedded credentials', () => {
    expect(normalizeBaseUrl('ftp://example.com')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
    expect(normalizeBaseUrl('https://user:pw@example.com')).toBeNull();
  });

  it('accepts plain http', () => {
    expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });
});

describe('describeConfig', () => {
  it('never exposes credentials', () => {
    const config = resolveTracingConfig({
      ...KEYS,
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
      LANGFUSE_PROJECT_ID: 'proj-1',
    });
    const described = describeConfig(config);
    expect(described).toEqual({
      status: 'enabled',
      host: 'https://us.cloud.langfuse.com',
      has_project_id: true,
    });
    expect(JSON.stringify(described)).not.toContain('sk-lf-test');
    expect(JSON.stringify(described)).not.toContain('pk-lf-test');
  });

  it('reports the missing and invalid lists for an incomplete config', () => {
    expect(describeConfig(resolveTracingConfig({ ...KEYS }))).toEqual({
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- tracing-config`
Expected: FAIL — cannot resolve module `../tracing-config.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/worker/src/tracing-config.ts`:

```ts
/**
 * Langfuse tracing configuration: resolution, normalization, and a loggable
 * projection.
 *
 * Pure by design — no I/O, no OTel imports, no process.env access. The caller
 * passes the environment in, which is what makes every branch testable without
 * starting an SDK. The resolved value is the single source of truth for both
 * span delivery and trace-URL construction; nothing downstream re-reads the
 * environment.
 */

const DELIVERY_VARS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
] as const;

export type DeliveryVar = (typeof DELIVERY_VARS)[number];

export type TracingConfig =
  | { status: 'disabled' }
  | { status: 'incomplete'; missing: DeliveryVar[]; invalid: DeliveryVar[] }
  | {
      status: 'enabled';
      /** Normalized and validated. Safe to log. */
      baseUrl: string;
      projectId: string | null;
      /** Nested so nothing logs the config object wholesale. Never logged. */
      credentials: { publicKey: string; secretKey: string };
    };

export type EnabledTracingConfig = Extract<TracingConfig, { status: 'enabled' }>;

type EnvLike = Record<string, string | undefined>;

/** Trim, and treat empty or whitespace-only as unset (Terraform emits ""). */
function readVar(env: EnvLike, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize a Langfuse host, or return null when it is unusable.
 * Embedded credentials are rejected outright: this value gets logged.
 */
export function normalizeBaseUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

export function resolveTracingConfig(env: EnvLike): TracingConfig {
  const publicKey = readVar(env, 'LANGFUSE_PUBLIC_KEY');
  const secretKey = readVar(env, 'LANGFUSE_SECRET_KEY');
  const rawBaseUrl = readVar(env, 'LANGFUSE_BASE_URL');
  const projectId = readVar(env, 'LANGFUSE_PROJECT_ID') ?? null;

  const anySet =
    publicKey !== undefined ||
    secretKey !== undefined ||
    rawBaseUrl !== undefined ||
    projectId !== null;
  if (!anySet) return { status: 'disabled' };

  const missing: DeliveryVar[] = [];
  const invalid: DeliveryVar[] = [];

  if (publicKey === undefined) missing.push('LANGFUSE_PUBLIC_KEY');
  if (secretKey === undefined) missing.push('LANGFUSE_SECRET_KEY');

  let baseUrl: string | null = null;
  if (rawBaseUrl === undefined) {
    missing.push('LANGFUSE_BASE_URL');
  } else {
    baseUrl = normalizeBaseUrl(rawBaseUrl);
    if (baseUrl === null) invalid.push('LANGFUSE_BASE_URL');
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { status: 'incomplete', missing, invalid };
  }

  return {
    status: 'enabled',
    baseUrl: baseUrl as string,
    projectId,
    credentials: { publicKey: publicKey as string, secretKey: secretKey as string },
  };
}

/** Loggable projection. Never includes credentials. */
export function describeConfig(config: TracingConfig): Record<string, unknown> {
  switch (config.status) {
    case 'disabled':
      return { status: 'disabled' };
    case 'incomplete':
      return { status: 'incomplete', missing: config.missing, invalid: config.invalid };
    case 'enabled':
      return {
        status: 'enabled',
        host: config.baseUrl,
        has_project_id: config.projectId !== null,
      };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- tracing-config`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/tracing-config.ts packages/worker/src/__tests__/tracing-config.test.ts
git commit -m "feat(worker): add pure Langfuse tracing config resolver"
```

---

### Task 2: Diagnostic adapter

**Files:**
- Create: `packages/worker/src/tracing-diag.ts`
- Test: `packages/worker/src/__tests__/tracing-diag.test.ts`

**Interfaces:**
- Consumes: `logger` from `./logger.js`.
- Produces: `class DiagThrottle` with `admit(fingerprint: string, now: number): number | null` and `drain(): { fingerprint: string; suppressed: number }[]`; `normalizeDiagMessage(message: string, args: unknown[]): string`; `createDiagLogger(throttle: DiagThrottle, now?: () => number): DiagLogger`.

`admit` returns the suppressed count to report (0 on first emission for a fingerprint), or `null` when the line should be dropped.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/tracing-diag.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiagThrottle, normalizeDiagMessage, createDiagLogger } from '../tracing-diag.js';
import { logger } from '../logger.js';

describe('DiagThrottle', () => {
  it('admits the first occurrence of a fingerprint with no suppressed count', () => {
    const throttle = new DiagThrottle(60_000, 50);
    expect(throttle.admit('warn:boom', 1_000)).toBe(0);
  });

  it('drops repeats inside the window and reports the count after it', () => {
    const throttle = new DiagThrottle(60_000, 50);
    expect(throttle.admit('warn:boom', 0)).toBe(0);
    expect(throttle.admit('warn:boom', 10_000)).toBeNull();
    expect(throttle.admit('warn:boom', 20_000)).toBeNull();
    // Window elapsed: emit, reporting the two that were dropped.
    expect(throttle.admit('warn:boom', 60_000)).toBe(2);
    // Counter resets after reporting.
    expect(throttle.admit('warn:boom', 120_000)).toBe(0);
  });

  it('keeps distinct fingerprints independent', () => {
    // A noisy error must not mask a different, more important one.
    const throttle = new DiagThrottle(60_000, 50);
    expect(throttle.admit('warn:noisy', 0)).toBe(0);
    expect(throttle.admit('warn:noisy', 1_000)).toBeNull();
    expect(throttle.admit('error:important', 1_000)).toBe(0);
  });

  it('drains outstanding suppressed counts and clears them', () => {
    const throttle = new DiagThrottle(60_000, 50);
    throttle.admit('warn:boom', 0);
    throttle.admit('warn:boom', 1_000);
    throttle.admit('warn:boom', 2_000);
    expect(throttle.drain()).toEqual([{ fingerprint: 'warn:boom', suppressed: 2 }]);
    expect(throttle.drain()).toEqual([]);
  });

  it('evicts the oldest fingerprint when full so the map cannot grow unbounded', () => {
    const throttle = new DiagThrottle(60_000, 2);
    throttle.admit('a', 0);
    throttle.admit('b', 0);
    throttle.admit('c', 0);
    // 'a' was evicted, so it is treated as new rather than throttled.
    expect(throttle.admit('a', 1_000)).toBe(0);
  });
});

describe('normalizeDiagMessage', () => {
  it('collapses whitespace and bounds length', () => {
    expect(normalizeDiagMessage('a\n  b', [])).toBe('a b');
    expect(normalizeDiagMessage('x'.repeat(900), []).length).toBe(500);
  });

  it('appends Error messages but discards all other arguments', () => {
    expect(normalizeDiagMessage('failed', [new Error('401 Unauthorized')]))
      .toBe('failed 401 Unauthorized');
    expect(normalizeDiagMessage('failed', [{ authorization: 'Bearer sk-lf-secret' }]))
      .toBe('failed');
  });

  it('survives a circular argument', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => normalizeDiagMessage('failed', [circular])).not.toThrow();
    expect(normalizeDiagMessage('failed', [circular])).toBe('failed');
  });
});

describe('createDiagLogger', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements every DiagLogger method', () => {
    const diagLogger = createDiagLogger(new DiagThrottle());
    for (const method of ['verbose', 'debug', 'info', 'warn', 'error'] as const) {
      expect(typeof diagLogger[method]).toBe('function');
    }
  });

  it('drops verbose, debug, and info without logging', () => {
    const diagLogger = createDiagLogger(new DiagThrottle());
    diagLogger.verbose('v');
    diagLogger.debug('d');
    diagLogger.info('i');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning with the otel component tag', () => {
    const diagLogger = createDiagLogger(new DiagThrottle(), () => 0);
    diagLogger.warn('export failed');
    expect(warnSpy).toHaveBeenCalledWith('otel diag: export failed', { component: 'otel' });
  });

  it('includes the suppressed count once the window elapses', () => {
    let now = 0;
    const diagLogger = createDiagLogger(new DiagThrottle(60_000, 50), () => now);
    diagLogger.warn('export failed');
    now = 1_000;
    diagLogger.warn('export failed');
    now = 61_000;
    diagLogger.warn('export failed');
    expect(warnSpy).toHaveBeenLastCalledWith('otel diag: export failed', {
      component: 'otel',
      suppressed: 1,
    });
  });

  it('never throws into OTel even when the logger itself fails', () => {
    warnSpy.mockImplementation(() => {
      throw new Error('logger exploded');
    });
    const diagLogger = createDiagLogger(new DiagThrottle());
    expect(() => diagLogger.warn('export failed')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- tracing-diag`
Expected: FAIL — cannot resolve module `../tracing-diag.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/worker/src/tracing-diag.ts`:

```ts
/**
 * OpenTelemetry diagnostic adapter.
 *
 * OTel routes exporter failures through `diag`, which is a no-op until a logger
 * is installed — that silence is why a misconfigured exporter ran unnoticed for
 * 33 hours in production.
 *
 * Two hazards shape this file. OTel calls each method as
 * `(message: string, ...args: unknown[])`, while `logger.log` JSON.stringifies
 * its fields unguarded, so forwarding arguments verbatim can throw on a
 * circular value — inside OTel's own call path — or leak authorization headers.
 * Nothing but a bounded string ever leaves this module.
 */

import type { DiagLogger } from '@opentelemetry/api';
import { logger } from './logger.js';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_FINGERPRINTS = 50;
const MAX_MESSAGE_LENGTH = 500;

interface ThrottleEntry {
  lastEmittedAt: number;
  suppressed: number;
}

/**
 * Per-fingerprint rate limiter. Throttling globally would let one noisy error
 * mask a different, more important one for a whole window.
 */
export class DiagThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly maxEntries: number = DEFAULT_MAX_FINGERPRINTS,
  ) {}

  /** Suppressed count to report, or null when the line should be dropped. */
  admit(fingerprint: string, now: number): number | null {
    const entry = this.entries.get(fingerprint);
    if (entry === undefined) {
      this.evictIfFull();
      this.entries.set(fingerprint, { lastEmittedAt: now, suppressed: 0 });
      return 0;
    }
    if (now - entry.lastEmittedAt >= this.windowMs) {
      const suppressed = entry.suppressed;
      entry.lastEmittedAt = now;
      entry.suppressed = 0;
      return suppressed;
    }
    entry.suppressed += 1;
    return null;
  }

  /** Outstanding counts, cleared as they are returned. Used on shutdown so a
   *  burst that ends mid-window still reports its total. */
  drain(): { fingerprint: string; suppressed: number }[] {
    const out: { fingerprint: string; suppressed: number }[] = [];
    for (const [fingerprint, entry] of this.entries) {
      if (entry.suppressed > 0) out.push({ fingerprint, suppressed: entry.suppressed });
      entry.suppressed = 0;
    }
    return out;
  }

  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}

/**
 * Bounded, whitespace-collapsed string. Only `Error` arguments contribute;
 * every other argument is discarded rather than serialized.
 */
export function normalizeDiagMessage(message: string, args: unknown[]): string {
  const parts = [String(message)];
  for (const arg of args) {
    if (arg instanceof Error) parts.push(arg.message);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH);
}

export function createDiagLogger(
  throttle: DiagThrottle,
  now: () => number = Date.now,
): DiagLogger {
  const emit =
    (level: 'warn' | 'error') =>
    (message: string, ...args: unknown[]): void => {
      try {
        const text = normalizeDiagMessage(message, args);
        const suppressed = throttle.admit(`${level}:${text}`, now());
        if (suppressed === null) return;
        const fields: Record<string, unknown> = { component: 'otel' };
        if (suppressed > 0) fields['suppressed'] = suppressed;
        logger[level](`otel diag: ${text}`, fields);
      } catch {
        // A diagnostic logger must never throw into OTel.
      }
    };

  const drop = (): void => {};

  return {
    verbose: drop,
    debug: drop,
    info: drop,
    warn: emit('warn'),
    error: emit('error'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- tracing-diag`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/tracing-diag.ts packages/worker/src/__tests__/tracing-diag.test.ts
git commit -m "feat(worker): add throttled crash-proof OTel diagnostic adapter"
```

---

### Task 3: Wire the resolved config into the SDK lifecycle

**Files:**
- Modify: `packages/worker/src/tracing.ts:14` (imports), `:19-59` (`initTracing`), `:61-78` (`shutdownTracing`), `:151-160` (`buildLangfuseTraceUrl`)
- Test: `packages/worker/src/__tests__/tracing.test.ts` (extend), `packages/worker/src/__tests__/tracing-init.test.ts` (create)

**Interfaces:**
- Consumes: `resolveTracingConfig`, `describeConfig`, `EnabledTracingConfig` from `./tracing-config.js`; `DiagThrottle`, `createDiagLogger` from `./tracing-diag.js`.
- Produces: `initTracing(): Promise<void>` (unchanged signature); `buildLangfuseTraceUrl(traceId: string): string | null` (unchanged signature, now reads module state instead of `process.env`).

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/tracing-init.test.ts`. Module state persists across imports, so each test resets modules and re-imports:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startSpy = vi.fn();
const shutdownSpy = vi.fn(async () => {});
const processorSpy = vi.fn();
const instrumentSpy = vi.fn();
const disableSpy = vi.fn();

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(public readonly config: unknown) {}
    start = startSpy;
    shutdown = shutdownSpy;
  },
}));

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class {
    constructor(options: unknown) {
      processorSpy(options);
    }
  },
}));

vi.mock('@arizeai/openinference-instrumentation-anthropic', () => ({
  AnthropicInstrumentation: class {
    manuallyInstrument = instrumentSpy;
    disable = disableSpy;
  },
}));

const COMPLETE_ENV = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
  LANGFUSE_PROJECT_ID: 'proj-1',
};

async function loadTracing() {
  vi.resetModules();
  return await import('../tracing.js');
}

function setEnv(env: Record<string, string | undefined>): void {
  for (const key of [
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BASE_URL',
    'LANGFUSE_PROJECT_ID',
  ]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

describe('initTracing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({});
  });
  afterEach(() => {
    setEnv({});
    vi.restoreAllMocks();
  });

  it('does not start the SDK when the config is incomplete', async () => {
    setEnv({ LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test' });
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await tracing.initTracing();

    expect(startSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'Langfuse tracing disabled: incomplete config',
      { status: 'incomplete', missing: ['LANGFUSE_BASE_URL'], invalid: [] },
    );
  });

  it('does not start the SDK when nothing is configured', async () => {
    const tracing = await loadTracing();
    await tracing.initTracing();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('passes normalized credentials and host explicitly to the processor', async () => {
    // The SDK must never fall back to reading process.env itself: that fallback
    // is what sent production spans to the wrong region.
    setEnv({ ...COMPLETE_ENV, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com/' });
    const tracing = await loadTracing();
    await tracing.initTracing();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(processorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://us.cloud.langfuse.com',
      }),
    );
  });

  it('logs the instrumentation line exactly once, after start', async () => {
    setEnv(COMPLETE_ENV);
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    await tracing.initTracing();

    const lines = infoSpy.mock.calls.filter(
      ([msg]) => msg === 'Langfuse tracing instrumentation enabled',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({
      status: 'enabled',
      host: 'https://us.cloud.langfuse.com',
      has_project_id: true,
    });
  });

  it('warns about deep links when the project id is absent', async () => {
    setEnv({ ...COMPLETE_ENV, LANGFUSE_PROJECT_ID: undefined });
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await tracing.initTracing();

    expect(startSpy).toHaveBeenCalledTimes(1);
    // Called with a message only — asserting a second argument would fail.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LANGFUSE_PROJECT_ID'));
  });

  it('swallows a start failure, logs it, and attempts rollback', async () => {
    setEnv(COMPLETE_ENV);
    startSpy.mockImplementationOnce(() => {
      throw new Error('start exploded');
    });
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(tracing.initTracing()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      'Langfuse tracing failed to initialize',
      { error: 'start exploded' },
    );
    expect(disableSpy).toHaveBeenCalled();
    // Spans degrade to pass-through.
    expect(await tracing.withJobTrace('j', 'e', 'p', async () => 'ok')).toBe('ok');
  });
});

describe('buildLangfuseTraceUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({});
  });
  afterEach(() => setEnv({}));

  it('returns null when tracing was never initialized', async () => {
    const tracing = await loadTracing();
    expect(tracing.buildLangfuseTraceUrl('abc')).toBeNull();
  });

  it('returns null when the project id is absent', async () => {
    setEnv({ ...COMPLETE_ENV, LANGFUSE_PROJECT_ID: undefined });
    const tracing = await loadTracing();
    await tracing.initTracing();
    expect(tracing.buildLangfuseTraceUrl('abc')).toBeNull();
  });

  it('builds from the normalized config, not the raw environment', async () => {
    setEnv({ ...COMPLETE_ENV, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com/' });
    const tracing = await loadTracing();
    await tracing.initTracing();
    expect(tracing.buildLangfuseTraceUrl('abc')).toBe(
      'https://us.cloud.langfuse.com/project/proj-1/traces/abc',
    );
  });

  it('ignores a whitespace-only project id instead of building a bad link', async () => {
    setEnv({ ...COMPLETE_ENV, LANGFUSE_PROJECT_ID: '   ' });
    const tracing = await loadTracing();
    await tracing.initTracing();
    expect(tracing.buildLangfuseTraceUrl('abc')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- tracing-init`
Expected: FAIL — `initTracing` still gates on keys only, `processorSpy` receives no `baseUrl`, and no `Langfuse tracing instrumentation enabled` line is logged.

- [ ] **Step 3: Write minimal implementation**

In `packages/worker/src/tracing.ts`, replace the import on line 14 and the `initTracing` / `shutdownTracing` / `buildLangfuseTraceUrl` bodies.

Imports:

```ts
import {
  trace,
  SpanStatusCode,
  context,
  diag,
  DiagLogLevel,
  type Tracer,
  type Span,
} from '@opentelemetry/api';
import { logger } from './logger.js';
import {
  resolveTracingConfig,
  describeConfig,
  type EnabledTracingConfig,
} from './tracing-config.js';
import { DiagThrottle, createDiagLogger } from './tracing-diag.js';
```

Module state:

```ts
let sdk: { shutdown(): Promise<void> } | null = null;
let tracer: Tracer | null = null;
let activeConfig: EnabledTracingConfig | null = null;
let diagThrottle: DiagThrottle | null = null;
```

`initTracing`:

```ts
/**
 * Initialize OpenTelemetry tracing with the Langfuse exporter.
 *
 * A partial config is treated as an error, not a degraded mode: half-configured
 * tracing that cannot deliver is worse than none, because it burns CPU and
 * network producing nothing while looking healthy.
 *
 * Must be awaited before any `new Anthropic()` call.
 */
export async function initTracing(): Promise<void> {
  const config = resolveTracingConfig(process.env);

  if (config.status === 'disabled') {
    logger.info('Langfuse tracing disabled', describeConfig(config));
    return;
  }
  if (config.status === 'incomplete') {
    logger.warn('Langfuse tracing disabled: incomplete config', describeConfig(config));
    return;
  }
  if (config.projectId === null) {
    logger.warn('LANGFUSE_PROJECT_ID not set — trace_url deep links will not be recorded');
  }

  let instrumentation: { disable?: () => void } | undefined;
  let nodeSdk: { start(): void; shutdown(): Promise<void> } | undefined;

  try {
    // Dynamic imports keep the heavy SDK out of the disabled path.
    const [{ NodeSDK }, { LangfuseSpanProcessor }, { AnthropicInstrumentation }, AnthropicModule] =
      await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@langfuse/otel'),
        import('@arizeai/openinference-instrumentation-anthropic'),
        import('@anthropic-ai/sdk'),
      ]);

    diagThrottle = new DiagThrottle();
    diag.setLogger(createDiagLogger(diagThrottle), DiagLogLevel.WARN);

    const inst = new AnthropicInstrumentation();
    instrumentation = inst;
    inst.manuallyInstrument(AnthropicModule.default ?? AnthropicModule);

    nodeSdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          // Explicit, so the SDK never falls back to reading the environment
          // itself — that fallback is what shipped spans to the wrong region.
          publicKey: config.credentials.publicKey,
          secretKey: config.credentials.secretKey,
          baseUrl: config.baseUrl,
          flushAt: 50,
          flushInterval: 5, // seconds
          // The v5 default filter only exports spans from Langfuse's own tracer,
          // gen_ai.*-attributed spans, or known LLM scopes. Our 'opslane-worker'
          // tracer and '@arizeai/openinference-instrumentation-anthropic' match
          // none of those, so every span is silently dropped. Export everything —
          // the worker registers no other instrumentations.
          shouldExportSpan: () => true,
        }),
      ],
      instrumentations: [inst],
    });
    nodeSdk.start();

    sdk = nodeSdk;
    tracer = trace.getTracer('opslane-worker');
    activeConfig = config;

    // start() is synchronous and returns void: it registers local components and
    // performs no handshake. This line claims instrumentation, not delivery —
    // whether spans land is knowable only from the diag warnings above.
    logger.info('Langfuse tracing instrumentation enabled', describeConfig(config));
  } catch (err) {
    await rollbackPartialInit(instrumentation, nodeSdk);
    logger.warn('Langfuse tracing failed to initialize', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best effort, not guaranteed. `manuallyInstrument` patches the Anthropic module
 * prototype before start() runs, and start() registers global OTel state
 * incrementally, so a mid-initialization throw can leave global state partly
 * mutated. Nulling `tracer` is what makes our own helpers pass through.
 */
async function rollbackPartialInit(
  instrumentation: { disable?: () => void } | undefined,
  nodeSdk: { shutdown(): Promise<void> } | undefined,
): Promise<void> {
  try {
    instrumentation?.disable?.();
  } catch {
    // best effort
  }
  try {
    await nodeSdk?.shutdown();
  } catch {
    // best effort
  }
  try {
    diag.disable();
  } catch {
    // best effort
  }
  sdk = null;
  tracer = null;
  activeConfig = null;
  diagThrottle = null;
}
```

`shutdownTracing` — drain suppressed counts before the existing shutdown, and clear state after:

```ts
export async function shutdownTracing(): Promise<void> {
  if (diagThrottle !== null) {
    for (const { fingerprint, suppressed } of diagThrottle.drain()) {
      logger.warn('otel diag: suppressed diagnostics at shutdown', { fingerprint, suppressed });
    }
  }
  if (!sdk) return;
  try {
    await Promise.race([
      sdk.shutdown(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Tracing shutdown timeout')), 5000);
        timer.unref(); // Don't block process exit
      }),
    ]);
  } catch {
    // Best effort — do not block worker shutdown
  } finally {
    sdk = null;
    tracer = null;
    activeConfig = null;
    diagThrottle = null;
  }
}
```

`buildLangfuseTraceUrl` — module state, never `process.env`:

```ts
/**
 * Langfuse trace URL for a trace ID, or null when tracing is not active or no
 * project ID was configured. Reads the resolved config so a value the validator
 * rejected can never reach a link.
 */
export function buildLangfuseTraceUrl(traceId: string): string | null {
  if (activeConfig === null || activeConfig.projectId === null) return null;
  return `${activeConfig.baseUrl}/project/${activeConfig.projectId}/traces/${traceId}`;
}
```

Also update the file's top docblock: replace the "if LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set" sentence with "Configuration is resolved by `tracing-config.ts`; a partial config disables tracing with a warning rather than starting an exporter that cannot deliver."

- [ ] **Step 4: Fix the existing unawaited test**

In `packages/worker/src/__tests__/tracing.test.ts`, the `initTracing` case (~line 52) calls the async function without awaiting, so it asserts nothing. Replace it:

```ts
  describe('initTracing', () => {
    it('is a no-op when no Langfuse env is set', async () => {
      await expect(initTracing()).resolves.toBeUndefined();
    });
  });
```

Also extend that file's `beforeEach` to clear all four variables, so a stray `LANGFUSE_BASE_URL` in the ambient environment cannot flip these tests into the enabled path:

```ts
  beforeEach(() => {
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
    delete process.env['LANGFUSE_BASE_URL'];
    delete process.env['LANGFUSE_PROJECT_ID'];
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @opslane/worker test -- tracing`
Expected: PASS for `tracing-config`, `tracing-diag`, `tracing-init`, and `tracing`.

- [ ] **Step 6: Build**

Run: `pnpm --filter @opslane/worker build`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/tracing.ts packages/worker/src/__tests__/tracing-init.test.ts packages/worker/src/__tests__/tracing.test.ts
git commit -m "fix(worker): refuse to start tracing on a partial Langfuse config"
```

---

### Task 4: Report trace_url persistence failures

**Files:**
- Modify: `packages/worker/src/index.ts:288-296`

**Interfaces:**
- Consumes: `buildLangfuseTraceUrl` from `./tracing.js` (unchanged signature), `logger` from `./logger.js` (already imported).
- Produces: nothing.

- [ ] **Step 1: Replace the swallowing catch**

In `processJobInner`, the fire-and-forget update currently discards every failure. Replace:

```ts
      updateJobTraceUrl(
        job.id,
        job.workerId,
        job.leaseGeneration,
        traceUrl,
      ).catch(() => {});
```

with:

```ts
      updateJobTraceUrl(
        job.id,
        job.workerId,
        job.leaseGeneration,
        traceUrl,
      ).catch((err: unknown) => {
        // A false return (rowCount 0) stays ignored: that means the lease moved
        // on, which is routine and already covered by the lease contract.
        // Only a genuine rejection is worth a line.
        logger.warn('Failed to persist trace_url', {
          job_id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @opslane/worker build`
Expected: no type errors.

- [ ] **Step 3: Run the full worker suite**

Run: `pnpm --filter @opslane/worker test`
Expected: PASS, with no new failures in `index.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/index.ts
git commit -m "fix(worker): log trace_url persistence failures instead of swallowing them"
```

---

## Final Verification

- [ ] Run the package gate:

```bash
pnpm --filter @opslane/worker build
pnpm --filter @opslane/worker test
```

- [ ] Confirm no credential can reach a log line:

```bash
grep -n "credentials" packages/worker/src/tracing.ts
```

Expected: `credentials` appears only where it is passed into `LangfuseSpanProcessor`, never inside a `logger.*` call.

- [ ] Confirm nothing re-reads Langfuse env outside the resolver:

```bash
grep -rn "LANGFUSE_" packages/worker/src --include=*.ts | grep -v __tests__ | grep -v tracing-config.ts
```

Expected: no matches. Every read goes through `resolveTracingConfig`.
