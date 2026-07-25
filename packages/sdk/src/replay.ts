import { EventType, type eventWithTime } from '@rrweb/types';
import { _resetChunkUploadState, flushInline, uploadChunk } from './chunk-upload';
import { getConfig } from './config';
import { getCurrentUser, onIdentityChange } from './core';
import { gzipSupported } from './gzip';
import { sdkFetch } from './network';
import { ensureSessionID, nextChunkSeq, resetSessionId, rotateSessionIfIdle, touchSession, type SessionProgress } from './session.js';
import { scrubUrl } from './scrub';
import { setTelemetrySink } from './telemetry';
import { SDK_VERSION } from './version';

export type ReplayTriggerType = 'uncaught_error' | 'capture_exception';

const CHUNK_MS = 30_000;
const MAX_CHUNK_RAW_BYTES = 20 * 1024 * 1024;

let buffer: eventWithTime[] = [];
let bufferBytes = 0;
let currentSessionID = '';
let currentSeq = -1;
let replayInstalled = false;
let stopFn: (() => void) | null = null;
let takeFullSnapshotFn: ((isCheckout?: boolean) => void) | null = null;
let startGeneration = 0;
let rotationGeneration = 0;
let streamReady = false;
let awaitingRotationSnapshot = false;
let pendingMeta: eventWithTime | null = null;
let errorFlushInFlight = false;
const sessionRegistrations = new Map<string, Promise<boolean>>();

function approxEventBytes(event: eventWithTime): number {
  try {
    return utf8ByteLength(JSON.stringify(event));
  } catch {
    return 0;
  }
}

/** A checkout begins a self-contained chunk with a fresh full snapshot. */
function onEmit(event: eventWithTime, isCheckout?: boolean): void {
  try {
    const idleRotation = rotateSessionIfIdle();
    if (idleRotation) {
      beginSessionRotation(idleRotation.newSessionID, idleRotation.previous);
      return;
    }

    if (!streamReady) {
      if (event.type === EventType.Meta) {
        pendingMeta = event;
        return;
      }
      if (event.type === EventType.FullSnapshot && awaitingRotationSnapshot) {
        buffer = pendingMeta ? [pendingMeta, event] : [event];
        bufferBytes = buffer.reduce((total, bufferedEvent) => total + approxEventBytes(bufferedEvent), 0);
        pendingMeta = null;
        awaitingRotationSnapshot = false;
        streamReady = true;
      }
      return;
    }
    // rrweb emits checkout metadata immediately before the checkout's full
    // snapshot, and marks both events isCheckout=true. Hold that metadata so
    // the next independently playable chunk opens with [Meta, FullSnapshot].
    if (isCheckout && event.type === EventType.Meta) {
      pendingMeta = event;
      return;
    }
    if (isCheckout && event.type !== EventType.FullSnapshot) return;
    if (isCheckout && buffer.length > 0) {
      const chunk = buffer;
      const seq = currentSeq >= 0 ? currentSeq : nextChunkSeq();
      const sessionID = currentSessionID;
      buffer = pendingMeta ? [pendingMeta, event] : [event];
      bufferBytes = buffer.reduce((total, bufferedEvent) => total + approxEventBytes(bufferedEvent), 0);
      pendingMeta = null;
      currentSeq = -1;
      if (seq >= 0 && sessionID) void shipChunk(sessionID, seq, chunk);
      return;
    }

    if (isCheckout) {
      buffer = pendingMeta ? [pendingMeta, event] : [event];
      bufferBytes = buffer.reduce((total, bufferedEvent) => total + approxEventBytes(bufferedEvent), 0);
      pendingMeta = null;
      return;
    }

    buffer.push(event);
    bufferBytes += approxEventBytes(event);
    touchSession();
    if (bufferBytes > MAX_CHUNK_RAW_BYTES) {
      try {
        takeFullSnapshotFn?.(true);
      } catch {
        // rrweb is best-effort.
      }
    }
  } catch {
    // SDK must never throw.
  }
}

