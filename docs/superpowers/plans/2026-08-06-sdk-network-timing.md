# Browser SDK Network Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-request network timing in the browser SDK and persist it on the error event, so a later slice can give the investigation agent evidence about timeout-class failures.

**Architecture:** A new SDK module owns a bounded timing store with two internal collections — an active-request registry and a completion ring — behind a single `snapshotNetworkTimings()` seam. The existing fetch and XHR patches in `network.ts` call into it; `core.ts` attaches a snapshot to the outgoing payload. Ingestion validates and redacts the array independently of the SDK, then stores it in a new JSONB column that nothing reads yet.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Go 1.24 with pgx, Postgres.

Spec: `docs/superpowers/specs/2026-08-06-sdk-network-timing-design.md`

## Global Constraints

- The SDK must never throw into customer code. Every new call site in `network.ts` is wrapped in `try {} catch {}`, matching existing siblings.
- `POST /api/v1/events` is append-only. Add optional fields only; never edit or delete a frozen fixture under `test-fixtures/wire/`.
- Malformed timing data must never fail ingestion.
- Caps, identical in the SDK and in ingestion: 20 entries, `url` 2048 bytes, `method` 16 bytes, elapsed values 600000 ms.
- Use `unknown` plus narrowing instead of `any`. Keep Vitest tests colocated in `__tests__`.
- This PR changes no diagnosis behavior. The `network_timings` column is written by ingestion and read by nothing.

---

### Task 1: Shared type and the timing store

**Files:**
- Modify: `shared/src/types.ts`
- Create: `packages/sdk/src/network-timing.ts`
- Test: `packages/sdk/src/__tests__/network-timing.test.ts`

**Interfaces:**
- Consumes: `scrubUrl` from `packages/sdk/src/scrub.ts`
- Produces: `NetworkTiming` (shared); `startTiming(transport, method, url): number`, `markHeaders(handle): void`, `finalizeTiming(handle, outcome, status?): void`, `discardTiming(handle): void`, `snapshotNetworkTimings(): NetworkTiming[]`, `clearNetworkTimings(): void`

Kept in its own module rather than growing `network.ts` (218 lines): retention policy and outcome shaping are a separate responsibility from patching globals, and Tasks 2 and 3 both consume this one seam.

- [ ] **Step 1: Add the shared type**

In `shared/src/types.ts`, immediately after the `Breadcrumb` interface and its `BreadcrumbType` union:

```ts
/**
 * One observed browser request, attached to an error event.
 *
 * `ttfb_ms` is the cross-transport comparable field: fetch resolves at
 * response headers while XHR `loadend` fires after the transfer completes,
 * so `duration_ms` means different things per transport and `transport`
 * records which. `ttfb_ms` absent on a `timeout` means no headers ever
 * arrived; present means the server responded and the body stalled.
 */
export interface NetworkTiming {
  transport: 'fetch' | 'xhr';
  method: string;
  url: string;
  started_at_ms: number;
  duration_ms: number;
  ttfb_ms?: number;
  outcome: 'ok' | 'http_error' | 'timeout' | 'abort' | 'network_error' | 'in_flight';
  status?: number;
}
```

Add to `ErrorEventPayload`, directly below `debug_meta?: DebugMeta;`:

```ts
  network_timings?: NetworkTiming[];  // observed request timing; omitted when empty
```

- [ ] **Step 2: Build shared so the SDK can import the type**

Run: `pnpm --filter @opslane/shared build`
Expected: PASS

- [ ] **Step 3: Write the failing retention tests**

