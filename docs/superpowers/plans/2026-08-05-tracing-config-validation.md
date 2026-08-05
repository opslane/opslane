# Tracing Config Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker refuse to start Langfuse tracing on a partial config, log its tracing state at startup, and surface export failures — so a misconfiguration is loud instead of a silent 33-hour blind spot.

**Architecture:** A pure resolver classifies the Langfuse environment into `disabled` / `incomplete` / `enabled` and normalizes the values. The resolved config is then the *only* source of truth: it is passed explicitly to `LangfuseSpanProcessor` and consumed by the trace-URL builder, so nothing re-reads `process.env` behind the validator's back. A throttled, redacting, crash-proof diagnostic adapter routes OpenTelemetry's internal errors into the worker's JSON logger.

**Tech Stack:** TypeScript (ESM, strict), Vitest, `@opentelemetry/api` 1.9.1, `@opentelemetry/sdk-node` 0.220.0, `@langfuse/otel` 5.9.1.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-tracing-config-validation-design.md`. Issue: opslane-oss#290.
- ESM and strict TypeScript. Use `unknown` plus narrowing instead of `any`.
- Tests are Vitest, colocated in `packages/worker/src/__tests__/`.
- `logger` (`packages/worker/src/logger.ts`) exposes exactly `info`, `warn`, `error`. **There is no `debug` level.**
- `logger.log` calls `JSON.stringify` on its fields **unguarded** — never pass a value that may be circular.
- **`String(err)` can throw.** `String(Object.create(null))` raises `TypeError`. Every error-to-string conversion goes through `safeErrorMessage` (Task 0). A raw `String(err)` inside a `catch` re-throws out of the handler and defeats the whole no-crash guarantee.
- Tracing must never crash the worker, never block startup, and never block shutdown. Every new failure path degrades to a log line and returns.
- Credentials (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) must never appear in a log line, never as a top-level field on a loggable object, and never inside a diagnostic message forwarded from OTel.
- `NodeSDK.start()` returns `void` synchronously — it proves local registration only, never delivery.
- Verification for every task: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`.

## File Structure

`tracing.ts` is 207 lines today and would roughly double. Split by responsibility so each file has one job and its tests sit beside it:

- **Modify `packages/worker/src/logger.ts`** — add `safeErrorMessage`, used by every new catch handler in this plan.
- **Create `packages/worker/src/tracing-config.ts`** — environment resolution and normalization. Pure, no I/O, no OTel imports.
- **Create `packages/worker/src/tracing-diag.ts`** — the OTel diagnostic adapter: throttle, redaction, message normalization.
- **Modify `packages/worker/src/tracing.ts`** — SDK lifecycle and span helpers. Consumes the two files above.
- **Modify `packages/worker/src/index.ts:288-296`** — `trace_url` failure logging.

---

### Task 0: Crash-proof error stringification

**Files:**
- Modify: `packages/worker/src/logger.ts`
- Test: `packages/worker/src/__tests__/logger.test.ts` (create if absent; append if present)

**Interfaces:**
- Consumes: nothing.
- Produces: `safeErrorMessage(err: unknown): string`.

Every later task depends on this. It lives in `logger.ts` because it is about producing a loggable string, and both `tracing.ts` and `index.ts` already import from there.

- [ ] **Step 1: Write the failing test**

Create or append to `packages/worker/src/__tests__/logger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { safeErrorMessage } from '../logger.js';

describe('safeErrorMessage', () => {
  it('returns the message of an Error', () => {
    expect(safeErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies ordinary values', () => {
    expect(safeErrorMessage('plain')).toBe('plain');
    expect(safeErrorMessage(42)).toBe('42');
    expect(safeErrorMessage(null)).toBe('null');
  });

  it('does not throw on a null-prototype object', () => {
    // String(Object.create(null)) raises TypeError. A raw String(err) inside a
    // catch would re-throw out of the handler.
    const hostile = Object.create(null) as unknown;
    expect(() => safeErrorMessage(hostile)).not.toThrow();
    expect(safeErrorMessage(hostile)).toBe('unserializable error');
  });

  it('does not throw when a message getter throws', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('nope');
      },
    });
    expect(() => safeErrorMessage(hostile)).not.toThrow();
    expect(safeErrorMessage(hostile)).toBe('unserializable error');
  });

  it('does not throw when toString throws', () => {
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };
    expect(() => safeErrorMessage(hostile)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- logger`
