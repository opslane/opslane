import { describe, expect, it } from 'vitest';
import { NOOP_RUN, withRunLog } from '../run-logs/handle.js';
import type { RunContext } from '../run-logs/context.js';
import { memoryRunLogDeps } from './helpers/run-log-memory-sink.js';

const context: RunContext = {
  jobId: '11111111-1111-4111-8111-111111111111', jobType: 'session_narrate', projectId: 'p1',
  attempts: 0, leaseGeneration: '1', errorGroupId: null, ticketId: null, episodeId: null, batchId: null, sessionId: 'sess_1',
};
const options = {
  context, phase: 'narrate', entryPoint: 'narrative/job#processNarration', models: ['claude-sonnet-5'],
  settings: { model: 'claude-sonnet-5' }, structuredInput: { timelineText: 'L1 click' }, request: { system: 's', user: 'u' },
};

describe('withRunLog partial failures', () => {
  it('records unwritten payloads on rows that were still inserted', async () => {
    const memory = memoryRunLogDeps();
    memory.deps.sink = { ...memory.deps.sink!, putObject: async () => { throw new Error('storage down'); } };
    await expect(withRunLog(options, async () => 'ok', () => 'completed', memory.deps)).resolves.toBe('ok');
    expect(memory.started[0]).toMatchObject({ bundleWritten: false, bundleBytes: 0 });
    expect(memory.finished[0]).toMatchObject({ stop: 'completed', transcriptWritten: false, transcriptBytes: 0 });
  });

  it('runs the work unlogged when logging is off or storage is not configured', async () => {
    for (const overrides of [{ enabled: false }, { sink: null }]) {
      const memory = memoryRunLogDeps(overrides);
      await expect(withRunLog(options, async (run) => run, () => 'completed', memory.deps)).resolves.toBe(NOOP_RUN);
      expect(memory.started).toHaveLength(0);
      expect(memory.objects.size).toBe(0);
    }
  });

  it('keeps error_detail within 500 characters when the cut lands inside a redaction', async () => {
    const memory = memoryRunLogDeps();
    // 485 + ' password ' puts the 500-character cut inside '[REDACTED]'; scrubbing that fragment again grows it.
    const message = `${'x'.repeat(485)} password hunter2 and more text`;
    await expect(withRunLog(options, async () => { throw new Error(message); }, () => 'completed', memory.deps)).rejects.toThrow();
    expect(memory.finished[0]!.errorDetail!.length).toBeLessThanOrEqual(500);
    expect(memory.finished[0]!.errorDetail).not.toContain('hunter2');
  });
});
