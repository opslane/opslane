import type { Server } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const servers = vi.hoisted(() => [] as Server[]);
const launch = vi.hoisted(() => vi.fn());

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: ((...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      servers.push(server);
      return server;
    }) as typeof actual.createServer,
  };
});
vi.mock('playwright-core', () => ({ chromium: { launch } }));

const { captureFrames, isReplayCrash, ReplayCrashedError, replayEventBatches } = await import('../frames/capture.js');

describe('replayEventBatches', () => {
  const events = [
    { type: 4, data: { href: 'https://app.example.com' }, timestamp: 1 },
    { type: 2, data: { node: { text: 'x'.repeat(40) } }, timestamp: 2 },
    { type: 3, data: { source: 2 }, timestamp: 3 },
    { type: 3, data: { source: 2 }, timestamp: 4 },
  ];

  it('keeps every event, in order, across batches', () => {
    const batches = [...replayEventBatches(events, 60)];
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => JSON.parse(batch) as unknown[])).toEqual(events);
  });

  it('bounds each batch, sending an event larger than the bound on its own', () => {
    const batches = [...replayEventBatches(events, 60)];
    for (const batch of batches) {
      const parsed = JSON.parse(batch) as unknown[];
      if (parsed.length > 1) expect(batch.length).toBeLessThanOrEqual(60);
    }
    expect(batches.some((batch) => (JSON.parse(batch) as unknown[]).length === 1 && batch.length > 60)).toBe(true);
  });

  it('sends a small recording as one batch and nothing for no events', () => {
    expect([...replayEventBatches(events)]).toEqual([JSON.stringify(events)]);
    expect([...replayEventBatches([])]).toEqual([]);
  });
});

function fakeBrowser(evaluate: (arg: unknown) => Promise<unknown>) {
  const handlers = new Map<string, () => void>();
  const page = {
    route: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); }),
    evaluate: vi.fn(async (_fn: unknown, arg: unknown) => evaluate(arg)),
    waitForTimeout: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('png')),
  };
  const browserHandlers = new Map<string, () => void>();
  const browser = {
    on: vi.fn((event: string, handler: () => void) => { browserHandlers.set(event, handler); }),
    newPage: vi.fn(async () => page),
    // Closing a real browser also emits 'disconnected'.
    close: vi.fn(async () => { browserHandlers.get('disconnected')?.(); }),
  };
  return {
    browser,
    crash: () => handlers.get('crash')?.(),
    disconnect: () => browserHandlers.get('disconnected')?.(),
  };
}
/** seekTo receives a number, appendReplayEvents a JSON string batch, modelCopyOf an
 * object with a box; initReplayer takes no argument. */
const isSeek = (arg: unknown) => typeof arg === 'number';
const isResize = (arg: unknown) =>
  typeof arg === 'object' && arg !== null && !Array.isArray(arg) && 'box' in arg;

describe('captureFrames lifecycle', () => {
  beforeEach(() => { servers.length = 0; launch.mockReset(); });

  it('closes the loopback server when Chromium fails to launch', async () => {
    launch.mockRejectedValue(new Error('launch failed'));
    await expect(captureFrames([], [0])).rejects.toThrow('launch failed');
    expect(servers).toHaveLength(1);
    expect(servers[0]!.listening).toBe(false);
  });

  it('reports a crash event as ReplayCrashedError even when the thrown message does not say so', async () => {
    const fake = fakeBrowser(async (arg) => {
      if (isSeek(arg)) { fake.crash(); throw new Error('page.evaluate: Execution context was destroyed'); }
      return true;
    });
    launch.mockResolvedValue(fake.browser);
    await expect(captureFrames([], [0])).rejects.toBeInstanceOf(ReplayCrashedError);
    expect(fake.browser.close).toHaveBeenCalledOnce();
    expect(servers[0]!.listening).toBe(false);
  });

  it('reports a crash message as ReplayCrashedError without a crash event', async () => {
    const fake = fakeBrowser(async (arg) => {
      if (isSeek(arg)) throw new Error('page.evaluate: Target crashed');
      return true;
    });
    launch.mockResolvedValue(fake.browser);
    await expect(captureFrames([], [0])).rejects.toBeInstanceOf(ReplayCrashedError);
  });

  it('reports an unexpected browser disconnect as ReplayCrashedError', async () => {
    const fake = fakeBrowser(async (arg) => {
      if (isSeek(arg)) { fake.disconnect(); throw new Error('page.evaluate: Target page, context or browser has been closed'); }
      return true;
    });
    launch.mockResolvedValue(fake.browser);
    await expect(captureFrames([], [0])).rejects.toBeInstanceOf(ReplayCrashedError);
  });

  it('closes the server even when closing the browser throws, and leaves other failures unclassified', async () => {
    const fake = fakeBrowser(async (arg) => {
      if (isSeek(arg)) throw new Error('seek failed');
      return true;
    });
    fake.browser.close.mockRejectedValue(new Error('close failed'));
    launch.mockResolvedValue(fake.browser);
    const error = await captureFrames([], [0]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ReplayCrashedError);
    expect((error as Error).message).toBe('seek failed');
    expect(servers[0]!.listening).toBe(false);
  });

  it('keeps frames already captured when the renderer crashes during the last resize', async () => {
    let resizes = 0;
    const fake = fakeBrowser(async (arg) => {
      if (isResize(arg) && ++resizes === 2) { fake.crash(); throw new Error('page.evaluate: Target crashed'); }
      // An empty resize result is unusable, so modelCopyOf keeps the full-size frame.
      return isResize(arg) ? '' : true;
    });
    launch.mockResolvedValue(fake.browser);
    const result = await captureFrames([], [0]);
    expect(result.frames.map((frame) => frame.pair)).toEqual(['a', 'b']);
    expect(result.frames[1]!.modelPng).toBe(result.frames[1]!.png);
  });

  it('enforces the wall-clock budget on a renderer call that never settles, then closes the browser and server', async () => {
    const fake = fakeBrowser(() => new Promise<never>(() => {}));
    launch.mockResolvedValue(fake.browser);
    const error = await captureFrames([], [0], { wallClockBudgetMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ReplayCrashedError);
    expect((error as Error).message).toBe('frame capture wall-clock budget exceeded');
    expect(fake.browser.close).toHaveBeenCalledOnce();
    expect(servers[0]!.listening).toBe(false);
  }, 2_000);

  it('classifies only crash messages as crashes', () => {
    expect(isReplayCrash(new ReplayCrashedError('x'))).toBe(true);
    expect(isReplayCrash(new Error('page.screenshot: Page crashed'))).toBe(true);
    expect(isReplayCrash(new Error('frame capture wall-clock budget exceeded'))).toBe(false);
    expect(isReplayCrash('Target crashed')).toBe(false);
  });
});