Expected: FAIL — `safeErrorMessage` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/worker/src/logger.ts`:

```ts
/**
 * Convert an unknown thrown value to a loggable string without ever throwing.
 *
 * `String(Object.create(null))` raises TypeError, and a `message`/`toString`
 * getter can throw arbitrarily. A raw conversion inside a catch block would
 * therefore re-throw out of the handler — which is exactly the crash the
 * handlers exist to prevent.
 */
export function safeErrorMessage(err: unknown): string {
  try {
    if (err instanceof Error) {
      const message = err.message;
      return typeof message === 'string' ? message : 'unserializable error';
    }
    return String(err);
  } catch {
    return 'unserializable error';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- logger`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/logger.ts packages/worker/src/__tests__/logger.test.ts
git commit -m "feat(worker): add safeErrorMessage for crash-proof error logging"
```

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
    expect(
      resolveTracingConfig({ ...KEYS, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com' }),
    ).toEqual({
      status: 'enabled',
      baseUrl: 'https://us.cloud.langfuse.com',
      projectId: null,
      credentials: { publicKey: 'pk-lf-test', secretKey: 'sk-lf-test' },
    });
  });

  it('treats a whitespace-only project id as absent', () => {
    expect(
      resolveTracingConfig({
        ...KEYS,
        LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
        LANGFUSE_PROJECT_ID: '   ',
      }),
    ).toMatchObject({ status: 'enabled', projectId: null });
  });

  it('returns enabled with both values when all four are set', () => {
    expect(
      resolveTracingConfig({
        ...KEYS,
        LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
        LANGFUSE_PROJECT_ID: 'proj-1',
      }),
    ).toMatchObject({ status: 'enabled', projectId: 'proj-1' });
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
    const described = describeConfig(
      resolveTracingConfig({
        ...KEYS,
        LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
        LANGFUSE_PROJECT_ID: 'proj-1',
      }),
    );
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
- Consumes: `logger`, `safeErrorMessage` from `./logger.js`.
- Produces:
  - `interface DiagThrottleOptions { windowMs?: number; maxEntries?: number; onEvict?: (evicted: { fingerprint: string; suppressed: number }) => void }`
  - `class DiagThrottle` with `constructor(options?: DiagThrottleOptions)`, `admit(fingerprint: string, now: number): number | null`, `drain(): { fingerprint: string; suppressed: number }[]`
  - `createRedactor(secrets: readonly string[]): (text: string) => string`
  - `normalizeDiagMessage(message: unknown, args: unknown[], redact?: (text: string) => string): string`
  - `createDiagLogger(throttle: DiagThrottle, redact: (text: string) => string, now?: () => number): DiagLogger`

`admit` returns the suppressed count to report (0 on first emission for a fingerprint), or `null` when the line should be dropped.

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/__tests__/tracing-diag.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DiagThrottle,
  normalizeDiagMessage,
  createDiagLogger,
  createRedactor,
} from '../tracing-diag.js';
import { logger } from '../logger.js';

describe('DiagThrottle', () => {
  it('admits the first occurrence of a fingerprint with no suppressed count', () => {
    expect(new DiagThrottle().admit('warn:boom', 1_000)).toBe(0);
  });

  it('drops repeats inside the window and reports the count after it', () => {
    const throttle = new DiagThrottle({ windowMs: 60_000 });
    expect(throttle.admit('warn:boom', 0)).toBe(0);
    expect(throttle.admit('warn:boom', 10_000)).toBeNull();
    expect(throttle.admit('warn:boom', 20_000)).toBeNull();
    expect(throttle.admit('warn:boom', 60_000)).toBe(2);
    expect(throttle.admit('warn:boom', 120_000)).toBe(0);
  });

  it('keeps distinct fingerprints independent', () => {
    // A noisy error must not mask a different, more important one.
    const throttle = new DiagThrottle({ windowMs: 60_000 });
    expect(throttle.admit('warn:noisy', 0)).toBe(0);
    expect(throttle.admit('warn:noisy', 1_000)).toBeNull();
    expect(throttle.admit('error:important', 1_000)).toBe(0);
  });

  it('drains outstanding suppressed counts and clears them', () => {
    const throttle = new DiagThrottle({ windowMs: 60_000 });
    throttle.admit('warn:boom', 0);
    throttle.admit('warn:boom', 1_000);
    throttle.admit('warn:boom', 2_000);
    expect(throttle.drain()).toEqual([{ fingerprint: 'warn:boom', suppressed: 2 }]);
    expect(throttle.drain()).toEqual([]);
  });

  it('reports suppressed counts on eviction instead of losing them', () => {
    const evicted: { fingerprint: string; suppressed: number }[] = [];
    const throttle = new DiagThrottle({
      windowMs: 60_000,
      maxEntries: 2,
      onEvict: (e) => evicted.push(e),
    });
    throttle.admit('a', 0);
    throttle.admit('a', 1_000); // suppressed = 1
    throttle.admit('b', 0);
    throttle.admit('c', 0); // evicts 'a', which still had a count
    expect(evicted).toEqual([{ fingerprint: 'a', suppressed: 1 }]);
    // 'a' was evicted, so it is treated as new rather than throttled.
    expect(throttle.admit('a', 2_000)).toBe(0);
  });

  it('does not report an eviction that had nothing suppressed', () => {
    const evicted: { fingerprint: string; suppressed: number }[] = [];
    const throttle = new DiagThrottle({ maxEntries: 2, onEvict: (e) => evicted.push(e) });
    throttle.admit('a', 0);
    throttle.admit('b', 0);
    throttle.admit('c', 0);
    expect(evicted).toEqual([]);
  });
});

describe('createRedactor', () => {
  it('removes literal secrets', () => {
    const redact = createRedactor(['sk-lf-supersecret', 'pk-lf-publicish']);
    expect(redact('failed with sk-lf-supersecret')).toBe('failed with [redacted]');
  });

  it('removes Langfuse-shaped keys it was never told about', () => {
    const redact = createRedactor([]);
    expect(redact('key sk-lf-abc123DEF-_x rejected')).toBe('key [redacted] rejected');
  });

  it('removes bearer tokens and authorization headers', () => {
    const redact = createRedactor([]);
    expect(redact('Bearer abc.def-123')).toBe('[redacted]');
    expect(redact('authorization: Basic cGs6c2s=')).toBe('[redacted]');
  });

  it('ignores short secrets that would over-redact', () => {
    const redact = createRedactor(['ab']);
    expect(redact('a stable abstraction')).toBe('a stable abstraction');
  });
});

describe('normalizeDiagMessage', () => {
  it('collapses whitespace and bounds length', () => {
    expect(normalizeDiagMessage('a\n  b', [])).toBe('a b');
    expect(normalizeDiagMessage('x'.repeat(900), []).length).toBe(500);
  });

  it('appends Error messages but discards all other arguments', () => {
    expect(normalizeDiagMessage('failed', [new Error('401 Unauthorized')])).toBe(
      'failed 401 Unauthorized',
    );
    expect(normalizeDiagMessage('failed', [{ authorization: 'Bearer sk-lf-secret' }])).toBe(
      'failed',
    );
  });

  it('survives a circular argument', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => normalizeDiagMessage('failed', [circular])).not.toThrow();
    expect(normalizeDiagMessage('failed', [circular])).toBe('failed');
  });

  it('survives a hostile message and a throwing Error getter', () => {
    expect(() => normalizeDiagMessage(Object.create(null), [])).not.toThrow();
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('nope');
      },
    });
    expect(() => normalizeDiagMessage('failed', [hostile])).not.toThrow();
  });

  it('applies the redactor before truncating', () => {
    const redact = createRedactor(['sk-lf-secret']);
    expect(normalizeDiagMessage('sent sk-lf-secret upstream', [], redact)).toBe(
      'sent [redacted] upstream',
    );
  });
});