/**
 * Ship the in-flight recording as a normal session chunk as soon as an error
 * is accepted. This closes the early-session gap without creating a second
 * replay object; capture resumes from a fresh Meta + FullSnapshot boundary.
 */
export function flushReplayBufferForError(): void {
  if (!replayInstalled || !streamReady || buffer.length === 0 || errorFlushInFlight) return;

  errorFlushInFlight = true;
  const chunk = buffer;
  const seq = currentSeq >= 0 ? currentSeq : nextChunkSeq();
  const sessionID = currentSessionID;
  buffer = [];
  bufferBytes = 0;
  currentSeq = -1;
  pendingMeta = null;

  if (seq >= 0 && sessionID) void shipChunk(sessionID, seq, chunk);
  try {
    takeFullSnapshotFn?.(true);
  } catch {
    // rrweb is best-effort.
  }

  // Keep the guard through this turn. rrweb may synchronously refill the
  // buffer while takeFullSnapshot runs; a second accepted error in the same
  // turn must not immediately ship that snapshot-only replacement chunk.
  void Promise.resolve().then(() => {
    errorFlushInFlight = false;
  });
}

async function shipChunk(sessionID: string, seq: number, events: eventWithTime[]): Promise<void> {
  const result = await uploadChunk(sessionID, seq, events, true);
  if (result === 'stop') stopReplayCapture();
}