Create `packages/sdk/src/__tests__/network-timing.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearNetworkTimings,
  discardTiming,
  finalizeTiming,
  markHeaders,
  snapshotNetworkTimings,
  startTiming,
} from '../network-timing';

describe('network timing store', () => {
  beforeEach(() => clearNetworkTimings());

  it('records a completed request', () => {
    const handle = startTiming('fetch', 'GET', 'https://api.test/a');
    markHeaders(handle);
    finalizeTiming(handle, 'ok', 200);

    const [entry] = snapshotNetworkTimings();
    expect(entry.transport).toBe('fetch');
    expect(entry.method).toBe('GET');
    expect(entry.url).toBe('https://api.test/a');
    expect(entry.outcome).toBe('ok');
    expect(entry.status).toBe(200);
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
    expect(entry.ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(entry.started_at_ms).toBeGreaterThan(0);
  });

  it('omits ttfb_ms and status when never observed', () => {
    const handle = startTiming('fetch', 'POST', 'https://api.test/b');
    finalizeTiming(handle, 'timeout');

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('timeout');
    expect(entry).not.toHaveProperty('ttfb_ms');
    expect(entry).not.toHaveProperty('status');
  });

  it('scrubs the query string and truncates oversized values', () => {
    const handle = startTiming('fetch', 'GET', `https://api.test/c?token=secret#x`);
    finalizeTiming(handle, 'ok', 200);

    const [entry] = snapshotNetworkTimings();
    expect(entry.url).not.toContain('secret');

    clearNetworkTimings();
    const long = startTiming('xhr', 'PROPFIND-VERY-LONG-METHOD', `https://api.test/${'a'.repeat(4000)}`);
    finalizeTiming(long, 'ok', 200);

    const [big] = snapshotNetworkTimings();
    expect(big.url.length).toBe(2048);
    expect(big.method.length).toBe(16);
  });

  // The regression the two-collection design exists to prevent: a single FIFO
  // buffer would evict the long-running request being diagnosed.
  it('keeps one long-running active request across 20 later completions', () => {
    const slow = startTiming('fetch', 'POST', 'https://api.test/slow');
    for (let i = 0; i < 20; i += 1) {
      const fast = startTiming('fetch', 'GET', `https://api.test/fast-${i}`);
      finalizeTiming(fast, 'ok', 200);
    }

    const snapshot = snapshotNetworkTimings();
    expect(snapshot[0].url).toBe('https://api.test/slow');
    expect(snapshot[0].outcome).toBe('in_flight');
    expect(snapshot).toHaveLength(20);
    expect(slow).toBeGreaterThanOrEqual(0);
  });

  it('fills the snapshot with actives longest-running first when over the cap', () => {
    for (let i = 0; i < 25; i += 1) startTiming('fetch', 'GET', `https://api.test/active-${i}`);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(20);
    expect(snapshot.every((e) => e.outcome === 'in_flight')).toBe(true);
    expect(snapshot[0].url).toBe('https://api.test/active-0');
  });

  it('finalizes at most once', () => {
    const handle = startTiming('xhr', 'GET', 'https://api.test/d');
    finalizeTiming(handle, 'timeout');
    finalizeTiming(handle, 'ok', 200);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].outcome).toBe('timeout');
  });

  it('discards a record without recording it', () => {
    const handle = startTiming('xhr', 'GET', 'https://api.test/e');
    discardTiming(handle);
    expect(snapshotNetworkTimings()).toHaveLength(0);
  });

  it('clears both collections', () => {
    startTiming('fetch', 'GET', 'https://api.test/f');
    const done = startTiming('fetch', 'GET', 'https://api.test/g');
    finalizeTiming(done, 'ok', 200);

    clearNetworkTimings();
    expect(snapshotNetworkTimings()).toEqual([]);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @opslane/sdk test -- network-timing`
Expected: FAIL — cannot resolve `../network-timing`

- [ ] **Step 5: Implement the store**

Create `packages/sdk/src/network-timing.ts`:

```ts
import type { NetworkTiming } from '@opslane/shared';
import { scrubUrl } from './scrub';

/** Shared with ingestion's sanitizer; both must agree or events get rejected upstream. */
const MAX_ENTRIES = 20;
const MAX_URL_BYTES = 2048;
const MAX_METHOD_BYTES = 16;

export type Transport = NetworkTiming['transport'];
export type Outcome = NetworkTiming['outcome'];

interface ActiveRecord {
  transport: Transport;
  method: string;
  url: string;
  startedAtMs: number;
  startMark: number;
  ttfbMs?: number;
}

let active = new Map<number, ActiveRecord>();
let completed: NetworkTiming[] = [];
let nextHandle = 0;

/**
 * Monotonic clock. `Date.now()` can jump backwards on NTP correction or on a
 * laptop waking from sleep, producing negative or inflated durations on
 * exactly the long-running requests this feature exists to capture.
 */
function mark(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function elapsed(from: number, to: number): number {
  return Math.max(0, Math.round(to - from));
}

export function startTiming(transport: Transport, method: string, url: string): number {
  const handle = nextHandle;
  nextHandle += 1;

  // Evict the NEWEST active record when full, so a burst of short requests
  // cannot displace a long-running one.
  if (active.size >= MAX_ENTRIES) {
    let newestKey = -1;
    let newestMark = -Infinity;
    for (const [key, record] of active) {
      if (record.startMark > newestMark) {
        newestMark = record.startMark;
        newestKey = key;
      }
    }
    if (newestKey >= 0) active.delete(newestKey);
  }

  active.set(handle, {
    transport,
    method: cap(method, MAX_METHOD_BYTES),
    url: cap(scrubUrl(url), MAX_URL_BYTES),
    startedAtMs: Date.now(),
    startMark: mark(),
  });
  return handle;
}

/** Records time-to-response-headers. First call wins. */
export function markHeaders(handle: number): void {
  const record = active.get(handle);
  if (!record || record.ttfbMs !== undefined) return;
  record.ttfbMs = elapsed(record.startMark, mark());
}

/**
 * Moves a record from active to completed. Deleting from the registry is what
 * makes this finalize-once: XHR's `loadend` fires after every terminal event,
 * and a second call finds nothing.
 */
export function finalizeTiming(handle: number, outcome: Outcome, status?: number): void {
  const record = active.get(handle);
  if (!record) return;
  active.delete(handle);

  const entry: NetworkTiming = {
    transport: record.transport,
    method: record.method,
    url: record.url,
    started_at_ms: record.startedAtMs,
    duration_ms: elapsed(record.startMark, mark()),
    outcome,
  };
  if (record.ttfbMs !== undefined) entry.ttfb_ms = record.ttfbMs;
  if (status !== undefined) entry.status = status;

  completed.push(entry);
  if (completed.length > MAX_ENTRIES) completed = completed.slice(completed.length - MAX_ENTRIES);
}

/** Drops a record entirely — used when `send()` throws synchronously. */
export function discardTiming(handle: number): void {
  active.delete(handle);
}

export function snapshotNetworkTimings(): NetworkTiming[] {
  const at = mark();
  const inFlight: NetworkTiming[] = [...active.values()]
    .sort((a, b) => a.startMark - b.startMark)
    .slice(0, MAX_ENTRIES)
    .map((record) => {
      const entry: NetworkTiming = {
        transport: record.transport,
        method: record.method,
        url: record.url,
        started_at_ms: record.startedAtMs,
        duration_ms: elapsed(record.startMark, at),
        outcome: 'in_flight',
      };
      if (record.ttfbMs !== undefined) entry.ttfb_ms = record.ttfbMs;
      return entry;
    });

  const remaining = MAX_ENTRIES - inFlight.length;
  if (remaining <= 0) return inFlight;
  return [...inFlight, ...completed.slice(-remaining).reverse()];
}

export function clearNetworkTimings(): void {
  active = new Map();
  completed = [];
  nextHandle = 0;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @opslane/sdk test -- network-timing`
Expected: PASS (9 tests)

- [ ] **Step 7: Commit**

```bash
git add shared/src/types.ts packages/sdk/src/network-timing.ts packages/sdk/src/__tests__/network-timing.test.ts
git commit -m "feat(sdk): add bounded network timing store"
```

---

### Task 2: Fetch instrumentation

**Files:**
- Modify: `packages/sdk/src/network.ts:43-116`
- Test: `packages/sdk/src/__tests__/network.test.ts`

**Interfaces:**
- Consumes: `startTiming`, `markHeaders`, `finalizeTiming`, `snapshotNetworkTimings`, `clearNetworkTimings` from Task 1
- Produces: nothing new; `patchFetch` gains timing as a side effect

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/src/__tests__/network.test.ts` (keep the file's existing imports; add the timing imports alongside them):

```ts
describe('fetch timing capture', () => {
  beforeEach(() => {
    clearNetworkTimings();
    loadConfig({ apiKey: TEST_PK, endpoint: 'https://api.test', errorThrottleMs: 0 });
  });
  afterEach(() => unpatchFetch());

  it('records ok with status and ttfb', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, type: 'basic' }) as Response);
    patchFetch();
    await fetch('https://app.example.com/api/items');

    const [entry] = snapshotNetworkTimings();
    expect(entry.transport).toBe('fetch');
    expect(entry.outcome).toBe('ok');
    expect(entry.status).toBe(200);
    expect(entry.ttfb_ms).toBeGreaterThanOrEqual(0);
  });

  it('records http_error for a 4xx/5xx response', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 503, ok: false, type: 'basic' }) as Response);
    patchFetch();
    await fetch('https://app.example.com/api/items');

    expect(snapshotNetworkTimings()[0].outcome).toBe('http_error');
  });

  // An opaque response resolves successfully but reports status 0 and
  // ok === false. Classifying on `ok` would report a working cross-origin
  // request as an HTTP error, and status 0 fails ingestion's 100-599 check.
  it('records an opaque response as ok with no status', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 0, ok: false, type: 'opaque' }) as Response);
    patchFetch();
    await fetch('https://cdn.example.com/pixel.gif');

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('ok');
    expect(entry).not.toHaveProperty('status');
  });

  it.each([
    ['TimeoutError', 'timeout'],
    ['AbortError', 'abort'],
    ['TypeError', 'network_error'],
  ])('classifies a %s rejection as %s with no ttfb', async (name, expected) => {
    vi.stubGlobal('fetch', async () => {
      const error = new Error('boom');
      error.name = name;
      throw error;
    });
    patchFetch();
    await expect(fetch('https://app.example.com/api/items')).rejects.toThrow('boom');

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe(expected);
    expect(entry).not.toHaveProperty('ttfb_ms');
  });

  it('does not time the SDK\'s own endpoint', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, type: 'basic' }) as Response);
    patchFetch();
    await fetch('https://api.test/api/v1/events');

    expect(snapshotNetworkTimings()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/sdk test -- network`
Expected: FAIL — `snapshotNetworkTimings()` returns `[]`

- [ ] **Step 3: Wire timing into `patchFetch`**

In `packages/sdk/src/network.ts`, extend the existing import block:

```ts
import { finalizeTiming, markHeaders, startTiming } from './network-timing';
```

Inside the `globalThis.fetch` replacement, directly after the existing `emitTelemetry({ kind: 'request_start', ... })` call:

```ts
    let timingHandle = -1;
    try {
      timingHandle = startTiming('fetch', method, url);
    } catch {
      // SDK must never throw
    }
```

In the success branch, immediately after `const response = await orig.call(globalThis, input, init);`:

```ts
      try {
        markHeaders(timingHandle);
        // An opaque or opaque-redirect response resolves successfully but
        // reports status 0 with ok === false. It is not an HTTP error, and
        // 0 is not a storable status.
        if (response.type === 'opaque' || response.type === 'opaqueredirect') {
          finalizeTiming(timingHandle, 'ok');
        } else {
          finalizeTiming(timingHandle, response.status >= 400 ? 'http_error' : 'ok', response.status);
        }
      } catch {
        // SDK must never throw
      }
```

In the `catch (error: unknown)` branch, immediately after the existing `emitTelemetry({ kind: 'request_end', ... })` call:

```ts
      try {
        const name = error instanceof Error ? error.name : '';
        finalizeTiming(
          timingHandle,
          name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'abort' : 'network_error',
        );
      } catch {
        // SDK must never throw
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @opslane/sdk test -- network`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/network.ts packages/sdk/src/__tests__/network.test.ts
git commit -m "feat(sdk): time fetch requests, classifying opaque responses as ok"
```

---

### Task 3: XHR instrumentation

**Files:**
- Modify: `packages/sdk/src/network.ts:135-207`
- Test: `packages/sdk/src/__tests__/network.test.ts`

**Interfaces:**
- Consumes: Task 1's store, plus `discardTiming`
- Produces: `_opslaneTimingHandle` on the `XHRWithOpslane` interface

XHR's `load`, `timeout`, `abort`, and `error` events are mutually exclusive, and `loadend` — the only event the current patch observes (`network.ts:150`) — does not say which occurred. Each gets its own listener; `finalizeTiming` deleting from the registry makes the subsequent `loadend` a no-op.

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/src/__tests__/network.test.ts`. This uses the file's existing XHR mocking approach; if the file has no XHR harness yet, add this minimal fake:

```ts
class FakeXHR {
  static instances: FakeXHR[] = [];
  readyState = 0;
  status = 0;
  private listeners = new Map<string, Array<() => void>>();
  open(_method: string, _url: string): void {}
  send(): void {}
  addEventListener(type: string, fn: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  setReadyState(state: number): void {
    this.readyState = state;
    this.emit('readystatechange');
  }
}

describe('xhr timing capture', () => {
  beforeEach(() => {
    clearNetworkTimings();
    loadConfig({ apiKey: TEST_PK, endpoint: 'https://api.test', errorThrottleMs: 0 });
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    patchXHR();
  });
  afterEach(() => {
    unpatchXHR();
    vi.unstubAllGlobals();
  });

  function drive(terminal: string, status: number, withHeaders: boolean): void {
    const xhr = new (globalThis.XMLHttpRequest as unknown as typeof FakeXHR)();
    xhr.open('GET', 'https://app.example.com/api/items');
    xhr.send();
    if (withHeaders) xhr.setReadyState(2);
    xhr.status = status;
    xhr.emit(terminal);
    xhr.emit('loadend');
  }

  it.each([
    ['load', 200, 'ok'],
    ['load', 500, 'http_error'],
    ['timeout', 0, 'timeout'],
    ['abort', 0, 'abort'],
    ['error', 0, 'network_error'],
  ])('maps %s/%i to %s', (terminal, status, expected) => {
    drive(terminal, status, false);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].transport).toBe('xhr');
    expect(snapshot[0].outcome).toBe(expected);
  });

  it('records ttfb from HEADERS_RECEIVED, so a body-phase timeout is distinguishable', () => {
    drive('timeout', 0, true);

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('timeout');
    expect(entry.ttfb_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not double-finalize when loadend follows a terminal event', () => {
    drive('timeout', 0, false);
    expect(snapshotNetworkTimings()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/sdk test -- network`
Expected: FAIL — snapshot is empty

- [ ] **Step 3: Extend the XHR patch**

In `packages/sdk/src/network.ts`, add `discardTiming` to the `./network-timing` import.

Add a field to the existing `XHRWithOpslane` interface:

```ts
  _opslaneTimingHandle?: number;
```

Inside `XMLHttpRequest.prototype.send`, replace the existing `try { ... }` telemetry block's tail so that after `this.addEventListener('loadend', ...)` for telemetry, the timing listeners are registered:

```ts
        const timingHandle = startTiming('xhr', this._opslaneMethod || 'GET', url);
        this._opslaneTimingHandle = timingHandle;

        this.addEventListener('readystatechange', () => {
          // 2 === HEADERS_RECEIVED. This is the cross-transport comparable
          // milestone: fetch resolves here, XHR's loadend does not.
          if (this.readyState === 2) {
            try { markHeaders(timingHandle); } catch { /* SDK must never throw */ }
          }
        });

        // load/timeout/abort/error are mutually exclusive; loadend follows all
        // of them and cannot distinguish them. finalizeTiming is idempotent.
        const finalize = (outcome: Outcome, withStatus: boolean): void => {
          try {
            finalizeTiming(timingHandle, outcome, withStatus ? this.status : undefined);
          } catch {
            // SDK must never throw
          }
        };
        this.addEventListener('load', () => finalize(this.status >= 400 ? 'http_error' : 'ok', true), { once: true });
        this.addEventListener('timeout', () => finalize('timeout', false), { once: true });
        this.addEventListener('abort', () => finalize('abort', false), { once: true });
        this.addEventListener('error', () => finalize('network_error', false), { once: true });
```

Import the `Outcome` type alongside the functions:

```ts
import { discardTiming, finalizeTiming, markHeaders, startTiming, type Outcome } from './network-timing';
```

Replace the final `return origSend.apply(this, args);` so a synchronous throw removes the record rather than leaving it in flight forever:

```ts
    try {
      return origSend.apply(this, args);
    } catch (error) {
      try {
        if (this._opslaneTimingHandle !== undefined) discardTiming(this._opslaneTimingHandle);
      } catch {
        // SDK must never throw
      }
      throw error; // rethrow unchanged
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @opslane/sdk test -- network`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/network.ts packages/sdk/src/__tests__/network.test.ts
git commit -m "feat(sdk): time XHR requests with an explicit terminal-event matrix"
```

---

### Task 4: Payload attachment and teardown

**Files:**
- Modify: `packages/sdk/src/core.ts:65-99`
- Modify: `packages/sdk/src/index.ts:53-69`
- Test: `packages/sdk/src/__tests__/core.test.ts`

**Interfaces:**
- Consumes: `snapshotNetworkTimings`, `clearNetworkTimings` from Task 1
- Produces: `ErrorEventPayload.network_timings` populated on real payloads

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/src/__tests__/core.test.ts`:

```ts
describe('network timings on the payload', () => {
  beforeEach(() => clearNetworkTimings());

  it('omits the field entirely when nothing was captured', () => {
    const payload = buildPayload('TypeError', 'boom', '', {
      type: 'error', timestamp: new Date().toISOString(), category: 'exception', message: 'boom',
    });
    expect(payload).not.toHaveProperty('network_timings');
  });

  it('attaches captured timings', () => {
    const handle = startTiming('fetch', 'GET', 'https://app.example.com/api/items');
    finalizeTiming(handle, 'timeout');

    const payload = buildPayload('TypeError', 'boom', '', {
      type: 'error', timestamp: new Date().toISOString(), category: 'exception', message: 'boom',
    });
    expect(payload.network_timings).toHaveLength(1);
    expect(payload.network_timings?.[0].outcome).toBe('timeout');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @opslane/sdk test -- core`
Expected: FAIL — `network_timings` is undefined in the second test

- [ ] **Step 3: Attach the snapshot in `buildPayload`**

In `packages/sdk/src/core.ts`, add to the import block:

```ts
import { snapshotNetworkTimings } from './network-timing';
```

Replace the `return { ... }` at the end of `buildPayload` with a named object so the field can be added conditionally:

```ts
  const payload: ErrorEventPayload = {
    timestamp: new Date().toISOString(),
    error: {
      type: errorType,
      message: errorMessage,
      stack,
    },
    breadcrumbs: getBreadcrumbs(),
    context,
    sdk_version: SDK_VERSION,
    release: config.release || undefined,
    commit_sha: readCommitSha(),
    session_id: getSessionId() || undefined,
    environment: config.environment || undefined,
  };

  // Omitted rather than sent as [], so the minimal wire fixture stays minimal.
  const timings = snapshotNetworkTimings();
  if (timings.length > 0) payload.network_timings = timings;

  return payload;
```

- [ ] **Step 4: Clear timings on teardown**

In `packages/sdk/src/index.ts`, add to the `./network` import line's neighbours:

```ts
import { clearNetworkTimings } from './network-timing';
```

In `destroy()`, directly after `safeCall(clearBreadcrumbs);`:

```ts
  safeCall(clearNetworkTimings);
```

Without this, request history survives reinitialization and can carry requests captured under one project configuration into an event sent under another.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @opslane/sdk test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/core.ts packages/sdk/src/index.ts packages/sdk/src/__tests__/core.test.ts
git commit -m "feat(sdk): attach network timings to the error payload and clear on destroy"
```

---

### Task 5: Wire contract — version bump and frozen fixtures

**Files:**
- Modify: `packages/sdk/package.json:3`
- Create: `test-fixtures/wire/events/v4.1.0-minimal.json`
- Create: `test-fixtures/wire/events/v4.1.0-full.json`
- Modify: `packages/sdk/src/__tests__/wire-shape.test.ts:20,33-56,120-176`

**Interfaces:**
- Consumes: Task 4's payload attachment
- Produces: frozen fixtures replayed by `wire_compat_test.go` in Task 7

`WIRE_FIXTURE_VERSION` currently reads `3.0.0` against a `4.0.0` package. `docs/contracts/events.md:17` requires a pair for every released SDK version, so that gap is pre-existing repository debt — add the `4.1.0` pair this change introduces and do not backfill `4.0.0`.

- [ ] **Step 1: Bump the package version**

In `packages/sdk/package.json`, change `"version": "4.0.0"` to `"version": "4.1.0"`. Adding an optional field is a minor bump.

- [ ] **Step 2: Create the minimal fixture**

Create `test-fixtures/wire/events/v4.1.0-minimal.json` — identical to `v3.0.0-minimal.json` with the version changed, and **no** `network_timings` key, encoding that the field is omitted when empty:

```json
{
  "timestamp": "2026-07-16T00:00:00.000Z",
  "error": {
    "type": "TypeError",
    "message": "Cannot read properties of null (reading 'name')",
    "stack": "TypeError: Cannot read properties of null (reading 'name')\n    at UserCard (https://app.example.com/assets/index.js:8:20)"
  },
  "breadcrumbs": [],
  "context": {
    "url": "https://app.example.com/dashboard",
    "user_agent": "Mozilla/5.0"
  },
  "sdk_version": "4.1.0"
}
```

- [ ] **Step 3: Create the full fixture**

Copy the existing full fixture and edit it, rather than retyping fields:

```bash
cp test-fixtures/wire/events/v3.0.0-full.json test-fixtures/wire/events/v4.1.0-full.json
```

Then in `v4.1.0-full.json`: change `"sdk_version"` to `"4.1.0"`, and add a top-level `network_timings` key:

```json
  "network_timings": [
    {
      "transport": "fetch",
      "method": "POST",
      "url": "https://api.example.com/v1/assets/search",
      "started_at_ms": 1784160000000,
      "duration_ms": 10002,
      "outcome": "timeout"
    }
  ]
```

`ttfb_ms` is deliberately absent — this fixture encodes the PR #1297 shape, where no response headers ever arrived.

- [ ] **Step 4: Update the wire-shape test**

In `packages/sdk/src/__tests__/wire-shape.test.ts`:

Change line 20 to:

```ts
const WIRE_FIXTURE_VERSION = '4.1.0';
```

Add to the import block:

```ts
import { clearNetworkTimings, finalizeTiming, startTiming } from '../network-timing';
```

Inside `normalize()`, before the closing `return value;`, sentinel the volatile timing values — durations and wall-clock starts vary per run, exactly like `timestamp`:

```ts
  if (Array.isArray(value.network_timings)) {
    for (const timing of value.network_timings as Array<Record<string, unknown>>) {
      if (!timing) continue;
      if (typeof timing.started_at_ms === 'number') timing.started_at_ms = SENTINEL;
      if (typeof timing.duration_ms === 'number') timing.duration_ms = SENTINEL;
      if (typeof timing.ttfb_ms === 'number') timing.ttfb_ms = SENTINEL;
    }
  }
```

In the top-level `beforeEach`, add alongside `clearBreadcrumbs()`:

```ts
    clearNetworkTimings();
```

In the `'full payload matches the frozen fixture'` test, directly before the `const wire = await captureWire(...)` line, seed one timing matching the fixture:

```ts
    const timingHandle = startTiming('fetch', 'POST', 'https://api.example.com/v1/assets/search');
    finalizeTiming(timingHandle, 'timeout');
```

- [ ] **Step 5: Run the wire-shape test**

Run: `pnpm --filter @opslane/sdk build && pnpm --filter @opslane/sdk test -- wire-shape`
Expected: PASS. The build is required because `sdk_version` is injected at build time.

- [ ] **Step 6: Verify no frozen fixture was modified**

Run: `git status --porcelain test-fixtures/wire/`
Expected: only two lines, both `??` (untracked new files). Any ` M` line is a contract violation — revert it.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/package.json test-fixtures/wire/events/v4.1.0-minimal.json test-fixtures/wire/events/v4.1.0-full.json packages/sdk/src/__tests__/wire-shape.test.ts
git commit -m "test(sdk): freeze the v4.1.0 wire shape with network_timings"
```

---

### Task 6: Strict request-URL redaction in the masking package

**Files:**
- Modify: `packages/ingestion/masking/masking.go`
- Test: `packages/ingestion/masking/masking_test.go`

**Interfaces:**
- Consumes: existing `RedactURL`
- Produces: `masking.RedactRequestURL(raw string) string`, consumed by Task 7

Ingestion accepts payloads from arbitrary and older clients, so shape validation alone would persist unsanitized URLs. `RedactURL` exists but deliberately preserves non-sensitive query parameters, leaving it weaker than the SDK's `scrubUrl`.

- [ ] **Step 1: Write the failing test**

Append to `packages/ingestion/masking/masking_test.go`:

```go
func TestRedactRequestURL(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"drops the whole query string", "https://api.example.com/v1/search?q=hi&token=abc", "https://api.example.com/v1/search"},
		{"drops userinfo", "https://user:pw@api.example.com/v1/search", "https://api.example.com/v1/search"},
		{"drops a token-bearing fragment", "https://api.example.com/cb#access_token=abc", "https://api.example.com/cb"},
		{"keeps a route fragment", "https://app.example.com/x#/dashboard", "https://app.example.com/x#/dashboard"},
		{"leaves a clean URL alone", "https://api.example.com/v1/items", "https://api.example.com/v1/items"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RedactRequestURL(tc.in); got != tc.want {
				t.Fatalf("RedactRequestURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRedactRequestURLUnparseable(t *testing.T) {
	// Falls back to RedactURL rather than returning the raw value.
	got := RedactRequestURL("://not a url?token=abc")
	if strings.Contains(got, "abc") {
		t.Fatalf("RedactRequestURL leaked a token: %q", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/ingestion && go test ./masking/ -run RedactRequestURL`
Expected: FAIL — undefined: RedactRequestURL

- [ ] **Step 3: Implement it**

In `packages/ingestion/masking/masking.go`, add `"net/url"` to the import block, then add below `RedactURL`:

```go
// tokenFragmentRe matches fragments carrying an OAuth-style credential.
var tokenFragmentRe = regexp.MustCompile(`(?i)\b(access_token|id_token|refresh_token|token|code)=`)

// RedactRequestURL strips userinfo, the entire query string, and token-bearing
// fragments from a single request URL. It is deliberately stricter than
// RedactURL, which preserves non-sensitive query parameters: request URLs
// captured from a customer's browser must retain no query data at all, and
// ingestion cannot assume the client already scrubbed them.
func RedactRequestURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return RedactURL(raw)
	}
	u.User = nil
	u.RawQuery = ""
	u.ForceQuery = false
	if u.Fragment != "" && tokenFragmentRe.MatchString(u.Fragment) {
		u.Fragment = ""
	}
	return u.String()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/ingestion && go test ./masking/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/masking/
git commit -m "feat(ingestion): add strict request-URL redaction"
```

---

### Task 7: Ingestion sanitizer

**Files:**
- Modify: `packages/ingestion/handler/error_event.go:90-145`
- Modify: `packages/ingestion/handler/metrics.go`
- Test: `packages/ingestion/handler/error_event_test.go`

**Interfaces:**
- Consumes: `masking.RedactRequestURL` from Task 6
- Produces: `sanitizeNetworkTimings(raw json.RawMessage) string` returning JSON, defaulting to `"[]"`; `RecordNetworkTimingDiscard(reason string)`

- [ ] **Step 1: Write the failing tests**

Append to `packages/ingestion/handler/error_event_test.go`:

```go
func TestSanitizeNetworkTimings(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"absent", ``, `[]`},
		{"non-array container", `{"a":1}`, `[]`},
		{"non-object entry", `["x"]`, `[]`},
		{"bad transport", `[{"transport":"grpc","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok"}]`, `[]`},
		{"bad method", `[{"transport":"fetch","method":"get!","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok"}]`, `[]`},
		{"bad outcome", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"weird"}]`, `[]`},
		{"negative duration", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":-2,"outcome":"ok"}]`, `[]`},
		{"duration over cap", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":600001,"outcome":"ok"}]`, `[]`},
		{"control chars in url", "[{\"transport\":\"fetch\",\"method\":\"GET\",\"url\":\"https://a.test/\\u0000\",\"started_at_ms\":1,\"duration_ms\":2,\"outcome\":\"ok\"}]", `[]`},
		{"status out of range", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok","status":0}]`, `[]`},
		{
			"valid entry is retained and its query stripped",
			`[{"transport":"fetch","method":"get","url":"https://a.test/x?token=abc","started_at_ms":1,"duration_ms":2,"outcome":"timeout"}]`,
			`[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"timeout"}]`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeNetworkTimings(json.RawMessage(tc.in))
			if got != tc.want {
				t.Fatalf("sanitizeNetworkTimings(%s) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestSanitizeNetworkTimingsCapsAtTwenty(t *testing.T) {
	var entries []string
	for i := 0; i < 30; i++ {
		entries = append(entries, `{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok","status":200}`)
	}
	raw := "[" + strings.Join(entries, ",") + "]"

	var got []map[string]any
	if err := json.Unmarshal([]byte(sanitizeNetworkTimings(json.RawMessage(raw))), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 20 {
		t.Fatalf("retained %d entries, want 20", len(got))
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && go test ./handler/ -run NetworkTimings`
Expected: FAIL — undefined: sanitizeNetworkTimings

- [ ] **Step 3: Implement the sanitizer**

In `packages/ingestion/handler/error_event.go`, add the import for the masking package if absent, then add near `sanitizeDebugMeta`:

```go
const (
	maxNetworkTimings   = 20
	maxTimingURLBytes   = 2048
	maxTimingElapsedMs  = 600000
)

var (
	reTimingMethod    = regexp.MustCompile(`^[A-Z]{1,16}$`)
	validTransports   = map[string]struct{}{"fetch": {}, "xhr": {}}
	validTimingOutcome = map[string]struct{}{
		"ok": {}, "http_error": {}, "timeout": {},
		"abort": {}, "network_error": {}, "in_flight": {},
	}
)

type validatedNetworkTiming struct {
	Transport   string `json:"transport"`
	Method      string `json:"method"`
	URL         string `json:"url"`
	StartedAtMs int64  `json:"started_at_ms"`
	DurationMs  int64  `json:"duration_ms"`
	TTFBMs      *int64 `json:"ttfb_ms,omitempty"`
	Outcome     string `json:"outcome"`
	Status      *int   `json:"status,omitempty"`
}

func validTimingURL(value string) bool {
	if len(value) == 0 || len(value) > maxTimingURLBytes {
		return false
	}
	return strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) < 0
}

func validElapsed(value int64) bool {
	return value >= 0 && value <= maxTimingElapsedMs
}

// sanitizeNetworkTimings validates advisory request timing. Like debug_meta,
// malformed data is discarded rather than failing the event. URLs are redacted
// here independently of the SDK, because ingestion accepts payloads from
// arbitrary and older clients.
func sanitizeNetworkTimings(raw json.RawMessage) string {
	const empty = `[]`
	if len(raw) == 0 {
		return empty
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		RecordNetworkTimingDiscard("malformed_container")
		return empty
	}

	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil || entries == nil {
		RecordNetworkTimingDiscard("malformed_container")
		return empty
	}

	retained := make([]validatedNetworkTiming, 0, min(len(entries), maxNetworkTimings))
	for _, entry := range entries {
		if len(retained) == maxNetworkTimings {
			RecordNetworkTimingDiscard("over_limit")
			continue
		}

		var candidate validatedNetworkTiming
		trimmedEntry := bytes.TrimSpace(entry)
		if len(trimmedEntry) == 0 || trimmedEntry[0] != '{' || json.Unmarshal(trimmedEntry, &candidate) != nil {
			RecordNetworkTimingDiscard("non_object_entry")
			continue
		}
		if _, ok := validTransports[candidate.Transport]; !ok {
			RecordNetworkTimingDiscard("bad_transport")
			continue
		}
		candidate.Method = strings.ToUpper(candidate.Method)
		if !reTimingMethod.MatchString(candidate.Method) {
			RecordNetworkTimingDiscard("bad_method")
			continue
		}
		if !validTimingURL(candidate.URL) {
			RecordNetworkTimingDiscard("bad_url")
			continue
		}
		if _, ok := validTimingOutcome[candidate.Outcome]; !ok {
			RecordNetworkTimingDiscard("bad_outcome")
			continue
		}
		// An epoch value, so only checked for non-negativity — the elapsed cap
		// does not apply to it.
		if candidate.StartedAtMs < 0 {
			RecordNetworkTimingDiscard("bad_started_at")
			continue
		}
		if !validElapsed(candidate.DurationMs) {
			RecordNetworkTimingDiscard("bad_duration")
			continue
		}
		if candidate.TTFBMs != nil && !validElapsed(*candidate.TTFBMs) {
			RecordNetworkTimingDiscard("bad_ttfb")
			continue
		}
		if candidate.Status != nil && (*candidate.Status < 100 || *candidate.Status > 599) {
			RecordNetworkTimingDiscard("bad_status")
			continue
		}

		candidate.URL = masking.RedactRequestURL(candidate.URL)
		if !validTimingURL(candidate.URL) {
			RecordNetworkTimingDiscard("bad_url")
			continue
		}
		retained = append(retained, candidate)
	}

	encoded, err := json.Marshal(retained)
	if err != nil {
		return empty
	}
	return string(encoded)
}
```

- [ ] **Step 4: Add the metric**

In `packages/ingestion/handler/metrics.go`, mirror `RecordDebugMetaDiscard` and its `/metrics` output block, using the name `opslane_network_timings_discarded_total` with a `reason` label and the help text `Network timing entries discarded during validation`.

- [ ] **Step 5: Call it from the ingest path**

In `error_event.go`, add to the anonymous `payload` struct after `DebugMeta`:

```go
		NetworkTimings json.RawMessage `json:"network_timings"`
```

and next to the existing `debugMeta := sanitizeDebugMeta(...)` line:

```go
	networkTimings := sanitizeNetworkTimings(payload.NetworkTimings)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/ingestion && go test ./handler/ -run NetworkTimings && go build ./...`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/handler/
git commit -m "feat(ingestion): validate and redact network timings"
```

---

### Task 8: Migration and storage

**Files:**
- Create: `packages/ingestion/db/migrations/033_event_network_timings.sql`
- Modify: `packages/ingestion/db/queries.go:415-470,519-523`
- Modify: `packages/ingestion/handler/error_event.go:230-250`
- Test: `packages/ingestion/db/queries_test.go`

**Interfaces:**
- Consumes: `sanitizeNetworkTimings` from Task 7
- Produces: `IngestParams.NetworkTimings string`; `error_events.network_timings` JSONB column

- [ ] **Step 1: Write the migration**

Create `packages/ingestion/db/migrations/033_event_network_timings.sql`:

```sql
SET lock_timeout = '3s';

-- Written by ingestion, read by nothing. The worker slice that renders these
-- into the investigation prompt lands separately; an unread column here is
-- intentional, not dead schema.
ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS network_timings JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE error_events DROP CONSTRAINT IF EXISTS error_events_network_timings_array;
ALTER TABLE error_events ADD CONSTRAINT error_events_network_timings_array
  CHECK (jsonb_typeof(network_timings) = 'array') NOT VALID;

ALTER TABLE error_events VALIDATE CONSTRAINT error_events_network_timings_array;
```

Note the existing duplicate `028_` prefix in this directory is pre-existing debt; `033` is the next free number.

- [ ] **Step 2: Thread the field through `IngestParams`**

In `packages/ingestion/db/queries.go`, add below `DebugMeta`:

```go
	NetworkTimings string // JSON array, defaults to "[]"
```

In `InsertErrorEventAndGroup`, below the existing `DebugMeta` default:

```go
	if p.NetworkTimings == "" {
		p.NetworkTimings = "[]"
	}
```

Extend the INSERT at line 519 — add `network_timings` to the column list, `$14::jsonb` to VALUES, and `p.NetworkTimings` as the final argument.

- [ ] **Step 3: Pass it from the handler**

In `error_event.go`, add to the `IngestParams` literal after `DebugMeta:`:

```go
		NetworkTimings:       networkTimings,
```

- [ ] **Step 4: Write the failing round-trip test**

Append to `packages/ingestion/db/queries_test.go`, following the file's existing DB-test setup helpers:

```go
func TestInsertErrorEventStoresNetworkTimings(t *testing.T) {
	q, projectID := setupTestProject(t)
	timings := `[{"transport":"fetch","method":"POST","url":"https://api.test/search","started_at_ms":1,"duration_ms":10002,"outcome":"timeout"}]`

	result, err := q.InsertErrorEventAndGroup(context.Background(), IngestParams{
		ProjectID:      projectID,
		ErrorType:      "TimeoutError",
		ErrorMessage:   "signal timed out",
		Fingerprint:    "fp-timing",
		Title:          "TimeoutError: signal timed out",
		NetworkTimings: timings,
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}

	var stored string
	if err := q.pool.QueryRow(context.Background(),
		`SELECT network_timings::text FROM error_events WHERE id = $1`, result.EventID,
	).Scan(&stored); err != nil {
		t.Fatalf("select: %v", err)
	}
	if !strings.Contains(stored, `"outcome": "timeout"`) && !strings.Contains(stored, `"outcome":"timeout"`) {
		t.Fatalf("stored timings missing outcome: %s", stored)
	}
}
```

Adapt `setupTestProject` to whatever the file's existing helper is named — do not introduce a second one.

- [ ] **Step 5: Apply migrations and run the tests**

```bash
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:${OPSLANE_POSTGRES_HOST_PORT:-5434}/opslane?sslmode=disable"
cd packages/ingestion && go test ./db/ -run NetworkTimings -v
```

Expected: PASS, and **not** `SKIP`. A skip means `DATABASE_URL` is unset and the test never ran.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/ packages/ingestion/handler/error_event.go
git commit -m "feat(ingestion): store network timings on error events"
```

---

### Task 9: Wire-compat replay and contract documentation

**Files:**
- Modify: `docs/contracts/events.md`
- Test: `packages/ingestion/handler/wire_compat_test.go`

**Interfaces:**
- Consumes: fixtures from Task 5, sanitizer from Task 7, column from Task 8

- [ ] **Step 1: Run the existing wire-compat suite against the new fixtures**

Run: `cd packages/ingestion && go test ./handler/ -run WireCompat -v`
Expected: PASS, including the two new `v4.1.0` files. The suite discovers fixtures from the directory, so no test change should be needed — if it hardcodes a version list, add `4.1.0` to it.

- [ ] **Step 2: Document the field**

Append a section to `docs/contracts/events.md`, after the existing "Build provenance and debug images" section:

```markdown
## Network timings

Browser SDK 4.1.0 adds the optional top-level `network_timings` array. Each entry
describes one observed browser request:

- `transport` — `fetch` or `xhr`
- `method` — 1–16 uppercase letters
- `url` — 1–2048 bytes, no control characters
- `started_at_ms` — epoch milliseconds
- `duration_ms` — start to terminal event, 0–600000
- `ttfb_ms` — optional; time to response headers, 0–600000
- `outcome` — `ok`, `http_error`, `timeout`, `abort`, `network_error`, or `in_flight`
- `status` — optional integer, 100–599

The corresponding frozen fixtures are `v4.1.0-minimal.json` (field omitted) and
`v4.1.0-full.json` (field populated). Older payloads remain valid.

`duration_ms` is transport-dependent: `fetch` resolves when response headers
arrive, while XHR `loadend` fires after the transfer completes. `ttfb_ms` is the
comparable field across both. A fetch entry never reflects response-body time.

Timing data is advisory and must never make event ingestion fail. Ingestion
sanitizes it before storage: a non-array container becomes `[]`; entries failing
any constraint above are dropped individually; at most 20 entries are retained in
first-seen order. URLs are redacted server-side — userinfo, the full query string,
and token-bearing fragments are stripped regardless of what the client sent.
```

- [ ] **Step 3: Commit**

```bash
git add docs/contracts/events.md packages/ingestion/handler/wire_compat_test.go
git commit -m "docs: document the network_timings wire field"
```

---

### Task 10: Full gate and live smoke

**Files:** none modified — this task proves the previous nine.

- [ ] **Step 1: Run the full repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Expected: all pass. Read the **skip count**, not the pass count — database-gated suites report skipped rather than failed when `DATABASE_URL` is unset.

- [ ] **Step 2: Export the worktree port block as a unit**

```bash
export INGESTION_PORT=8092
export OPSLANE_POSTGRES_HOST_PORT=5444
export OPSLANE_MINIO_HOST_PORT=9022
export INGESTION_URL="http://localhost:$INGESTION_PORT"
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:$OPSLANE_POSTGRES_HOST_PORT/opslane?sslmode=disable"
export MINIO_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT"
export REPLAY_STORE_ENDPOINT="$MINIO_ENDPOINT"
export REPLAY_STORE_PUBLIC_ENDPOINT="$MINIO_ENDPOINT"
export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
```

Setting a port without its URL is the silent failure mode: Go DB tests fall back to the hardcoded `localhost:5434` DSN and skip instead of failing.

- [ ] **Step 3: Confirm Go tests run with zero skips**

Run: `cd packages/ingestion && go test ./... 2>&1 | grep -c SKIP`
Expected: `0`. A storage misconfiguration reports `ok` while roughly 30 tests never run.

- [ ] **Step 4: Bring the stack up and apply migrations**

```bash
docker compose up -d postgres minio
docker compose build ingestion && docker compose up -d ingestion
psql "$DATABASE_URL" -f scripts/seed-e2e.sql
```

- [ ] **Step 5: Post an event carrying timings and assert it stored**

```bash
curl -sS -X POST "$INGESTION_URL/api/v1/events" \
  -H 'Content-Type: application/json' \
  -H "X-Opslane-Key: $(psql "$DATABASE_URL" -tAc "SELECT public_key FROM project_api_keys LIMIT 1")" \
  -d '{
    "timestamp": "2026-08-06T00:00:00.000Z",
    "error": {"type":"TimeoutError","message":"signal timed out","stack":""},
    "breadcrumbs": [],
    "context": {"url":"https://app.example.com/assets"},
    "sdk_version": "4.1.0",
    "network_timings": [
      {"transport":"fetch","method":"POST","url":"https://api.example.com/v1/assets/search?token=leak","started_at_ms":1784160000000,"duration_ms":10002,"outcome":"timeout"},
      {"transport":"fetch","method":"GET","url":"https://api.example.com/v1/user","started_at_ms":1784160000100,"duration_ms":184,"ttfb_ms":170,"outcome":"ok","status":200}
    ]
  }'

psql "$DATABASE_URL" -c \
  "SELECT jsonb_pretty(network_timings) FROM error_events ORDER BY created_at DESC LIMIT 1;"
```

Expected: both entries stored; the first has `"outcome": "timeout"` with no `ttfb_ms` key; **neither URL contains `token=leak`**, proving server-side redaction ran independently of the SDK.

- [ ] **Step 6: Confirm the auth header name**

If the `curl` returns 401, read the key header name from `packages/ingestion/handler/routes.go` and correct the command rather than disabling auth.

- [ ] **Step 7: Commit any fixes and open the PR**

The PR description must state that this changes no diagnosis behavior and that the column is read by nothing until the worker slice lands, or it will be misread as a fix for the timeout-diagnosis problem.

---

## Self-Review

**Spec coverage.** Wire shape → Task 1. Timing milestones and `ttfb_ms` → Tasks 1–3. Fetch outcome matrix including opaque → Task 2. XHR matrix, finalize-once, sync-throw → Task 3. Retention with active registry and completion ring → Task 1. `destroy()` clearing → Task 4. Field omitted when empty → Tasks 4 and 5. SDK caps → Task 1. Migration and storage → Task 8. Ingestion validation → Task 7. Independent server-side redaction → Tasks 6 and 7. Fixtures and the version-debt note → Task 5. Contract docs → Task 9. Live smoke with zero skips → Task 10.

**Not covered by any task, by design:** the spec's "what this does not deliver" items — worker consumption, backend correlation, fetch body-phase timing, aggregates.

**Type consistency.** `snapshotNetworkTimings`, `startTiming`, `markHeaders`, `finalizeTiming`, `discardTiming`, `clearNetworkTimings` are named identically in Tasks 1–5. `NetworkTiming` field names match between `shared/src/types.ts` (Task 1), the fixtures (Task 5), and `validatedNetworkTiming`'s JSON tags (Task 7). The cap of 20 appears in Task 1 (`MAX_ENTRIES`) and Task 7 (`maxNetworkTimings`) and must stay equal.
