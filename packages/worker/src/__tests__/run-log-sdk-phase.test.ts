import { describe, expect, it, vi } from 'vitest';

const runner = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('../harness/sdk-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/sdk-agent.js')>()),
  runReadOnlyAgentSdk: vi.fn(async (_input: unknown, run?: { event: (event: unknown) => void }) => {
    run?.event({ type: 'response', model: 'claude-sonnet-5', content: [], stopReason: 'end_turn', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
    return runner.result;
  }),
}));

import type { ReadOnlyRunInput } from '../harness/sdk-agent.js';
import { readOnlyStopToRunStop, runLoggedSdk, sdkRequestDto, sdkSettings } from '../run-logs/sdk-phase.js';
import { setRunLogDepsForTests } from '../run-logs/handle.js';
import { memoryRunLogDeps } from './helpers/run-log-memory-sink.js';

const input: ReadOnlyRunInput = {
  apiKey: 'k', model: 'claude-sonnet-5', maxTurns: 10, budgetUsd: 2,
  pricing: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  systemPrompt: 'system', firstMessage: 'first',
  terminalTool: { name: 'submit_x', description: 'Submit.', input_schema: { type: 'object', properties: {} } },
  reader: { readFile: async () => '', grep: async () => '', list: async () => '', exists: async (paths: string[]) => paths },
  commandRunner: { run: async () => ({ stdout: '', exitCode: 0 }) },
  classification: { minFilesRead: 1 },
};
const context = {
  jobId: '11111111-1111-4111-8111-111111111111', jobType: 'product_context', projectId: 'p1', attempts: 0,
  leaseGeneration: '1', errorGroupId: null, ticketId: null, episodeId: null, batchId: null, sessionId: null,
};

describe('runLoggedSdk', () => {
  it('runs once with logging disabled when request DTO construction fails', async () => {
    runner.result = { stop: 'terminal', terminalInput: { answer: 'done' } };
    const brokenTool = { ...input.terminalTool };
    Object.defineProperty(brokenTool, 'description', { get: () => { throw new Error('bad descriptor'); } });
    const result = await runLoggedSdk({
      context, phase: 'test', entryPoint: 'test', structuredInput: {},
      input: { ...input, terminalTool: brokenTool },
    });
    expect(result).toBe(runner.result);
  });

  it('writes the SDK request, effective settings including tool lists, and the mapped stop', async () => {
    const memory = memoryRunLogDeps();
    setRunLogDepsForTests(memory.deps);
    runner.result = { stop: 'terminal', terminalInput: {}, filesRead: [], lastModelText: '', costUsd: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    try {
      await runLoggedSdk({ context, phase: 'product_context', entryPoint: 'product-context/job#askModelForClaims', structuredInput: { routes: [] }, input });
    } finally {
      setRunLogDepsForTests(null);
    }
    expect(memory.bundle().request).toEqual(JSON.parse(JSON.stringify(sdkRequestDto(input))));
    expect(memory.bundle().settings).toEqual({
      model: 'claude-sonnet-5', maxTurns: 10, budgetUsd: 2, maxResubmits: 2, commandEnabled: true, minFilesRead: 1, validatesTerminal: false,
      allowedTools: ['mcp__repo__read_file', 'mcp__repo__search', 'mcp__repo__list_files', 'mcp__repo__run_command', 'mcp__repo__submit_x'],
      disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'ToolSearch'],
    });
    expect(JSON.parse(JSON.stringify(sdkSettings(input)))).toEqual(memory.bundle().settings);
    expect(sdkRequestDto(input).tools.map((tool) => tool.name)).toEqual(['read_file', 'search', 'list_files', 'run_command']);
    expect(memory.finished[0]!.stop).toBe('terminal_tool');
  });

  it('logs the effective bounded resubmission setting', () => {
    expect(sdkSettings({ ...input, maxResubmits: 10 }).maxResubmits).toBe(5);
    expect(sdkSettings({ ...input, maxResubmits: -1 }).maxResubmits).toBe(0);
    expect(sdkSettings({ ...input, maxResubmits: Number.NaN }).maxResubmits).toBe(2);
  });

  it('maps every read-only stop', () => {
    expect(['terminal', 'budget', 'no_tool_call', 'api_error', 'turns_exhausted', 'no_evidence', 'truncated'].map((stop) =>
      readOnlyStopToRunStop(stop as Parameters<typeof readOnlyStopToRunStop>[0])))
      .toEqual(['terminal_tool', 'budget', 'no_tool_call', 'api_error', 'turns_exhausted', 'no_evidence', 'truncated']);
  });
});
