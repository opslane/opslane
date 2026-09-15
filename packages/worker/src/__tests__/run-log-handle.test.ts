import { describe, expect, it } from 'vitest';
import { MachineUnavailableError } from '../harness/errors.js';
import { NOOP_RUN, runLogsEnabled, withRunLog, workerBuildSha } from '../run-logs/handle.js';
import { runLogFailureCounts, withDeadline } from '../run-logs/sink.js';
import type { RunContext } from '../run-logs/context.js';
import { memoryRunLogDeps } from './helpers/run-log-memory-sink.js';

const context: RunContext = {
  jobId: '11111111-1111-4111-8111-111111111111', jobType: 'session_narrate', projectId: 'p1',
  attempts: 1, leaseGeneration: '7', errorGroupId: null, ticketId: null, episodeId: null, batchId: null, sessionId: 'sess_1',
};
const options = {
  context, phase: 'narrate', entryPoint: 'narrative/job#processNarration', models: ['claude-sonnet-5'],
  settings: { model: 'claude-sonnet-5' },
  structuredInput: { timelineText: 'L1 click', config: '{"client_secret":"synthetic123"}', api_key: 'k-1' },
  request: { system: 's', user: 'u' },
};
const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };

describe('withRunLog', () => {
  it('runs the work with a no-op handle when there is no context', async () => {
    const memory = memoryRunLogDeps();
    const seen = await withRunLog({ ...options, context: null }, async (run) => run, () => 'completed', memory.deps);
    expect(seen).toBe(NOOP_RUN);
    expect(memory.objects.size).toBe(0);
  });

  it('invokes synchronously throwing work exactly once when logging is disabled', async () => {
    let calls = 0;
    const original = new Error('synchronous failure');
    await expect(withRunLog({ ...options, context: null }, () => {
      calls++;
      throw original;
    }, () => 'completed', memoryRunLogDeps().deps)).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  it('writes the bundle and started row before the work, and transcript and finished row after', async () => {
    const memory = memoryRunLogDeps();
    const result = await withRunLog(options, async (run) => {
      expect(memory.started).toHaveLength(1);
      expect(memory.objects.has(`${memory.started[0]!.objectPrefix}input.json`)).toBe(true);
      run.noteRequest({ first: true });
      run.event({ type: 'response', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage });
      run.noteRequest({ reask: true });
      return 'done';
    }, () => 'completed', memory.deps);
    expect(result).toBe('done');
    expect(memory.started[0]).toMatchObject({
      jobType: 'session_narrate', phase: 'narrate', sessionId: 'sess_1', attempts: 1, leaseGeneration: '7',
      objectPrefix: 'agent-runs/p1/2026-09-15/00000000-0000-4000-8000-000000000001/', bundleWritten: true, workerBuildSha: 'test-sha',
    });
    const bodyText = memory.objects.get(`${memory.started[0]!.objectPrefix}input.json`)!;
    expect(bodyText).not.toContain('synthetic123');
    expect(bodyText).not.toContain('k-1');
    expect(memory.transcript().map((event) => event.type)).toEqual(['response', 'request', 'stop']);
    expect(memory.finished[0]).toMatchObject({ stop: 'completed', modelRequests: 2, turns: 1, transcriptWritten: true });
    expect(memory.finished[0]!.costUsd).toBeCloseTo(0.003, 6); // sonnet-5: 1000*$2/M + 100*$10/M
  });

  it('logs a throw, finishes the run and rethrows the original value', async () => {
    const memory = memoryRunLogDeps();
    const original = new Error('boom GITHUB_TOKEN=ghx1');
    await expect(withRunLog(options, async () => { throw original; }, () => 'completed', memory.deps)).rejects.toBe(original);
    expect(memory.finished[0]).toMatchObject({ stop: 'threw', errorClass: 'Error', errorDetail: 'boom GITHUB_TOKEN=[REDACTED]' });
    expect(memory.transcript().at(-2)).toMatchObject({ type: 'error', errorClass: 'Error' });
  });

  it('rethrows non-Error values untouched, including ones that cannot be stringified', async () => {
    const memory = memoryRunLogDeps();
    const hostile = Object.create(null) as object;
    await expect(withRunLog(options, async () => { throw hostile; }, () => 'completed', memory.deps)).rejects.toBe(hostile);
    expect(memory.finished[0]).toMatchObject({ stop: 'threw', errorClass: 'object' });
  });

  it('classifies machine loss and aborts', async () => {
    const memory = memoryRunLogDeps();
    await expect(withRunLog(options, async () => { throw new MachineUnavailableError('gone', 'gone'); }, () => 'completed', memory.deps)).rejects.toThrow();
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    await expect(withRunLog(options, async () => { throw aborted; }, () => 'completed', memory.deps)).rejects.toThrow();
    expect(memory.finished.map((row) => row.stop)).toEqual(['machine_lost', 'aborted']);
  });

  it('never lets a failing sink, an unserializable input or a throwing classifier change the result', async () => {
    const before = runLogFailureCounts();
    const memory = memoryRunLogDeps();
    memory.deps.sink = {
      putObject: async () => { throw new Error('storage down'); },
      insertStarted: async () => { throw new Error('db down'); },
      insertFinished: async () => { throw new Error('db down'); },
    };
    await expect(withRunLog(options, async () => 42, () => 'completed', memory.deps)).resolves.toBe(42);
    const after = runLogFailureCounts();
    expect(after.bundle - before.bundle).toBe(1);
    expect(after.transcript - before.transcript).toBe(1);
    expect(after.started_row - before.started_row).toBe(1);
    expect(after.finished_row - before.finished_row).toBe(1);

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const ok = memoryRunLogDeps();
    await expect(withRunLog({ ...options, structuredInput: { n: 10n, circular } }, async () => 'fine', () => { throw new Error('bad classify'); }, ok.deps))
      .resolves.toBe('fine');
    expect(ok.finished[0]!.stop).toBe('completed');
  });

  it('uses the run start date for both the prefix and row across UTC midnight', async () => {
    let calls = 0;
    const memory = memoryRunLogDeps({ now: () => new Date(calls++ === 0 ? '2026-09-15T23:59:59Z' : '2026-09-16T00:00:01Z') });
    await withRunLog(options, async () => 'done', () => 'completed', memory.deps);
    expect(memory.started[0]!.recordedAt.toISOString()).toBe('2026-09-15T23:59:59.000Z');
    expect(memory.started[0]!.objectPrefix).toContain('/2026-09-15/');
  });

  it('scrubs started-row values and survives hostile error getters', async () => {
    const memory = memoryRunLogDeps();
    const hostile = new Error('password=private-value');
    Object.defineProperty(hostile, 'name', { get: () => { throw new Error('bad name'); } });
    Object.defineProperty(hostile, 'stack', { get: () => { throw new Error('bad stack'); } });
    await expect(withRunLog({ ...options, phase: 'GITHUB_TOKEN=private-value' }, async () => { throw hostile; }, () => 'completed', memory.deps)).rejects.toBe(hostile);
    expect(memory.started[0]!.phase).toBe('GITHUB_TOKEN=[REDACTED]');
    expect(memory.finished[0]).toMatchObject({ stop: 'threw', errorClass: 'unknown', errorDetail: 'password=[REDACTED]' });
  });

  it('uses a no-op handle after setup failure and contains failures in handle methods', async () => {
    const memory = memoryRunLogDeps({ newRunId: () => { throw new Error('no UUID'); } });
    await expect(withRunLog(options, async (run) => run, () => 'completed', memory.deps)).resolves.toBe(NOOP_RUN);
    const ok = memoryRunLogDeps();
    await expect(withRunLog(options, async (run) => {
      const event = new Proxy({}, { get: () => { throw new Error('bad event'); } });
      run.event(event as Parameters<typeof run.event>[0]);
      const totals = new Proxy({}, { ownKeys: () => { throw new Error('bad usage'); } });
      run.replaceUsage(totals);
      return 42;
    }, () => 'completed', ok.deps)).resolves.toBe(42);
    expect(ok.finished).toHaveLength(1);
  });

  it('stays off below a 60 s lease, parsing like the worker, and reads the build sha', () => {
    expect(runLogsEnabled({ LEASE_DURATION_MS: '59999' })).toBe(false);
    expect(runLogsEnabled({ LEASE_DURATION_MS: '0xEA60' })).toBe(false); // parseInt('0xEA60', 10) === 0
    expect(runLogsEnabled({ LEASE_DURATION_MS: 'abc' })).toBe(false);
    expect(runLogsEnabled({})).toBe(true);
    expect(workerBuildSha({ OPSLANE_BUILD_SHA: ' abc ' })).toBe('abc');
    expect(workerBuildSha({})).toBe('unknown');
  });
});

describe('withDeadline', () => {
  it('rejects at the deadline, calls onTimeout, and hands a late value to onLate', async () => {
    let late: string | null = null;
    let timedOut = false;
    let aborted = false;
    await expect(withDeadline(10, (signal) => new Promise<string>((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; });
      setTimeout(() => resolve('slow'), 40);
    }), {
      onLate: (value) => { late = value; },
      onTimeout: () => { timedOut = true; },
    })).rejects.toThrow(/exceeded 10 ms/);
    expect(timedOut).toBe(true);
    expect(aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(late).toBe('slow');
  });
});
