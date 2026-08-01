import type { ErrorEventPayload } from '@opslane/shared';
import { getConfig } from './config';
import { buildUserContext, getCurrentUser } from './core';
import type { ReplayTriggerType } from './replay';
import { flushReplayBufferForError } from './replay';
import { scrubEvent } from './scrub';
import { shouldThrottle } from './throttle';
import { assembleDebugMeta } from './debug-images.js';

const MAX_QUEUE_SIZE = 100;

export type IngestPayload = ErrorEventPayload;

interface QueuedEvent {
  payload: IngestPayload;
  replayTrigger?: ReplayTriggerType;
}

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

// Capped exponential backoff with jitter. The MAX cap acts as the circuit-breaker:
// when ingest is down we never retry faster than once per MAX_BACKOFF_MS.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
let consecutiveFailures = 0;
let nextAttemptAt = 0;

function openBackoff(): void {
  consecutiveFailures += 1;
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);
  const jitter = Math.random() * exp * 0.5; // up to +50%
  nextAttemptAt = Date.now() + exp + jitter;
}

function resetBackoff(): void {
  consecutiveFailures = 0;
  nextAttemptAt = 0;
}

// The keepalive fetch quota is ~64KB, shared across all in-flight keepalive
// requests for the document. Bound the cumulative unload payload below that.
const KEEPALIVE_BUDGET_BYTES = 60 * 1024;

let unloadFlushHandler: (() => void) | null = null;
let visibilityFlushHandler: (() => void) | null = null;

export function enqueueEvent(event: IngestPayload, replayTrigger?: ReplayTriggerType): void {
  try {
    const config = getConfig();

    // Sampling: probabilistically drop before any other work.
    if (config.sampleRate < 1 && Math.random() >= config.sampleRate) return;

    // Throttle identical errors (collapse storms from a single error in a loop).
    if (shouldThrottle(event.error.type, event.error.message, event.error.stack, config.errorThrottleMs, Date.now())) {
      return;
    }

    // Defense-in-depth: scrub PII before the customer hook and before queueing.
    const scrubbed: IngestPayload = scrubEvent(event);
    const debugMeta = assembleDebugMeta(scrubbed.error.stack);
    const instrumented = debugMeta
      ? { ...scrubbed, debug_meta: debugMeta }
      : scrubbed;
    let processed: IngestPayload | null = instrumented;

    if (config.beforeSend) {
      try {
        processed = config.beforeSend(instrumented);
      } catch {
        // A throwing beforeSend must not drop the event silently nor crash the SDK;
        // fall back to the already-scrubbed copy (a throwing hook can't have mutated it).
        processed = instrumented;
      }
    }
    if (!processed) return; // beforeSend returned null → drop

    queue.push({ payload: processed, replayTrigger });

    // Drop oldest if we exceed max queue size
    if (queue.length > MAX_QUEUE_SIZE) {
      queue = queue.slice(queue.length - MAX_QUEUE_SIZE);
    }

    // Auto-flush if we hit batch size
    if (queue.length >= config.maxBatchSize) {
      void flushEvents();
    }
  } catch {
    // SDK must never throw
  }
}

