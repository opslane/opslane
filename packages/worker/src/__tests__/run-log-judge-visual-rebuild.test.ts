import { createHash } from 'node:crypto';
import { canonicalJson } from '@opslane/agent-runs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mocks.create } })),
}));

import { buildFixJudgeParams, judgeFixAttempt, type FixJudgePromptInput } from '../harness/fix-judge.js';
import { buildVisualAnalysisParams, runVisualAnalysis, type VisualPromptInput } from '../visual-analysis.js';
import { messageRequestDto } from '../run-logs/logged-messages.js';
import { setRunLogDepsForTests } from '../run-logs/handle.js';
import { memoryRunLogDeps } from './helpers/run-log-memory-sink.js';

const context = {
  jobId: '11111111-1111-4111-8111-111111111111', jobType: 'fix', projectId: 'p1', attempts: 0,
  leaseGeneration: '5', errorGroupId: null, ticketId: null, episodeId: null, batchId: null, sessionId: null,
};
let memory: ReturnType<typeof memoryRunLogDeps>;
beforeEach(() => {
  process.env['ANTHROPIC_API_KEY'] = 'k';
  mocks.create.mockReset();
  memory = memoryRunLogDeps();
  setRunLogDepsForTests(memory.deps);
});
afterEach(() => {
  setRunLogDepsForTests(null);
  delete process.env['ANTHROPIC_API_KEY'];
});

const response = (content: unknown[]) => ({ content, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } });

describe('fix judge and visual analysis run logs', () => {
  it('fix judge: one run spanning a probe and a malformed re-ask', async () => {
    mocks.create
      .mockResolvedValueOnce(response([{ type: 'tool_use', id: 'p1', name: 'run_probe', input: { command: 'ls' } }]))
      .mockResolvedValueOnce(response([{ type: 'tool_use', id: 'v1', name: 'submit_judge_verdict', input: { approved: false, assessment: 'x' } }]))
      .mockResolvedValueOnce(response([{ type: 'tool_use', id: 'v2', name: 'submit_judge_verdict', input: { approved: true, assessment: 'ok' } }]));
    const sandbox = { commands: { run: vi.fn(async () => ({ stdout: 'a.ts', stderr: '', exitCode: 0 })) } };
    const verdict = await judgeFixAttempt({
      apiKey: 'k', diagnosis: null, diff: '+fix', testSource: 'it()', ledger: [], tierRecord: { tier: 'checked' } as never,
      anomalies: ['suite skipped'], sandbox: sandbox as never, errorTitle: 'x', runContext: context,
    });
    expect(verdict.approved).toBe(true);
    expect(memory.started).toHaveLength(1);
    const bundle = memory.bundle();
    expect(canonicalJson(bundle.request)).toBe(canonicalJson(messageRequestDto(buildFixJudgeParams(bundle.structuredInput as FixJudgePromptInput))));
    expect((bundle.structuredInput as FixJudgePromptInput).probeEnabled).toBe(true);
    expect(memory.transcript().map((event) => event.type)).toEqual([
      'response', 'tool_call', 'tool_result', 'response', 'validator_rejection', 'request', 'response', 'stop',
    ]);
    expect(memory.finished[0]).toMatchObject({ stop: 'completed', modelRequests: 3 });
  });

  it('visual analysis: logs image references, not bytes, and rebuilds the request', async () => {
    mocks.create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    const bytes = Buffer.from('png-bytes');
    const result = await runVisualAnalysis({
      screenshots: [{ base64: bytes.toString('base64'), contentType: 'image/png', kind: 'error', objectKey: 'replays/p/r/artifacts/1' }],
      signals: { clicks: 2 }, errorType: 'TypeError', errorMessage: 'x', runContext: context,
    });
    expect(result).toBeNull();
    const bundle = memory.bundle();
    expect(memory.objects.get(`${memory.started[0]!.objectPrefix}input.json`)).not.toContain(bytes.toString('base64'));
    expect(bundle.images).toEqual([{ kind: 'object', objectKey: 'replays/p/r/artifacts/1', sha256: createHash('sha256').update(bytes).digest('hex') }]);
    const structured = bundle.structuredInput as VisualPromptInput;
    expect(canonicalJson(bundle.request)).toBe(canonicalJson(messageRequestDto(buildVisualAnalysisParams(structured, ['ignored']))));
    expect(memory.finished[0]).toMatchObject({ stop: 'invalid_output' });
  });
});
