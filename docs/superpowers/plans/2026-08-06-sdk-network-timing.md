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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    const long = startTiming('xhr', 'propfind-very-long-method', `https://api.test/${'a'.repeat(4000)}`);
    finalizeTiming(long, 'ok', 200);

    const [big] = snapshotNetworkTimings();
    expect(big.url.length).toBe(2048);
    expect(big.method).toBe('PROPFIND-VERY-LO');
  });

  // Ingestion measures the URL in UTF-8 bytes. A UTF-16 `.length` cap would
  // emit a value the SDK considers legal and the Go sanitizer drops.
  it('truncates the url by utf-8 bytes, not utf-16 units', () => {
    const handle = startTiming('fetch', 'GET', `https://api.test/${'é'.repeat(2000)}`);
    finalizeTiming(handle, 'ok', 200);

    const [entry] = snapshotNetworkTimings();
    expect(new TextEncoder().encode(entry.url).length).toBeLessThanOrEqual(2048);
    expect(entry.url).not.toMatch(/�$/);
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

  // Locks the retention policy end to end: the OLDEST 20 are kept and the
  // arrivals that came after them are refused, not the reverse.
  it('refuses new requests at capacity and keeps the oldest twenty', () => {
    const handles = [];
    for (let i = 0; i < 25; i += 1) handles.push(startTiming('fetch', 'GET', `https://api.test/active-${i}`));

    expect(handles[19]).not.toBe(-1);
    expect(handles[20]).toBe(-1);
    expect(handles[24]).toBe(-1);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(20);
    expect(snapshot.every((e) => e.outcome === 'in_flight')).toBe(true);
    expect(snapshot[0].url).toBe('https://api.test/active-0');
    expect(snapshot[19].url).toBe('https://api.test/active-19');
    expect(snapshot.some((e) => e.url === 'https://api.test/active-20')).toBe(false);
  });

  it('no-ops on the untracked handle', () => {
    for (let i = 0; i < 20; i += 1) startTiming('fetch', 'GET', `https://api.test/a-${i}`);
    const untracked = startTiming('fetch', 'GET', 'https://api.test/refused');
    expect(untracked).toBe(-1);

    markHeaders(untracked);
    finalizeTiming(untracked, 'ok', 200);
    discardTiming(untracked);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(20);
    expect(snapshot.some((e) => e.url === 'https://api.test/refused')).toBe(false);
  });

  it('snapshots in-flight elapsed time from the monotonic clock', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);
    startTiming('fetch', 'POST', 'https://api.test/slow');
    nowSpy.mockReturnValue(11002);

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('in_flight');
    expect(entry.duration_ms).toBe(10002);
    nowSpy.mockRestore();
  });

  // Ingestion drops entries above 600000, so the SDK must clamp rather than
  // emit a value that will be discarded server-side.
  it('clamps elapsed values at the ingestion ceiling', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    const handle = startTiming('fetch', 'GET', 'https://api.test/forever');
    nowSpy.mockReturnValue(900000);
    finalizeTiming(handle, 'timeout');

    expect(snapshotNetworkTimings()[0].duration_ms).toBe(600000);
    nowSpy.mockRestore();
  });

  // unpatchFetch cannot cancel an awaiting request, so a callback from before
  // destroy() can fire after re-init. Handles must never be reissued.
  it('does not reuse handles after clearing', () => {
    const stale = startTiming('fetch', 'GET', 'https://api.test/old');
    clearNetworkTimings();
    const fresh = startTiming('fetch', 'GET', 'https://api.test/new');
    expect(fresh).not.toBe(stale);

    finalizeTiming(stale, 'ok', 200); // the stale callback fires late

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].url).toBe('https://api.test/new');
    expect(snapshot[0].outcome).toBe('in_flight');
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
const MAX_ELAPSED_MS = 600000;

/** Returned by startTiming when the active registry is full. All other exports no-op on it. */
const UNTRACKED = -1;

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

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

/**
 * Truncate to at most `maxBytes` UTF-8 bytes. Ingestion measures bytes; a
 * UTF-16 `.length` cap would let a Unicode URL pass here and be dropped there.
 */
function capBytes(value: string, maxBytes: number): string {
  if (!encoder || !decoder) return value.length > maxBytes ? value.slice(0, maxBytes) : value;
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  // A cut mid-sequence decodes to U+FFFD; strip it so no stored URL ends in a
  // replacement character.
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/, '');
}

/** Clamped, not just floored: ingestion drops entries above MAX_ELAPSED_MS. */
function elapsed(from: number, to: number): number {
  return Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(to - from)));
}

