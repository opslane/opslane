import { describe, expect, it, vi } from 'vitest';
import { waitForAppReporting } from '../wait.js';

const SESSION = '123e4567-e89b-42d3-a456-426614174000';
const OPTS = {
  apiUrl: 'http://localhost:8082',
  sessionId: SESSION,
  pollToken: 'ptok',
  timeoutMs: 60_000,
  sleepFn: vi.fn().mockResolvedValue(undefined),
};

function seq(...entries: Array<{ status: number; body: unknown }>) {
  const fetchFn = vi.fn();
  for (const entry of entries) {
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify(entry.body), {
      status: entry.status,
    }));
  }
  return fetchFn;
}

describe('waitForAppReporting', () => {
  it('waits through provisioned and key_ok until app_reporting', async () => {
    const fetchFn = seq(
      { status: 200, body: { status: 'provisioned', api_key: 'k' } },
      { status: 200, body: { status: 'key_ok', api_key: 'k' } },
      { status: 200, body: { status: 'app_reporting' } },
    );
    await expect(waitForAppReporting({ ...OPTS, fetchFn }))
      .resolves.toMatchObject({ status: 'app_reporting' });
  });

  it('accepts completed as terminal success', async () => {
    const fetchFn = seq({ status: 200, body: { status: 'completed' } });
    await expect(waitForAppReporting({ ...OPTS, fetchFn }))
      .resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects a failed session once with its reason', async () => {
    const fetchFn = seq({
      status: 200,
      body: { status: 'failed', failure_reason: 'github_error' },
    });
    await expect(waitForAppReporting({ ...OPTS, fetchFn })).rejects.toThrow(/github_error/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [410, { status: 'expired' }, 'expired'],
    [404, { status: 'not_found' }, 'not found'],
  ])('rejects HTTP %s with remediation', async (status, body, message) => {
    const fetchFn = seq({ status, body });
    await expect(waitForAppReporting({ ...OPTS, fetchFn })).rejects.toThrow(message);
  });

  it('honors rate-limit retry_after before polling again', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fetchFn = seq(
      { status: 429, body: { status: 'rate_limited', retry_after: 9 } },
      { status: 200, body: { status: 'app_reporting' } },
    );
    await expect(waitForAppReporting({ ...OPTS, fetchFn, sleepFn })).resolves.toBeDefined();
    expect(sleepFn).toHaveBeenCalledWith(9_000);
  });

  it('caps Retry-After sleep to the remaining timeout', async () => {
    let current = 0;
    const nowFn = () => current;
    const sleepFn = vi.fn(async (ms: number) => { current += ms; });
    const fetchFn = seq({
      status: 429,
      body: { status: 'rate_limited', retry_after: 3_600 },
    });
    await expect(waitForAppReporting({
      ...OPTS,
      timeoutMs: 1_000,
      fetchFn,
      sleepFn,
      nowFn,
    })).rejects.toThrow(/timed out/);
    expect(sleepFn).toHaveBeenCalledWith(1_000);
  });

  it('aborts a stalled poll on its own ceiling so retries still run', async () => {
    let aborted = 0;
    // A server that accepts the connection and never answers. Without a
    // per-request ceiling this single call would consume the whole 15 minute
    // budget and the unreachable backoff below would never get a turn.
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted += 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
    ));

    await expect(waitForAppReporting({
      ...OPTS,
      timeoutMs: 15 * 60_000,
      requestTimeoutMs: 20,
      maxUnreachable: 2,
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow(/unreachable/i);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(aborted).toBe(2);
  });

  it('never lets the per-request ceiling outlive the remaining budget', async () => {
    let deadlineMs = 0;
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { deadlineMs = Date.now(); });
      return Promise.resolve(new Response(JSON.stringify({ status: 'app_reporting' })));
    });

    // A 5ms budget must win over the 30s default ceiling.
    const started = Date.now();
    await expect(waitForAppReporting({
      ...OPTS,
      timeoutMs: 5,
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: 'app_reporting' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(deadlineMs).toBe(0);
  });

  it('bounds unreachable retries', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(waitForAppReporting({ ...OPTS, fetchFn, maxUnreachable: 3 }))
      .rejects.toThrow(/unreachable/i);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const fetchFn = vi.fn();

    await expect(
      waitForAppReporting({ ...OPTS, fetchFn, signal: AbortSignal.abort() }),
    ).rejects.toThrow(/aborted/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('stops on abort without sleeping through the backoff', async () => {
    const controller = new AbortController();
    const sleepFn = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    await expect(
      waitForAppReporting({
        ...OPTS,
        fetchFn,
        sleepFn,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('interrupts an active default pause and clears its timer', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchFn = seq({ status: 200, body: { status: 'pending' } });
      const pending = waitForAppReporting({
        ...OPTS,
        fetchFn,
        sleepFn: undefined,
        pollIntervalMs: 30_000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      controller.abort();

      await expect(pending).rejects.toThrow(/aborted/i);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not accumulate abort listeners across poll turns', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let polls = 0;
    const fetchFn = vi.fn(async () => {
      polls += 1;
      if (polls > 30) {
        return new Response(JSON.stringify({ status: 'app_reporting' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
    });

    await waitForAppReporting({
      ...OPTS,
      fetchFn,
      sleepFn: async () => undefined,
      signal: controller.signal,
    });

    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
  });

  it('times out with the session id in its message', async () => {
    const nowFn = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(61_000);
    const fetchFn = seq({ status: 200, body: { status: 'pending' } });
    await expect(waitForAppReporting({ ...OPTS, fetchFn, nowFn }))
      .rejects.toThrow(SESSION);
  });
});
