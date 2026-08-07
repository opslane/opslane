import type { NetworkTiming } from '@opslane/shared';
import { scrubUrl } from './scrub';

/** Shared with ingestion's sanitizer; both must agree or events get rejected upstream. */
const MAX_ENTRIES = 20;
const MAX_URL_BYTES = 2048;
const MAX_METHOD_BYTES = 16;
const MAX_ELAPSED_MS = 600000;

/** Returned by startTiming when the active registry is full. All other exports no-op on it. */
const UNTRACKED = -1;

/** RFC 7230 token, the same set ingestion accepts. Kept in sync deliberately. */
const TOKEN = /^[A-Z0-9!#$%&'*+.^_`|~-]{1,16}$/;

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

/** Monotonic where supported, avoiding wall-clock jumps in elapsed values. */
function mark(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Truncate to at most `maxBytes` UTF-8 bytes. */
function capBytes(value: string, maxBytes: number): string {
  if (!encoder || !decoder) return value.slice(0, Math.floor(maxBytes / 3));
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/, '');
}

/** Clamped because ingestion drops elapsed values above the shared ceiling. */
function elapsed(from: number, to: number): number {
  return Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(to - from)));
}

export function startTiming(transport: Transport, method: string, url: string): number {
  const scrubbed = capBytes(scrubUrl(url), MAX_URL_BYTES);
  if (!scrubbed) return UNTRACKED;

  const safeMethod = capBytes(method.toUpperCase(), MAX_METHOD_BYTES);
  if (!TOKEN.test(safeMethod)) return UNTRACKED;
  if (active.size >= MAX_ENTRIES) return UNTRACKED;

  const handle = nextHandle;
  nextHandle += 1;
  active.set(handle, {
    transport,
    method: safeMethod,
    url: scrubbed,
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

/** Moves a record from active to completed; subsequent finalization is a no-op. */
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

/** Drops a record entirely, such as when XHR.send throws synchronously. */
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
  // Handles are never reused: callbacks from pre-destroy requests can fire late.
}
