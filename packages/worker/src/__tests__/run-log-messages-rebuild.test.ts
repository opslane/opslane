import { canonicalJson } from '@opslane/agent-runs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mocks.create } })),
}));
vi.mock('../db.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../db.js')>()), recordJobUsage: vi.fn() }));

import { buildDiffJudgeParams, judgeDiff, type DiffJudgeInput } from '../harness/diff-judge.js';
import { buildFixNarrativeParams, generateFixNarrative, type AgentFixInput, type FixNarrativePromptInput } from '../agent-fix.js';
import { buildDigestParams, defaultDependencies } from '../digest-writer/job.js';
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

describe('raw Anthropic gateway run logs', () => {
  it('diff judge: rebuilds the request and marks invalid scores as invalid output', async () => {
    const input: DiffJudgeInput = { errorType: 'TypeError', errorMessage: 'x', stackTrace: 's', diff: '+a', stackTraceFiles: ['a.ts'] };
    mocks.create.mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't', name: 'score_diff', input: { scope: 'bad' } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 1 } });
    await expect(judgeDiff('k', input, undefined, context)).rejects.toThrow(/invalid scores/);
    const bundle = memory.bundle();
    expect(canonicalJson(bundle.request)).toBe(canonicalJson(messageRequestDto(buildDiffJudgeParams(bundle.structuredInput as DiffJudgeInput))));
    expect(memory.finished[0]).toMatchObject({ stop: 'invalid_output' });
    expect(memory.transcript().some((event) => event.type === 'validator_rejection')).toBe(true);
  });

  it('fix narrative: rebuilds the request from the logged prompt input', async () => {
    mocks.create.mockResolvedValueOnce({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } });
    await generateFixNarrative('k', { errorType: 'TypeError', errorMessage: 'x', visualAnalysis: null, runContext: context } as unknown as AgentFixInput, 'cause', '+fix', 'a.ts');
    const bundle = memory.bundle();
    expect(canonicalJson(bundle.request)).toBe(canonicalJson(messageRequestDto(buildFixNarrativeParams(bundle.structuredInput as FixNarrativePromptInput))));
    expect(memory.finished[0]).toMatchObject({ stop: 'invalid_output' });
  });

  it('digest writer: rebuilds the request and marks truncation', async () => {
    mocks.create.mockResolvedValueOnce({ content: [], stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 8192 } });
    const deps = defaultDependencies({ jobId: context.jobId, execution: 0 }, { ...context, jobType: 'digest_write' });
    await expect(deps.askModel([])).rejects.toThrow(/truncated/);
    const bundle = memory.bundle();
    const structured = bundle.structuredInput as { candidates: Parameters<typeof buildDigestParams>[0] };
    expect(canonicalJson(bundle.request)).toBe(canonicalJson(messageRequestDto(buildDigestParams(structured.candidates))));
    expect(memory.finished[0]).toMatchObject({ stop: 'truncated' });
  });

  it('counts unlogged requests and keeps provider-reported thinking tokens', async () => {
    const { capturedRun } = await import('./helpers/run-log-memory-sink.js');
    const { loggedMessagesCreate } = await import('../run-logs/logged-messages.js');
    const recorded = capturedRun();
    mocks.create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 9, output_tokens_details: { thinking_tokens: 6 } } });
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    await loggedMessagesCreate(new Anthropic({ apiKey: 'k' }), recorded.run, { model: 'm', max_tokens: 10, messages: [] }, { logRequest: false });
    expect(recorded.counted).toBe(1);
    expect(recorded.requests).toEqual([]);
    expect(recorded.events[0]).toMatchObject({ type: 'response', usage: { input: 3, output: 9, thinking: 6 } });
  });
});