export function startTiming(transport: Transport, method: string, url: string): number {
  // At capacity, refuse the NEW request rather than evicting an existing one.
  // Evicting the newest-and-then-inserting an even newer record would keep the
  // arrival that just displaced its predecessor, defeating the whole point:
  // the registry must retain the OLDEST requests, which are the long-running
  // ones being diagnosed.
  if (active.size >= MAX_ENTRIES) return UNTRACKED;

  const handle = nextHandle;
  nextHandle += 1;

  active.set(handle, {
    transport,
    method: capBytes(method.toUpperCase(), MAX_METHOD_BYTES),
    url: capBytes(scrubUrl(url), MAX_URL_BYTES),
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
  // nextHandle is deliberately NOT reset. `unpatchFetch`/`unpatchXHR` cannot
  // cancel a request that is already awaiting (network.ts:70) or detach
  // listeners already registered, so a callback from before destroy() can fire
  // after re-init. If handles restarted at zero, that stale callback would
  // finalize an unrelated new request that had been issued the same handle.
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @opslane/sdk test -- network-timing`
Expected: PASS (14 tests)

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

  // isSdkEndpoint is a raw prefix match (network.ts:16), so this asserts only
  // that the SDK's own traffic is excluded. It does not characterise the
  // helper's prefix behaviour, which is pre-existing and out of scope here.
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

- [ ] **Step 5: Add real-browser capture coverage**

The spec requires a real-browser test that executes rather than skips. Append to `packages/sdk/src/__tests__/browser-contract.test.ts`, inside the existing describe that already holds `page`/`vitePort` (`browser-contract.test.ts:136`), following its established `page.goto` / `page.click` / `waitForTimeout` shape:

```ts
  it('captures fetch timing on the event, including a request that never responds', async () => {
    receivedEvents = [];

    await page.goto(`http://localhost:${vitePort}`);
    // The fixture route issues a fetch to a route the mock server never
    // answers, aborted by AbortSignal.timeout, then throws.
    await page.click('[data-testid="nav-usercard"]');
    await page.click('[data-testid="edit-profile-btn"]');
    await page.waitForTimeout(2000);

    const event = receivedEvents[0] as Record<string, unknown>;
    const timings = event.network_timings as Array<Record<string, unknown>> | undefined;
    expect(timings).toBeInstanceOf(Array);
    expect(timings?.length).toBeGreaterThanOrEqual(1);
    expect(timings?.[0]).toHaveProperty('transport', 'fetch');
    expect(typeof timings?.[0].duration_ms).toBe('number');
  }, 15_000);
```

If the existing fixture app issues no fetch on that route, add a hanging-fetch trigger to `test-fixtures/vue-app` rather than weakening the assertion — an event with no `network_timings` must fail this test, not pass it vacuously.

- [ ] **Step 6: Confirm the browser test executed rather than skipped**

Run: `pnpm --filter @opslane/sdk test -- browser-contract --reporter=verbose`
Expected: the new test reports as **passed**, not skipped. A skip means Playwright browsers are unavailable (`browser-contract.test.ts:8-16`); install them rather than accepting the skip.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/network.ts packages/sdk/src/__tests__/network.test.ts packages/sdk/src/__tests__/browser-contract.test.ts
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

  it('falls back to network_error when loadend fires with no terminal event', () => {
    const xhr = new (globalThis.XMLHttpRequest as unknown as typeof FakeXHR)();
    xhr.open('GET', 'https://app.example.com/api/items');
    xhr.send();
    xhr.emit('loadend');

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].outcome).toBe('network_error');
  });

  // A successful file:// or extension-scheme XHR reports status 0, which
  // ingestion rejects as out of range.
  it('omits status 0 on load', () => {
    drive('load', 0, false);

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('ok');
    expect(entry).not.toHaveProperty('status');
  });

  it('discards the record and rethrows when send() throws synchronously', () => {
    class ThrowingXHR extends FakeXHR {
      send(): void {
        throw new Error('InvalidStateError');
      }
    }
    vi.stubGlobal('XMLHttpRequest', ThrowingXHR);
    unpatchXHR();
    patchXHR();

    const xhr = new (globalThis.XMLHttpRequest as unknown as typeof ThrowingXHR)();
    xhr.open('GET', 'https://app.example.com/api/items');
    expect(() => xhr.send()).toThrow('InvalidStateError');

    expect(snapshotNetworkTimings()).toHaveLength(0);
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
        this.addEventListener('load', () => {
          // A successful non-HTTP XHR (file://, some extension schemes) reports
          // status 0, which ingestion rejects as outside 100-599. Omit it
          // rather than emitting an entry that will be discarded server-side.
          const storable = this.status >= 100 && this.status <= 599;
          finalize(this.status >= 400 ? 'http_error' : 'ok', storable);
        }, { once: true });
        this.addEventListener('timeout', () => finalize('timeout', false), { once: true });
        this.addEventListener('abort', () => finalize('abort', false), { once: true });
        this.addEventListener('error', () => finalize('network_error', false), { once: true });
        // Fallback only. loadend follows every terminal event above and
        // finalizeTiming is idempotent, so this is a no-op in the normal case.
        // It exists so a request that somehow reaches loadend with no terminal
        // event is still recorded instead of leaking as permanently in-flight.
        this.addEventListener('loadend', () => finalize('network_error', false), { once: true });
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

Append to `packages/sdk/src/__tests__/core.test.ts`. `buildPayload` calls `getConfig()` (`core.ts:71`), which throws when no config is loaded, so this block needs its own `loadConfig` — do not rely on another describe's setup. Add these to the file's existing import block if absent:

```ts
import { loadConfig } from '../config';
import { TEST_PK } from './test-keys';
import { clearNetworkTimings, finalizeTiming, startTiming } from '../network-timing';
```

```ts
describe('network timings on the payload', () => {
  beforeEach(() => {
    clearNetworkTimings();
    loadConfig({ apiKey: TEST_PK, endpoint: 'https://api.test', errorThrottleMs: 0 });
  });

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

  // Request history must not survive reinitialization: it could carry requests
  // captured under one project configuration into an event sent under another.
  it('carries no history across destroy() and re-init()', () => {
    const handle = startTiming('fetch', 'GET', 'https://app.example.com/api/before');
    finalizeTiming(handle, 'ok', 200);

    destroy();
    init({ apiKey: TEST_PK, endpoint: 'https://api.test', errorThrottleMs: 0 });

    const payload = buildPayload('TypeError', 'boom', '', {
      type: 'error', timestamp: new Date().toISOString(), category: 'exception', message: 'boom',
    });
    expect(payload).not.toHaveProperty('network_timings');
  });
});
```

The re-init test needs `import { destroy, init } from '../index';` in the same import block.

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
- Modify: `packages/sdk/src/__tests__/wire-shape.test.ts:21,34-56,121-176`

**Interfaces:**
- Consumes: Task 4's payload attachment
- Produces: frozen fixtures replayed by `wire_compat_test.go` in Task 9

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

Change line 21 to:

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

Append to `packages/ingestion/masking/masking_test.go`. That file is `package masking_test` (an external test package), so every call must be qualified `masking.` and the file must already import `strings` — add it if absent.

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
		{"drops a prefixed token fragment", "https://api.example.com/cb#oauth_access_token=abc", "https://api.example.com/cb"},
		{"keeps a route fragment", "https://app.example.com/x#/dashboard", "https://app.example.com/x#/dashboard"},
		{"leaves a clean URL alone", "https://api.example.com/v1/items", "https://api.example.com/v1/items"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := masking.RedactRequestURL(tc.in); got != tc.want {
				t.Fatalf("RedactRequestURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRedactRequestURLUnparseable(t *testing.T) {
	// Falls back to RedactURL rather than returning the raw value.
	got := masking.RedactRequestURL("://not a url?token=abc")
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
// Deliberately NO \b prefix: `_` is a word character, so `\baccess_token`
// would not match `#oauth_access_token=...`. The SDK's TOKEN_HASH
// (scrub.ts:3) has no boundary either, and server-side redaction must never
// be weaker than the client's.
var tokenFragmentRe = regexp.MustCompile(`(?i)(access_token|id_token|refresh_token|token|code)=`)

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
- Modify: `packages/ingestion/handler/error_event.go:90-145` (payload struct and call site) and near `:304` (the sanitizer, beside `sanitizeDebugMeta`)
- Modify: `packages/ingestion/handler/metrics.go`
- Test: `packages/ingestion/handler/error_event_test.go`

**Interfaces:**
- Consumes: `masking.RedactRequestURL` from Task 6
- Produces: `sanitizeNetworkTimings(raw json.RawMessage) string` returning JSON, defaulting to `"[]"`; `RecordNetworkTimingDiscard(reason string)`

- [ ] **Step 1: Write the failing tests**

`error_event_test.go` is `package handler_test` (external), so it cannot reach the unexported `sanitizeNetworkTimings`. Create a new **internal** test file instead — Go permits `handler` and `handler_test` packages side by side in one directory.

Create `packages/ingestion/handler/network_timings_internal_test.go`:

```go
package handler

import (
	"encoding/json"
	"strings"
	"testing"
)
```

then append:

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
		{"missing duration", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":1,"outcome":"ok"}]`, `[]`},
		{"null started_at", `[{"transport":"fetch","method":"GET","url":"https://a.test/x","started_at_ms":null,"duration_ms":2,"outcome":"ok"}]`, `[]`},
		{"hyphenated method the SDK can emit is accepted", `[{"transport":"xhr","method":"PROPFIND-VERY-LO","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok"}]`, `[{"transport":"xhr","method":"PROPFIND-VERY-LO","url":"https://a.test/x","started_at_ms":1,"duration_ms":2,"outcome":"ok"}]`},
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

In `packages/ingestion/handler/error_event.go`, confirm `bytes`, `encoding/json`, `regexp`, and `strings` are imported and add the `masking` package import if absent, then add near `sanitizeDebugMeta` (`:304`):

```go
const (
	maxNetworkTimings   = 20
	maxTimingURLBytes   = 2048
	maxTimingElapsedMs  = 600000
)

var (
	// Applied after ToUpper. Permits the punctuation real methods and
	// SDK-truncated methods carry (e.g. a clipped `PROPFIND-VERY-LO`); a
	// letters-only rule would reject values the SDK legitimately emits.
	reTimingMethod    = regexp.MustCompile(`^[A-Z0-9._-]{1,16}$`)
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
	// Pointers because both are REQUIRED: a plain int64 makes an absent or
	// null field decode to 0, which then passes the non-negative check.
	StartedAtMs *int64 `json:"started_at_ms"`
	DurationMs  *int64 `json:"duration_ms"`
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
		// An epoch value, so only checked for presence and non-negativity —
		// the elapsed cap does not apply to it.
		if candidate.StartedAtMs == nil || *candidate.StartedAtMs < 0 {
			RecordNetworkTimingDiscard("bad_started_at")
			continue
		}
		if candidate.DurationMs == nil || !validElapsed(*candidate.DurationMs) {
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

Append to `packages/ingestion/db/queries_test.go`. That file is `package db_test`, so types are qualified `db.` and the private `q.pool` is unreachable — query through the `pool` returned by `testPool`. This mirrors `error_group_ingestion_test.go:13-46` exactly; `DefaultEnvironmentID` is required, and omitting it fails environment resolution (`environments.go:46`).

```go
func TestInsertErrorEventStoresNetworkTimings(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "test-network-timings")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	proj, err := q.CreateProject(ctx, org.ID, "proj-network-timings", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	timings := `[{"transport":"fetch","method":"POST","url":"https://api.test/search","started_at_ms":1,"duration_ms":10002,"outcome":"timeout"}]`
	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj.ID,
		DefaultEnvironmentID: env.ID,
		ErrorType:            "TimeoutError",
		ErrorMessage:         "signal timed out",
		Fingerprint:          "fp-network-timings",
		Title:                "TimeoutError: signal timed out",
		NetworkTimings:       timings,
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}

	var stored string
	if err := pool.QueryRow(ctx,
		`SELECT network_timings::text FROM error_events WHERE id = $1`, result.EventID,
	).Scan(&stored); err != nil {
		t.Fatalf("select: %v", err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal([]byte(stored), &decoded); err != nil {
		t.Fatalf("unmarshal stored timings: %v", err)
	}
	if len(decoded) != 1 || decoded[0]["outcome"] != "timeout" {
		t.Fatalf("stored timings unexpected: %s", stored)
	}
}
```

Decoding rather than substring-matching the JSON avoids a false pass on `jsonb`'s whitespace normalization.

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

- [ ] **Step 1: Extend the wire-compat suite to actually cover the new field**

The suite is `TestWireFixtures_AcceptedAndStored` (`wire_compat_test.go:154`) — there is no test matching `-run WireCompat`. More importantly its `wireFixture` struct (`wire_compat_test.go:22`) and its round-trip query (`wire_compat_test.go:172`) both omit `network_timings`, so the handler could discard the field entirely and the suite would still pass.

Add to the `wireFixture` struct:

```go
	NetworkTimings json.RawMessage `json:"network_timings"`
```

Add `network_timings::text` to the round-trip `SELECT` and scan it into a new `networkTimingsText` variable alongside `debugMetaText`. Then assert the round trip, treating an omitted fixture field as the stored default:

```go
			wantTimings := "[]"
			if len(fixture.NetworkTimings) > 0 {
				wantTimings = string(fixture.NetworkTimings)
			}
			var gotTimings, expectTimings []map[string]any
			if err := json.Unmarshal([]byte(networkTimingsText), &gotTimings); err != nil {
				t.Fatalf("stored network_timings is not an array: %v", err)
			}
			if err := json.Unmarshal([]byte(wantTimings), &expectTimings); err != nil {
				t.Fatalf("fixture network_timings is not an array: %v", err)
			}
			if len(gotTimings) != len(expectTimings) {
				t.Errorf("network_timings round trip: got %d entries, want %d", len(gotTimings), len(expectTimings))
			}
```

- [ ] **Step 2: Run the suite under its real name**

Run: `cd packages/ingestion && go test ./handler/ -run TestWireFixtures -v`
Expected: PASS across every fixture including the two new `v4.1.0` files, with the new assertion executing rather than being skipped.

- [ ] **Step 3: Document the field**

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

- [ ] **Step 4: Commit**

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

Run: `cd packages/ingestion && go test ./... -v 2>&1 | grep -c -- "--- SKIP"`
Expected: `0`. The `-v` is load-bearing: without it `go test` suppresses per-test skip lines, so the grep prints `0` while DB tests are calling `t.Skip` (`db/testhelper_test.go:21`). A storage misconfiguration otherwise reports `ok` while roughly 30 tests never run.

- [ ] **Step 4: Bring the stack up and apply migrations**

```bash
docker compose up -d postgres minio
docker compose build ingestion && docker compose up -d ingestion
psql "$DATABASE_URL" -f scripts/seed-e2e.sql
```

- [ ] **Step 5: Post an event carrying timings and assert it stored**

The route reads `X-API-Key` (`handler/project_keys.go:18`), and `project_api_keys` stores only key IDs and hashes — the raw key is not recoverable by query. Use the seeded raw key, which `scripts/seed-e2e.sql:7` records in a comment:

```bash
export OPSLANE_TEST_KEY='opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'

curl -sS -X POST "$INGESTION_URL/api/v1/events" \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $OPSLANE_TEST_KEY" \
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

If this returns 401, the seed did not run or the seeded key rotated — re-run `scripts/seed-e2e.sql` and re-read the raw key from its header comment. Do not disable auth to get a green smoke.

- [ ] **Step 6: Commit any fixes and open the PR**

The PR description must state that this changes no diagnosis behavior and that the column is read by nothing until the worker slice lands, or it will be misread as a fix for the timeout-diagnosis problem.

---

## Self-Review

**Spec coverage.** Wire shape → Task 1. Timing milestones and `ttfb_ms` → Tasks 1–3. Fetch outcome matrix including opaque → Task 2. XHR matrix, finalize-once, sync-throw → Task 3. Retention with active registry and completion ring → Task 1. `destroy()` clearing → Task 4. Field omitted when empty → Tasks 4 and 5. SDK caps → Task 1. Migration and storage → Task 8. Ingestion validation → Task 7. Independent server-side redaction → Tasks 6 and 7. Fixtures and the version-debt note → Task 5. Contract docs → Task 9. Live smoke with zero skips → Task 10.

**Not covered by any task, by design:** the spec's "what this does not deliver" items — worker consumption, backend correlation, fetch body-phase timing, aggregates.

**Type consistency.** `snapshotNetworkTimings`, `startTiming`, `markHeaders`, `finalizeTiming`, `discardTiming`, `clearNetworkTimings` are named identically in Tasks 1–5. `NetworkTiming` field names match between `shared/src/types.ts` (Task 1), the fixtures (Task 5), and `validatedNetworkTiming`'s JSON tags (Task 7).

**SDK and ingestion limits must agree**, or the SDK emits entries ingestion silently drops. Every pair:

| Limit | SDK (Task 1) | Ingestion (Task 7) |
| --- | --- | --- |
| Entry count | `MAX_ENTRIES = 20` | `maxNetworkTimings = 20` |
| URL length | `capBytes(..., 2048)`, UTF-8 bytes | `len(value) > 2048`, UTF-8 bytes |
| Method | `toUpperCase()` then 16 bytes | `ToUpper` then `^[A-Z0-9._-]{1,16}$` |
| Elapsed | clamped to `MAX_ELAPSED_MS = 600000` | dropped above `600000` |
| Status | omitted unless 100–599 | rejected outside 100–599 |

**Go test packages.** `error_event_test.go`, `queries_test.go`, and `masking_test.go` are all external (`*_test` packages). Task 7's sanitizer tests therefore go in a new internal file; Tasks 6 and 8 qualify every call and type with its package name.