describe('createDiagLogger', () => {
  const identity = (s: string): string => s;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements every DiagLogger method', () => {
    const diagLogger = createDiagLogger(new DiagThrottle(), identity);
    for (const method of ['verbose', 'debug', 'info', 'warn', 'error'] as const) {
      expect(typeof diagLogger[method]).toBe('function');
    }
  });

  it('drops verbose, debug, and info without logging', () => {
    const diagLogger = createDiagLogger(new DiagThrottle(), identity);
    diagLogger.verbose('v');
    diagLogger.debug('d');
    diagLogger.info('i');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning with the otel component tag', () => {
    const diagLogger = createDiagLogger(new DiagThrottle(), identity, () => 0);
    diagLogger.warn('export failed');
    expect(warnSpy).toHaveBeenCalledWith('otel diag: export failed', { component: 'otel' });
  });

  it('redacts credentials out of diagnostics', () => {
    const diagLogger = createDiagLogger(
      new DiagThrottle(),
      createRedactor(['sk-lf-secret']),
      () => 0,
    );
    diagLogger.error('rejected', new Error('bad key sk-lf-secret'));
    const [message] = warnSpy.mock.calls[0] ?? [];
    expect(String(message)).not.toContain('sk-lf-secret');
  });

  it('includes the suppressed count once the window elapses', () => {
    let now = 0;
    const diagLogger = createDiagLogger(
      new DiagThrottle({ windowMs: 60_000 }),
      identity,
      () => now,
    );
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
    const diagLogger = createDiagLogger(new DiagThrottle(), identity);
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
 * Three hazards shape this file. OTel calls each method as
 * `(message: string, ...args: unknown[])`, while `logger.log` JSON.stringifies
 * its fields unguarded, so forwarding arguments verbatim can throw on a
 * circular value — inside OTel's own call path. Exporter errors routinely quote
 * request material, so anything forwarded is redacted first. And nothing here
 * may throw: a diagnostic logger that raises breaks its caller.
 */

import type { DiagLogger } from '@opentelemetry/api';
import { logger, safeErrorMessage } from './logger.js';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_FINGERPRINTS = 50;
const MAX_MESSAGE_LENGTH = 500;
const MIN_REDACTABLE_SECRET_LENGTH = 8;

/** Shapes that must never survive into a log line. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:pk|sk)-lf-[A-Za-z0-9_-]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bauthorization\b\s*[:=]\s*\S+/gi,
];

export interface DiagThrottleOptions {
  windowMs?: number;
  maxEntries?: number;
  /** Called when a capped-out entry is dropped while still holding a count. */
  onEvict?: (evicted: { fingerprint: string; suppressed: number }) => void;
}

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
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly onEvict?: (evicted: { fingerprint: string; suppressed: number }) => void;

  constructor(options: DiagThrottleOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_FINGERPRINTS;
    this.onEvict = options.onEvict;
  }

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

  /** Outstanding counts, cleared as they are returned. */
  drain(): { fingerprint: string; suppressed: number }[] {
    const out: { fingerprint: string; suppressed: number }[] = [];
    for (const [fingerprint, entry] of this.entries) {
      if (entry.suppressed > 0) out.push({ fingerprint, suppressed: entry.suppressed });
      entry.suppressed = 0;
    }
    return out;
  }

  /** Evicting silently would discard a count drain() promised to deliver. */
  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    const oldest = this.entries.keys().next();
    if (oldest.done) return;
    const fingerprint = oldest.value;
    const entry = this.entries.get(fingerprint);
    this.entries.delete(fingerprint);
    if (entry !== undefined && entry.suppressed > 0 && this.onEvict !== undefined) {
      try {
        this.onEvict({ fingerprint, suppressed: entry.suppressed });
      } catch {
        // Reporting an eviction must not break admission.
      }
    }
  }
}