async function sendSessionRegistration(sessionID: string): Promise<boolean> {
  try {
    const config = getConfig();
    if (!config.reportingEnabled) return false;
    const user = getCurrentUser();
    const response = await sdkFetch(`${config.endpoint}/api/v1/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
      body: JSON.stringify({
        session_id: sessionID,
        started_at: new Date().toISOString(),
        page_url: currentPageUrl(),
        sdk: { name: '@opslane/sdk', version: SDK_VERSION },
        release: config.release || undefined,
        environment: config.environment || undefined,
        user: user ? {
          id: user.id,
          email: user.email,
          account_id: user.account?.id,
          account_name: user.account?.name,
        } : null,
      }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { recording?: boolean };
    if (body.recording !== true) return false;
    return true;
  } catch {
    return false;
  }
}

export function registerSession(sessionID = ensureSessionID()): Promise<boolean> {
  const pending = sessionRegistrations.get(sessionID);
  if (pending) return pending;

  const registration = sendSessionRegistration(sessionID);
  sessionRegistrations.set(sessionID, registration);
  void registration.then(() => {
    if (sessionRegistrations.get(sessionID) === registration) {
      sessionRegistrations.delete(sessionID);
    }
  });
  return registration;
}

export function resetSessionRegistrations(): void {
  sessionRegistrations.clear();
}

// Identity can change while the init request is in flight. Register the latest
// durable id before rrweb starts so capture never opens under a retired id.
async function registerStableSession(generation: number): Promise<string | null> {
  let sessionID = ensureSessionID();
  while (generation === startGeneration && replayInstalled) {
    if (!(await registerSession(sessionID))) return null;
    const latestSessionID = ensureSessionID();
    if (latestSessionID === sessionID) return sessionID;
    sessionID = latestSessionID;
  }
  return null;
}

export async function startReplayCapture(): Promise<void> {
  if (replayInstalled) return;
  try {
    if (!getConfig().replayEnabled) return;
  } catch {
    return;
  }
  if (typeof window === 'undefined' || typeof document === 'undefined' || !gzipSupported()) return;

  replayInstalled = true;
  const generation = ++startGeneration;
  const initialSessionID = await registerStableSession(generation);
  if (!initialSessionID || generation !== startGeneration || !replayInstalled) {
    if (generation === startGeneration) replayInstalled = false;
    return;
  }
  currentSessionID = initialSessionID;
  streamReady = false;
  awaitingRotationSnapshot = true;
  _resetChunkUploadState();
  onIdentityChange(handleIdentityChange);

  try {
    const { record, addCustomEvent, takeFullSnapshot } = await import('rrweb');
    setTelemetrySink((event) => {
      try {
        addCustomEvent('opslane.telemetry', event);
      } catch {
        // rrweb may not have started yet.
      }
    });
    takeFullSnapshotFn = takeFullSnapshot;
    const stop = record({
      emit: onEmit,
      checkoutEveryNms: CHUNK_MS,
      maskAllInputs: true,
      maskTextSelector: '.opslane-mask',
      blockSelector: '.opslane-block',
      recordCanvas: false,
    });

    if (!replayInstalled || generation !== startGeneration) {
      if (typeof stop === 'function') stop();
      return;
    }
    stopFn = typeof stop === 'function' ? stop : null;
    if (!stopFn) {
      stopReplayCapture();
      return;
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
  } catch {
    stopReplayCapture();
  }
}

function handleIdentityChange(newSessionID: string, previous: SessionProgress): void {
  beginSessionRotation(newSessionID, previous);
}

function beginSessionRotation(newSessionID: string, previous: SessionProgress): void {
  const generation = ++rotationGeneration;
  const pending = buffer;
  const pendingSeq = pending.length > 0
    ? (currentSeq >= 0 ? currentSeq : previous.nextSeq)
    : -1;
  const oldSessionID = previous.id || currentSessionID;

  buffer = [];
  bufferBytes = 0;
  currentSeq = -1;
  currentSessionID = newSessionID;
  streamReady = false;
  awaitingRotationSnapshot = false;
  pendingMeta = null;

  if (pending.length > 0 && pendingSeq >= 0 && oldSessionID) {
    void shipChunk(oldSessionID, pendingSeq, pending);
  }

  void (async () => {
    if (!(await registerSession(newSessionID))) {
      if (generation !== rotationGeneration) return;
      stopReplayCapture();
      return;
    }
    if (generation !== rotationGeneration || !replayInstalled) return;
    currentSessionID = newSessionID;
    awaitingRotationSnapshot = true;
    try {
      takeFullSnapshotFn?.(true);
    } catch {
      // best-effort
    }
  })();
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'hidden' || buffer.length === 0) return;
  if (currentSeq < 0) currentSeq = nextChunkSeq();
  const tail = buffer;
  const tailSeq = currentSeq;
  const tailSessionID = currentSessionID;
  buffer = [];
  bufferBytes = 0;
  currentSeq = -1;
  void flushInline(tailSessionID, tailSeq, tail).then((result) => {
    // All three states are load-bearing: 'stop' means recording was disabled
    // or the session disappeared, false means keepalive could not carry the
    // tail, and true means the chunk landed.
    if (result === 'stop') {
      stopReplayCapture();
      return;
    }
    if (!result) void shipChunk(tailSessionID, tailSeq, tail);
  });
  // If the page survives backgrounding, resume from a new full snapshot. This
  // also prevents the regular uploader from reusing the inline tail's seq.
  try {
    takeFullSnapshotFn?.(true);
  } catch {
    // The page may already be tearing down.
  }
}

export function stopReplayCapture(): void {
  startGeneration += 1;
  rotationGeneration += 1;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  onIdentityChange(null);
  setTelemetrySink(null);
  takeFullSnapshotFn = null;
  buffer = [];
  bufferBytes = 0;
  currentSeq = -1;
  currentSessionID = '';
  streamReady = false;
  awaitingRotationSnapshot = false;
  pendingMeta = null;
  errorFlushInFlight = false;
  replayInstalled = false;

  const stop = stopFn;
  stopFn = null;
  if (stop) {
    try {
      stop();
    } catch {
      // replay is best-effort.
    }
  }
}

/** Test-only: true once rrweb record() is active and the telemetry sink is
 * installed — i.e. clicks from this point on land in replay chunks. */
export function _replayStarted(): boolean {
  return replayInstalled && stopFn !== null && streamReady;
}

function currentPageUrl(): string {
  try {
    return typeof window !== 'undefined' ? scrubUrl(window.location.href) : '';
  } catch {
    return '';
  }
}

function utf8ByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return value.length;
  }
}

export function _resetReplayState(): void {
  stopReplayCapture();
  resetSessionRegistrations();
  startGeneration = 0;
  resetSessionId();
}