export async function flushEvents(): Promise<void> {
  if (flushing || queue.length === 0) return;
  if (Date.now() < nextAttemptAt) return; // backoff gate
  flushing = true;

  const batch = queue.splice(0, queue.length);
  const failed: QueuedEvent[] = [];

  try {
    const config = getConfig();
    // Ingestion API accepts a single event per request
    for (const queued of batch) {
      try {
        const event = queued.payload;

        // Late-bind user context: if the event was captured before setUser()
        // but the user is now known, attach it before sending.
        // Called per-event: user identity may change between awaits.
        // On retry, events already stamped keep their first-touch user.
        const user = getCurrentUser();
        if (user) {
          if (!event.context) {
            event.context = { user: buildUserContext(user) };
          } else if (!event.context.user) {
            event.context.user = buildUserContext(user);
          }
        }

        const response = await fetch(`${config.endpoint}/api/v1/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': config.apiKey,
          },
          body: JSON.stringify(event),
        });

        if (!response.ok) {
          failed.push(queued);
          continue;
        }

        if (queued.replayTrigger && config.replayEnabled && 'error' in event) {
          flushReplayBufferForError();
        }
      } catch {
        failed.push(queued);
      }
    }
  } catch {
    // Config error -- put all back
    failed.push(...batch);
  } finally {
    if (failed.length > 0) {
      queue.unshift(...failed);
      if (queue.length > MAX_QUEUE_SIZE) {
        queue = queue.slice(queue.length - MAX_QUEUE_SIZE);
      }
      openBackoff();
    } else {
      resetBackoff();
    }
    flushing = false;
  }
}

/**
 * Best-effort flush for page unload (pagehide) AND backgrounding
 * (visibilitychange→hidden).
 *
 * Differs from flushEvents() in ways that matter at teardown:
 *  - uses keepalive so the requests survive the page going away (sendBeacon can't
 *    set the X-API-Key header, so keepalive fetch is the only option). This also
 *    covers mobile, where the page is often terminated after visibilitychange
 *    without a reliable pagehide/unload;
 *  - fires all requests without awaiting sequentially — the page may freeze after
 *    the first await, so a serial loop would only send the first event;
 *  - bounds the CUMULATIVE body size against the shared keepalive budget.
 *
 * It is NON-DESTRUCTIVE so it is safe to call on visibilitychange→hidden, which
 * fires on ordinary tab-switches the page later resumes from:
 *  - only events that fit the keepalive budget are removed from the queue; the
 *    rest stay queued for the next normal flush;
 *  - a send that fails (e.g. transient offline while backgrounded) is requeued so
 *    the resumed page retries it. (Harmless if the page truly unloads — the queue
 *    is garbage-collected.)
 *
 * It deliberately ignores the `flushing` guard: a normal flush mid-flight must not
 * cause the unload flush to silently drop the remaining queued events.
 */
export function flushOnUnload(): void {
  try {
    if (queue.length === 0) return;
    const config = getConfig();
    const encoder = new TextEncoder();

    // Take only the leading events that fit the shared keepalive budget; leave
    // the rest queued (a resumed page flushes them on the next interval).
    const toSend: { queued: QueuedEvent; body: string }[] = [];
    let usedBytes = 0;
    for (const queued of queue) {
      const event = queued.payload;

      // Late-bind user context, same as flushEvents.
      const user = getCurrentUser();
      if (user) {
        if (!event.context) {
          event.context = { user: buildUserContext(user) };
        } else if (!event.context.user) {
          event.context.user = buildUserContext(user);
        }
      }

      const body = JSON.stringify(event);
      const bytes = encoder.encode(body).byteLength;
      // Always send at least one event; stop once the budget would be exceeded.
      if (toSend.length > 0 && usedBytes + bytes > KEEPALIVE_BUDGET_BYTES) break;
      usedBytes += bytes;
      toSend.push({ queued, body });
    }

    // Remove exactly the events we're about to send from the front of the queue.
    queue.splice(0, toSend.length);

    for (const { queued, body } of toSend) {
      // Fire-and-forget: do NOT await (the page may freeze mid-loop).
      void fetch(`${config.endpoint}/api/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
        },
        body,
        keepalive: true,
      }).catch(() => {
        // Send failed but the page may still be alive (backgrounded tab). Requeue
        // so the next normal flush retries; harmless if the page truly unloads.
        queue.unshift(queued);
        if (queue.length > MAX_QUEUE_SIZE) {
          queue = queue.slice(queue.length - MAX_QUEUE_SIZE);
        }
      });
    }
  } catch {
    // SDK must never throw
  }
}

export function startTransport(): void {
  if (flushTimer) return;

  try {
    const config = getConfig();
    flushTimer = setInterval(() => {
      void flushEvents();
    }, config.flushInterval);

    // Flush queued events before the page goes away so they aren't lost to an
    // aborted in-flight request on navigation.
    if (typeof window !== 'undefined' && !unloadFlushHandler) {
      unloadFlushHandler = () => flushOnUnload();
      window.addEventListener('pagehide', unloadFlushHandler);

      if (typeof document !== 'undefined') {
        visibilityFlushHandler = () => {
          if (document.visibilityState === 'hidden') {
            flushOnUnload();
          }
        };
        document.addEventListener('visibilitychange', visibilityFlushHandler);
      }
    }
  } catch {
    // SDK must never throw
  }
}

export function stopTransport(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (typeof window !== 'undefined' && unloadFlushHandler) {
    window.removeEventListener('pagehide', unloadFlushHandler);
    unloadFlushHandler = null;
  }
  if (typeof document !== 'undefined' && visibilityFlushHandler) {
    document.removeEventListener('visibilitychange', visibilityFlushHandler);
    visibilityFlushHandler = null;
  }
}

export function getQueueLength(): number {
  return queue.length;
}

export function _resetQueue(): void {
  queue = [];
  flushing = false;
  resetBackoff();
}