/**
 * Build a redactor that strips known credential values and credential-shaped
 * substrings. Literal matching uses split/join so no regex escaping is needed.
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const literals = secrets.filter((s) => s.length >= MIN_REDACTABLE_SECRET_LENGTH);
  return (text: string): string => {
    let out = text;
    for (const literal of literals) out = out.split(literal).join('[redacted]');
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out;
  };
}

/**
 * Bounded, whitespace-collapsed, redacted string. Only `Error` arguments
 * contribute; every other argument is discarded rather than serialized.
 * Redaction runs before truncation so a secret cannot survive as a fragment.
 */
export function normalizeDiagMessage(
  message: unknown,
  args: unknown[],
  redact: (text: string) => string = (text) => text,
): string {
  const parts = [safeErrorMessage(message)];
  for (const arg of args) {
    if (arg instanceof Error) parts.push(safeErrorMessage(arg));
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  let redacted: string;
  try {
    redacted = redact(joined);
  } catch {
    redacted = '[redaction failed]';
  }
  return redacted.slice(0, MAX_MESSAGE_LENGTH);
}

export function createDiagLogger(
  throttle: DiagThrottle,
  redact: (text: string) => string,
  now: () => number = Date.now,
): DiagLogger {
  const emit =
    (level: 'warn' | 'error') =>
    (message: string, ...args: unknown[]): void => {
      try {
        const text = normalizeDiagMessage(message, args, redact);
        const suppressed = throttle.admit(`${level}:${text}`, now());
        if (suppressed === null) return;
        const fields: Record<string, unknown> = { component: 'otel' };
        if (suppressed > 0) fields['suppressed'] = suppressed;
        logger.warn(`otel diag: ${text}`, fields);
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

Note both `warn` and `error` route to `logger.warn`: the worker's `error` level writes to stderr and is reserved for worker-fatal conditions, and a rejected span export is not one.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- tracing-diag`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/tracing-diag.ts packages/worker/src/__tests__/tracing-diag.test.ts
git commit -m "feat(worker): add throttled redacting OTel diagnostic adapter"
```

---

### Task 3: Wire the resolved config into the SDK lifecycle

**Files:**
- Modify: `packages/worker/src/tracing.ts:14` (imports), `:16-59` (state + `initTracing`), `:61-78` (`shutdownTracing`), `:151-160` (`buildLangfuseTraceUrl`)
- Test: `packages/worker/src/__tests__/tracing-init.test.ts` (create), `packages/worker/src/__tests__/tracing.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveTracingConfig`, `describeConfig`, `EnabledTracingConfig` from `./tracing-config.js`; `DiagThrottle`, `createDiagLogger`, `createRedactor` from `./tracing-diag.js`; `logger`, `safeErrorMessage` from `./logger.js`.
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

const LANGFUSE_VARS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_PROJECT_ID',
] as const;

const COMPLETE_ENV: Record<string, string> = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
  LANGFUSE_PROJECT_ID: 'proj-1',
};

function setEnv(env: Record<string, string | undefined>): void {
  for (const key of LANGFUSE_VARS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/** Fresh module registry per test so module-level tracing state cannot leak. */
async function loadTracing() {
  vi.resetModules();
  return await import('../tracing.js');
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
    expect(warnSpy).toHaveBeenCalledWith('Langfuse tracing disabled: incomplete config', {
      status: 'incomplete',
      missing: ['LANGFUSE_BASE_URL'],
      invalid: [],
    });
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
    expect(lines[0]?.[1]).toEqual({
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

  it('ignores a second call instead of starting a second SDK', async () => {
    setEnv(COMPLETE_ENV);
    const tracing = await loadTracing();
    await tracing.initTracing();
    await tracing.initTracing();
    expect(startSpy).toHaveBeenCalledTimes(1);
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

    expect(warnSpy).toHaveBeenCalledWith('Langfuse tracing failed to initialize', {
      error: 'start exploded',
    });
    expect(disableSpy).toHaveBeenCalled();
    // Spans degrade to pass-through.
    expect(await tracing.withJobTrace('j', 'e', 'p', async () => 'ok')).toBe('ok');
  });

  it('does not hang startup when rollback shutdown never settles', async () => {
    setEnv(COMPLETE_ENV);
    vi.useFakeTimers();
    startSpy.mockImplementationOnce(() => {
      throw new Error('start exploded');
    });
    shutdownSpy.mockImplementationOnce(() => new Promise<void>(() => {}));
    const tracing = await loadTracing();

    const pending = tracing.initTracing();
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe('shutdownTracing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({});
  });
  afterEach(() => {
    setEnv({});
    vi.restoreAllMocks();
  });

  it('drains suppressed diagnostics after the SDK has shut down', async () => {
    // Failures raised *during* shutdown must still be reported, so the drain
    // has to run after shutdown, not before it.
    setEnv(COMPLETE_ENV);
    const tracing = await loadTracing();
    const { logger } = await import('../logger.js');
    await tracing.initTracing();

    const { diag } = await import('@opentelemetry/api');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    shutdownSpy.mockImplementationOnce(async () => {
      diag.warn('export failed');
      diag.warn('export failed');
    });

    await tracing.shutdownTracing();

    const drained = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes('suppressed diagnostics at shutdown'),
    );
    expect(drained).toHaveLength(1);
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

In `packages/worker/src/tracing.ts`, replace the import on line 14 and the state / `initTracing` / `shutdownTracing` / `buildLangfuseTraceUrl` bodies.

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
import { logger, safeErrorMessage } from './logger.js';
import {
  resolveTracingConfig,
  describeConfig,
  type EnabledTracingConfig,
} from './tracing-config.js';
import { DiagThrottle, createDiagLogger, createRedactor } from './tracing-diag.js';
```

Module state and shared shutdown helper:

```ts
const SHUTDOWN_TIMEOUT_MS = 5000;

let sdk: { shutdown(): Promise<void> } | null = null;
let tracer: Tracer | null = null;
let activeConfig: EnabledTracingConfig | null = null;
let diagThrottle: DiagThrottle | null = null;
let initialized = false;

/**
 * Shut a NodeSDK down without ever hanging or throwing. Used by both the normal
 * shutdown path and initialization rollback — an un-timed await in rollback
 * would leave the worker stuck in startup forever.
 */
async function shutdownWithTimeout(target: { shutdown(): Promise<void> }): Promise<void> {
  try {
    await Promise.race([
      target.shutdown(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Tracing shutdown timeout')),
          SHUTDOWN_TIMEOUT_MS,
        );
        timer.unref(); // Don't block process exit
      }),
    ]);
  } catch (err) {
    // Swallowing this entirely would recreate the silence this change removes.
    logger.warn('Langfuse tracing shutdown did not complete cleanly', {
      error: safeErrorMessage(err),
    });
  }
}

/** Report and clear whatever the throttle is still holding. */
function drainDiagnostics(): void {
  if (diagThrottle === null) return;
  for (const { fingerprint, suppressed } of diagThrottle.drain()) {
    logger.warn('otel diag: suppressed diagnostics at shutdown', { fingerprint, suppressed });
  }
}
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
  // Idempotent: a second call would start a second SDK and orphan the first
  // one's shutdown handle.
  if (initialized) {
    logger.warn('initTracing called more than once; ignoring');
    return;
  }
  initialized = true;

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

    const redact = createRedactor([config.credentials.publicKey, config.credentials.secretKey]);
    diagThrottle = new DiagThrottle({
      onEvict: ({ fingerprint, suppressed }) => {
        logger.warn('otel diag: suppressed diagnostics dropped', { fingerprint, suppressed });
      },
    });
    diag.setLogger(createDiagLogger(diagThrottle, redact), DiagLogLevel.WARN);

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
    logger.warn('Langfuse tracing failed to initialize', { error: safeErrorMessage(err) });
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
  if (nodeSdk !== undefined) await shutdownWithTimeout(nodeSdk);
  drainDiagnostics();
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

`shutdownTracing` — shut the SDK down first, then drain, then detach the global logger:

```ts
/**
 * Flush pending spans and shut down the OTel SDK. Never throws.
 */
export async function shutdownTracing(): Promise<void> {
  const current = sdk;
  // Shut down BEFORE draining: the flush itself can produce export failures,
  // and draining first would discard exactly those counts.
  if (current !== null) await shutdownWithTimeout(current);
  drainDiagnostics();
  try {
    // Without this the global OTel logger keeps the adapter (and its throttle)
    // alive through its closure after shutdown.
    diag.disable();
  } catch {
    // best effort
  }
  sdk = null;
  tracer = null;
  activeConfig = null;
  diagThrottle = null;
  initialized = false;
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
- Test: `packages/worker/src/__tests__/index.test.ts` (extend)

**Interfaces:**
- Consumes: `safeErrorMessage` from `./logger.js` (add to the existing `logger` import); `buildLangfuseTraceUrl`, `getActiveTraceId` from `./tracing.js` (unchanged).
- Produces: nothing.

`index.test.ts` already mocks `../db.js` (with `updateJobTraceUrl`), `../logger.js`, and `../tracing.js`, and imports `processJobInner` directly, so this branch is testable without new harness.

- [ ] **Step 1: Write the failing test**

Add to `packages/worker/src/__tests__/index.test.ts`, inside the existing top-level `describe`. Reuse whatever job fixture the neighbouring `processJobInner` tests build (see the calls near lines 373 and 391) rather than inventing a new shape:

```ts
  it('logs when persisting trace_url rejects instead of swallowing it', async () => {
    const { getActiveTraceId, buildLangfuseTraceUrl } = await import('../tracing.js');
    const { updateJobTraceUrl } = await import('../db.js');
    const { logger } = await import('../logger.js');

    vi.mocked(getActiveTraceId).mockReturnValueOnce('trace-abc');
    vi.mocked(buildLangfuseTraceUrl).mockReturnValueOnce('https://lf.example/traces/trace-abc');
    vi.mocked(updateJobTraceUrl).mockRejectedValueOnce(new Error('db down'));

    // Use the same job fixture shape as the neighbouring processJobInner tests.
    const job = makeJob();
    await processJobInner(job, new AbortController().signal);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Failed to persist trace_url', {
      job_id: job.id,
      error: 'db down',
    });
  });
```

If the neighbouring tests build their job inline rather than via a helper, inline the same object here instead of calling `makeJob()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- index`
Expected: FAIL — `logger.warn` is never called; the rejection is swallowed by `.catch(() => {})`.

- [ ] **Step 3: Replace the swallowing catch**

In `processJobInner`, update the import to include `safeErrorMessage`, then replace:

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
        // Only a genuine rejection is worth a line. safeErrorMessage because a
        // raw String(err) here would throw a second, unhandled rejection.
        logger.warn('Failed to persist trace_url', {
          job_id: job.id,
          error: safeErrorMessage(err),
        });
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/worker test -- index`
Expected: PASS.

- [ ] **Step 5: Build and run the full worker suite**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
Expected: no type errors, no new failures.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/index.ts packages/worker/src/__tests__/index.test.ts
git commit -m "fix(worker): log trace_url persistence failures instead of swallowing them"
```

---

## Final Verification

- [ ] Run the package gate:

```bash
pnpm --filter @opslane/worker build
pnpm --filter @opslane/worker test
```

- [ ] Confirm credentials only ever flow into the processor, never into a log call:

```bash
grep -n "credentials" packages/worker/src/tracing.ts
```

Expected: `credentials` appears only in the `createRedactor(...)` call and the `LangfuseSpanProcessor` options, never inside a `logger.*` call.

- [ ] Confirm nothing reads Langfuse env outside the resolver. Match on the actual
      env access, not the bare name — the deep-links warning string legitimately
      contains `LANGFUSE_PROJECT_ID`:

```bash
grep -rn "process\.env\[.LANGFUSE" packages/worker/src --include=*.ts | grep -v __tests__ | grep -v tracing-config.ts
```

Expected: no matches. Every read goes through `resolveTracingConfig`.
