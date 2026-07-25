import { pollSessionOnce, type PollResult } from '../agent-protocol.js';

export interface WaitOptions {
  apiUrl: string;
  sessionId: string;
  pollToken: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxUnreachable?: number;
  requestTimeoutMs?: number;
  nowFn?: () => number;
  signal?: AbortSignal;
}

const WAITING = new Set(['pending', 'provisioned', 'key_ok']);

// Per-request ceiling. Without it a connection the server accepts and then
// never answers would burn the whole wait budget on one poll, so the
// unreachable backoff below would never get a turn.
const REQUEST_TIMEOUT_MS = 30_000;

export async function waitForAppReporting(options: WaitOptions): Promise<PollResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn;
  const now = options.nowFn ?? Date.now;
  const interval = options.pollIntervalMs ?? 3_000;
  const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
  const maxUnreachable = options.maxUnreachable ?? 20;
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const callerSignal = options.signal;
  const abortError = (): Error =>
    new Error(`waiting for session ${options.sessionId} was aborted`);
  const throwIfAborted = (): void => {
    if (callerSignal?.aborted === true) throw abortError();
  };
  let unreachable = 0;

  async function pause(ms: number): Promise<void> {
    const remaining = deadline - now();
    if (remaining <= 0) return;
    throwIfAborted();

    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(abortError());
        callerSignal?.addEventListener('abort', onAbort, { once: true });
        const delay = Math.min(ms, remaining);
        const sleeping = sleepFn === undefined
          ? new Promise<void>((resolveSleep) => {
              timer = setTimeout(resolveSleep, delay);
              if (typeof timer.unref === 'function') timer.unref();
            })
          : sleepFn(delay);
        void sleeping.then(resolve, reject);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) callerSignal?.removeEventListener('abort', onAbort);
    }
  }

  throwIfAborted();
  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    throwIfAborted();
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(remaining, requestTimeout),
    );
    const result = await pollSessionOnce({
      apiUrl: options.apiUrl,
      sessionId: options.sessionId,
      pollToken: options.pollToken,
      fetchFn,
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    });
    throwIfAborted();

    if (result.status === 'app_reporting' || result.status === 'completed') return result;
    if (result.status === 'failed') {
      throw new Error(
        `onboarding session failed: ${result.failureReason ?? result.message ?? 'unknown'}`,
      );
    }
    if (result.status === 'expired') {
      throw new Error(
        `session ${options.sessionId} expired — re-run onboarding to mint a new key`,
      );
    }
    if (result.status === 'not_found') {
      throw new Error(`session ${options.sessionId} was not found — re-run onboarding`);
    }
    if (result.status === 'internal_error' || result.status === 'unknown') {
      throw new Error(
        `server error while waiting: ${'message' in result ? result.message ?? 'unknown' : 'unknown'}`,
      );
    }
    if (result.status === 'unreachable') {
      unreachable += 1;
      if (unreachable >= maxUnreachable) {
        throw new Error(
          `API unreachable after ${unreachable} attempts while waiting for session ${options.sessionId}`,
        );
      }
      await pause(Math.min(interval * unreachable, 30_000));
      continue;
    }
    unreachable = 0;
    if (result.status === 'rate_limited') {
      await pause((result.retryAfterSeconds ?? 60) * 1_000);
      continue;
    }
    if (WAITING.has(result.status)) {
      await pause(interval);
      continue;
    }
  }
  throw new Error(
    `timed out waiting for your app to report (session ${options.sessionId}). `
      + 'Start your app, then re-run onboarding — it will resume this session.',
  );
}
