import { SdkStreamTranscriber } from '@opslane/agent-runs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineUnavailableError } from '../errors.js';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface FakeTool { name: string; handler: Handler }
type Action =
  | { kind: 'call'; name: string; input: Record<string, unknown> }
  | { kind: 'assistant'; id?: string; text?: string; usage?: Partial<typeof DEFAULT_USAGE>; stopReason?: 'max_tokens' | 'tool_use' | 'end_turn'; requestId?: string; toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>; model?: string }
  | { kind: 'user'; results: Array<{ id: string; text: string; isError?: boolean }> }
  | { kind: 'result'; subtype?: string; isError?: boolean; usage?: Partial<typeof DEFAULT_USAGE>; modelUsage?: Record<string, unknown>; numTurns?: number }
  | { kind: 'throw'; error: unknown };


const DEFAULT_USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const sdk = vi.hoisted(() => ({
  actions: [] as Action[],
  queryOptions: null as Record<string, unknown> | null,
  returned: vi.fn(async () => ({ done: true, value: undefined })),
}));
const tracing = vi.hoisted(() => ({ annotate: vi.fn() }));

vi.mock('../../tracing.js', () => ({ annotateActiveSpan: tracing.annotate }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: Handler): FakeTool => ({ name, handler }),
  createSdkMcpServer: (options: unknown) => options,
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.queryOptions = options;
    const iterator = (async function* () {
      const server = (options['mcpServers'] as { repo: { tools: FakeTool[] } }).repo;
      for (const action of sdk.actions) {
        if (action.kind === 'throw') {
          throw action.error;
        } else if (action.kind === 'call') {
          const selected = server.tools.find((candidate) => candidate.name === action.name);
          if (!selected) throw new Error(`missing fake tool ${action.name}`);
          await selected.handler(action.input);
        } else if (action.kind === 'assistant') {
          yield {
            request_id: action.requestId, type: 'assistant', uuid: 'u', session_id: 's', parent_tool_use_id: null,
            message: {
              id: action.id ?? crypto.randomUUID(), type: 'message', role: 'assistant', model: action.model ?? 'test-model',
              content: [...(action.text ? [{ type: 'text', text: action.text }] : []), ...(action.toolUses ?? []).map((use) => ({ type: 'tool_use', ...use }))],
              stop_reason: action.stopReason ?? null, stop_sequence: null,
              usage: { ...DEFAULT_USAGE, ...action.usage },
            },
          };
} else if (action.kind === 'user') {
          yield {
            type: 'user', session_id: 's', parent_tool_use_id: null,
            message: { role: 'user', content: action.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: [{ type: 'text', text: r.text }], ...(r.isError ? { is_error: true } : {}) })) },
          };
        } else {
          yield action.subtype === 'success' || action.subtype === undefined
            ? {
                type: 'result', subtype: 'success', is_error: action.isError ?? false,
                result: action.isError ? 'failed' : 'done', api_error_status: action.isError ? 503 : null,
                duration_ms: 1, duration_api_ms: 1, num_turns: action.numTurns ?? 1, stop_reason: null,
                total_cost_usd: 0, usage: { ...DEFAULT_USAGE, ...action.usage }, modelUsage: action.modelUsage ?? {}, permission_denials: [],
                uuid: 'r', session_id: 's',
              }
            : {
                type: 'result', subtype: action.subtype, is_error: true,
                errors: ['query failed'], duration_ms: 1, duration_api_ms: 1,
                num_turns: action.numTurns ?? 1, stop_reason: null, total_cost_usd: 0,
                usage: { ...DEFAULT_USAGE, ...action.usage }, modelUsage: action.modelUsage ?? {}, permission_denials: [], uuid: 'r', session_id: 's',
              };
        }
      }
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      return: sdk.returned,
    };
  },
}));

import {
  buildQueryOptions,
  callTool,
  runReadOnlyAgentSdk,
  type ReadOnlyRunInput,
} from '../sdk-agent.js';

function fakeReader() {
  return {
    readFile: vi.fn(async () => 'export const x = 1;'),
    grep: vi.fn(async () => 'src/a.ts:1:x'),
    list: vi.fn(async () => 'src/a.ts'),
    exists: vi.fn(async (paths: string[]) => paths),
  };
}

function fakeInput(overrides: Partial<ReadOnlyRunInput> = {}): ReadOnlyRunInput {
  return {
    apiKey: 'test-key', model: 'claude-sonnet-4-6', maxTurns: 4, budgetUsd: 1,
    pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    systemPrompt: 'Inspect only through the supplied tools.', firstMessage: 'Investigate.',
    terminalTool: {
      name: 'submit', description: 'Submit.',
      input_schema: {
        type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'],
      },
    },
    reader: fakeReader(),
    ...overrides,
  };
}

beforeEach(() => {
  sdk.actions.length = 0;
  sdk.queryOptions = null;
  sdk.returned.mockClear();
  tracing.annotate.mockClear();
});

describe('SDK read-only agent', () => {
  it('exposes only our tools, by allowlist', () => {
    expect(buildQueryOptions(fakeInput()).title).toBe('Opslane investigation');
    expect(buildQueryOptions(fakeInput()).allowedTools).toEqual([
      'mcp__repo__read_file', 'mcp__repo__search', 'mcp__repo__list_files', 'mcp__repo__submit',
    ]);
  });

  it('makes no built-in file or command tool reachable', () => {
    const options = buildQueryOptions(fakeInput());
    expect(options.tools).toEqual([]);
    for (const builtin of ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'ToolSearch']) {
      expect(options.allowedTools).not.toContain(builtin);
    }
  });

  it('tool handlers use the existing RepoReader formatter', async () => {
    const reader = fakeReader();
    const output = await callTool('read_file', { path: 'a.ts' }, reader);
    expect(reader.readFile).toHaveBeenCalledWith('a.ts');
    expect(output).toContain('1 | export const x');
  });

  it('returns the complete result shape and cleans up after submission', async () => {
    sdk.actions.push(
      { kind: 'call', name: 'read_file', input: { path: 'a.ts' } },
      { kind: 'assistant', text: 'done' },
      { kind: 'call', name: 'submit', input: { answer: 'yes' } },
    );
    const out = await runReadOnlyAgentSdk(fakeInput());
    expect(out).toMatchObject({
      terminalInput: { answer: 'yes' }, filesRead: ['a.ts'], lastModelText: 'done',
      costUsd: expect.any(Number), stop: 'terminal',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    });
    expect(sdk.returned).toHaveBeenCalledOnce();
  });

  it('drains after terminal capture and returns cumulative result usage', async () => {
    sdk.actions.push(
      { kind: 'assistant', usage: { input_tokens: 5, output_tokens: 9 } },
      { kind: 'call', name: 'submit', input: { answer: 'yes' } },
      { kind: 'result', usage: {
        input_tokens: 120,
        output_tokens: 9_400,
        cache_read_input_tokens: 250_000,
        cache_creation_input_tokens: 31_000,
      } },
    );

    const out = await runReadOnlyAgentSdk(fakeInput({ budgetUsd: 100 }));

    expect(out.stop).toBe('terminal');
    expect(out.usage).toEqual({
      input: 120, output: 9_400, cacheRead: 250_000, cacheWrite: 31_000,
    });
  });

  it('enforces the dollar budget from streamed usage', async () => {
    sdk.actions.push({ kind: 'assistant', usage: { output_tokens: 1_000_000 } });
    expect((await runReadOnlyAgentSdk(fakeInput({ budgetUsd: 0.0001 }))).stop).toBe('budget');
  });

  it('prices cache reads and writes separately for the selected model', async () => {
    sdk.actions.push({
      kind: 'assistant',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 },
    });
    const read = await runReadOnlyAgentSdk(fakeInput({ budgetUsd: 10 }));
    expect(read.costUsd).toBeCloseTo(0.3);

    sdk.actions.splice(0, sdk.actions.length, {
      kind: 'assistant',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 },
    });
    const write = await runReadOnlyAgentSdk(fakeInput({ budgetUsd: 10 }));
    expect(write.costUsd).toBeCloseTo(3.75);
  });

  it('feeds rejection back and accepts a corrected resubmission', async () => {
    const validate = vi.fn()
      .mockReturnValueOnce({ ok: false, feedback: 'answer is incomplete' })
      .mockReturnValueOnce({ ok: true });
    sdk.actions.push(
      { kind: 'call', name: 'submit', input: { answer: 'no' } },
      { kind: 'call', name: 'submit', input: { answer: 'yes' } },
    );
    const out = await runReadOnlyAgentSdk(fakeInput({ validateTerminal: validate }));
    expect(validate).toHaveBeenCalledTimes(2);
    expect(out.terminalInput).toEqual({ answer: 'yes' });
  });

  it('lets a dead machine escape instead of becoming tool output', async () => {
    const reader = fakeReader();
    reader.readFile.mockRejectedValue(new MachineUnavailableError('gone', 'gone'));
    sdk.actions.push(
      { kind: 'call', name: 'read_file', input: { path: 'a.ts' } },
      { kind: 'assistant' },
    );
    await expect(runReadOnlyAgentSdk(fakeInput({ reader })))
      .rejects.toBeInstanceOf(MachineUnavailableError);
  });

  it('adds the product-context command tool only when its capability is supplied', () => {
    const commandRunner = { run: vi.fn(async () => ({ stdout: '', exitCode: 0 })) };
    expect(buildQueryOptions(fakeInput({ commandRunner })).allowedTools)
      .toContain('mcp__repo__run_command');
    expect(buildQueryOptions(fakeInput()).allowedTools)
      .not.toContain('mcp__repo__run_command');
  });

  it('rejects a command-only product-context submission until cited files are read', async () => {
    const commandRunner = { run: vi.fn(async () => ({ stdout: 'src/router.ts:/assets', exitCode: 0 })) };
    sdk.actions.push(
      { kind: 'call', name: 'run_command', input: { command: 'grep -R routes src' } },
      { kind: 'call', name: 'run_command', input: { command: 'find app -name page.tsx' } },
      { kind: 'call', name: 'run_command', input: { command: 'grep -R "path:" src' } },
      { kind: 'call', name: 'run_command', input: { command: 'git ls-files' } },
      { kind: 'call', name: 'submit', input: { answer: 'premature' } },
      { kind: 'call', name: 'read_file', input: { path: 'src/router.ts' } },
      { kind: 'call', name: 'submit', input: { answer: 'grounded' } },
    );
    const validate = vi.fn(async () => ({ ok: true as const }));
    const out = await runReadOnlyAgentSdk(fakeInput({
      commandRunner,
      classification: { minFilesRead: 1 },
      validateTerminal: validate,
    }));
    expect(commandRunner.run).toHaveBeenCalledTimes(4);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(out.terminalInput).toEqual({ answer: 'grounded' });
    expect(out.filesRead).toEqual(['src/router.ts']);
  });
});

describe('how a run ends', () => {
  it('annotates the enclosing span with how the run ended and what it cost', async () => {
    sdk.actions.push(
      { kind: 'assistant', text: 'looking' },
      { kind: 'result', subtype: 'error_max_turns' },
    );
    await runReadOnlyAgentSdk(fakeInput());
    expect(tracing.annotate).toHaveBeenCalledWith(expect.objectContaining({
      'agent.stop': 'turns_exhausted',
      'agent.cost_usd': expect.any(Number),
      'agent.input_tokens': 100,
      'agent.output_tokens': 20,
      'agent.files_read': 0,
    }));
  });

  it('spends nothing when zero turns cannot meet the evidence gate', async () => {
    const out = await runReadOnlyAgentSdk(fakeInput({
      maxTurns: 0, classification: { minFilesRead: 1 },
    }));
    expect(out).toMatchObject({ stop: 'no_evidence', filesRead: [], costUsd: 0, terminalInput: null });
    expect(sdk.queryOptions).toBeNull();
  });

  it('calls the same zero-turn run turns_exhausted when no evidence gate applies', async () => {
    expect((await runReadOnlyAgentSdk(fakeInput({ maxTurns: 0 }))).stop).toBe('turns_exhausted');
  });

  it('reports exhausted turns rather than a silent no_tool_call', async () => {
    sdk.actions.push({ kind: 'result', subtype: 'error_max_turns' });
    expect((await runReadOnlyAgentSdk(fakeInput())).stop).toBe('turns_exhausted');
  });

  it('reports the budget stop the SDK reports', async () => {
    sdk.actions.push({ kind: 'result', subtype: 'error_max_budget_usd' });
    expect((await runReadOnlyAgentSdk(fakeInput())).stop).toBe('budget');
  });

  it('carries the detail of a failure during execution', async () => {
    sdk.actions.push({ kind: 'result', subtype: 'error_during_execution' });
    const out = await runReadOnlyAgentSdk(fakeInput());
    expect(out).toMatchObject({ stop: 'api_error', apiErrorDetail: 'query failed' });
  });

  it('surfaces the HTTP status of a rejected request, which decides retry from hard fail', async () => {
    sdk.actions.push({ kind: 'result', subtype: 'success', isError: true });
    const out = await runReadOnlyAgentSdk(fakeInput());
    expect(out).toMatchObject({ stop: 'api_error', apiErrorStatus: 503, apiErrorDetail: 'failed' });
  });

  it('reports a thrown query as an api_error carrying its status', async () => {
    sdk.actions.push({ kind: 'throw', error: Object.assign(new Error('overloaded'), { status: 529 }) });
    const out = await runReadOnlyAgentSdk(fakeInput());
    expect(out).toMatchObject({ stop: 'api_error', apiErrorStatus: 529 });
    expect(sdk.returned).toHaveBeenCalled();
  });

  it('keeps turns_exhausted when the SDK throws after the typed max-turns result', async () => {
    sdk.actions.push(
      { kind: 'result', subtype: 'error_max_turns' },
      { kind: 'throw', error: new Error('Claude Code returned an error result: Reached maximum number of turns (20)') },
    );
    const out = await runReadOnlyAgentSdk(fakeInput());
    expect(out.stop).toBe('turns_exhausted');
    expect(out.apiErrorDetail).toBeUndefined();
    expect(sdk.returned).toHaveBeenCalled();
  });

  it('keeps budget when the SDK throws after the typed max-budget result', async () => {
    sdk.actions.push(
      { kind: 'result', subtype: 'error_max_budget_usd' },
      { kind: 'throw', error: new Error('Claude Code returned an error result: budget exceeded') },
    );
    expect((await runReadOnlyAgentSdk(fakeInput())).stop).toBe('budget');
  });

  it('keeps the typed api_error detail when the SDK throws afterwards', async () => {
    sdk.actions.push(
      { kind: 'result', subtype: 'success', isError: true },
      { kind: 'throw', error: new Error('Claude Code returned an error result: failed') },
    );
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({
      stop: 'api_error', apiErrorStatus: 503, apiErrorDetail: 'failed',
    });
  });

  it('classifies a throw-only max-turns exit as turns_exhausted', async () => {
    sdk.actions.push({
      kind: 'throw',
      error: new Error('Claude Code returned an error result: Reached maximum number of turns (20)'),
    });
    expect((await runReadOnlyAgentSdk(fakeInput())).stop).toBe('turns_exhausted');
  });

  it('does not read an unrelated error that mentions turns as a limit', async () => {
    sdk.actions.push({
      kind: 'throw',
      error: Object.assign(new Error('upstream 502: Reached maximum number of turns proxy page'), { status: 502 }),
    });
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({ stop: 'api_error', apiErrorStatus: 502 });
  });

  it('treats the structured-output retry limit as an api_error with its text', async () => {
    sdk.actions.push({ kind: 'result', subtype: 'error_max_structured_output_retries' });
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({
      stop: 'api_error', apiErrorDetail: 'query failed',
    });
  });

  it('does not let a successful result shield a later transport failure', async () => {
    sdk.actions.push(
      { kind: 'result', subtype: 'success' },
      { kind: 'throw', error: Object.assign(new Error('stream died'), { status: 529 }) },
    );
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({ stop: 'api_error', apiErrorStatus: 529 });
  });

  it('does not let a truncated assistant turn hide a real transport failure', async () => {
    sdk.actions.push(
      { kind: 'assistant', text: 'partial', stopReason: 'max_tokens' },
      { kind: 'throw', error: Object.assign(new Error('stream died'), { status: 529 }) },
    );
    expect(await runReadOnlyAgentSdk(fakeInput())).toMatchObject({ stop: 'api_error', apiErrorStatus: 529 });
  });

  it('lets a dead machine win over a failing query, because the job must retry', async () => {
    const reader = fakeReader();
    reader.readFile.mockRejectedValue(new MachineUnavailableError('gone', 'gone'));
    sdk.actions.push(
      { kind: 'call', name: 'read_file', input: { path: 'src/a.ts' } },
      { kind: 'throw', error: new Error('stream died') },
    );
    await expect(runReadOnlyAgentSdk(fakeInput({ reader })))
      .rejects.toBeInstanceOf(MachineUnavailableError);
    expect(sdk.returned).toHaveBeenCalled();
  });
});

describe('the subprocess environment', () => {
  it('hands over no worker secret it was not asked for', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_worker_secret';
    process.env['DATABASE_URL'] = 'postgres://u:p@h/db';
    try {
      const env = buildQueryOptions(fakeInput()).env ?? {};
      expect(env['ANTHROPIC_API_KEY']).toBe('test-key');
      expect(env['GITHUB_TOKEN']).toBeUndefined();
      expect(env['DATABASE_URL']).toBeUndefined();
    } finally {
      delete process.env['GITHUB_TOKEN'];
      delete process.env['DATABASE_URL'];
    }
  });

  it('denies the built-in shell and filesystem tools by name, not only by omission', () => {
    const denied = buildQueryOptions(fakeInput()).disallowedTools ?? [];
    for (const builtin of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'ToolSearch']) {
      expect(denied).toContain(builtin);
    }
  });
});

import { capturedRun } from '../../__tests__/helpers/run-log-memory-sink.js';

describe('SDK read-only agent run logging', () => {
  it('continues the SDK stream when a transcript adapter fails', async () => {
    sdk.actions.push(
      { kind: 'assistant', id: 'm1', text: 'done' },
      { kind: 'call', name: 'submit', input: { answer: 'done' } },
      { kind: 'result', numTurns: 2 },
    );
    const adapter = vi.spyOn(SdkStreamTranscriber.prototype, 'push').mockImplementationOnce(() => {
      throw new Error('adapter failure');
    });
    try {
      const recorded = capturedRun();
      const result = await runReadOnlyAgentSdk(fakeInput(), recorded.run);
      expect(result.stop).toBe('terminal');
      expect(result.terminalInput).toEqual({ answer: 'done' });
    } finally {
      adapter.mockRestore();
    }
  });

  it('logs one response per message, tool results by id in arrival order, and fallback usage', async () => {
    sdk.actions.push(
      { kind: 'assistant', id: 'm1', requestId: 'req_1', toolUses: [{ id: 'tu_a', name: 'mcp__repo__read_file', input: { path: 'src/a.ts' } }] },
      { kind: 'assistant', id: 'm1', stopReason: 'tool_use', toolUses: [{ id: 'tu_b', name: 'mcp__repo__read_file', input: { path: 'src/b.ts' } }] },
      { kind: 'user', results: [{ id: 'tu_b', text: 'B' }, { id: 'tu_a', text: 'A' }] },
      { kind: 'call', name: 'submit', input: { answer: 'done' } },
      { kind: 'result', usage: { input_tokens: 500, output_tokens: 50 }, numTurns: 3 },
    );
    const recorded = capturedRun();
    const result = await runReadOnlyAgentSdk(fakeInput(), recorded.run);

    expect(result.stop).toBe('terminal');
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.events.map((event) => event.type)).toEqual(['response', 'tool_call', 'tool_call', 'tool_result', 'tool_result', 'sdk_message']);
    expect(recorded.events[0]).toMatchObject({ type: 'response', messageId: 'm1', requestId: 'req_1', stopReason: 'tool_use' });
    expect(recorded.events.slice(3, 5)).toMatchObject([
      { type: 'tool_result', id: 'tu_b', name: 'mcp__repo__read_file', output: 'B' },
      { type: 'tool_result', id: 'tu_a', name: 'mcp__repo__read_file', output: 'A' },
    ]);
    expect(recorded.usage).toEqual({ 'claude-sonnet-4-6': { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 } });
  });

  it('prefers the result modelUsage, keyed by the models that actually ran', async () => {
    sdk.actions.push(
      { kind: 'assistant', id: 'm1', model: 'claude-sonnet-4-6-20260101', text: 'x' },
      { kind: 'call', name: 'read_file', input: { path: 'src/a.ts' } },
      { kind: 'call', name: 'submit', input: { answer: 'done' } },
      { kind: 'result', modelUsage: {
        'claude-sonnet-4-6-20260101': { inputTokens: 90, outputTokens: 9, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 },
        'claude-haiku-4-5-20251001': { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } },
    );
    const recorded = capturedRun();
    await runReadOnlyAgentSdk(fakeInput(), recorded.run);
    expect(recorded.usage).toEqual({
      'claude-sonnet-4-6-20260101': { input: 90, output: 9, cacheRead: 1, cacheWrite: 2 },
      'claude-haiku-4-5-20251001': { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('logs a rejected terminal submission as a validator rejection', async () => {
    sdk.actions.push(
      { kind: 'call', name: 'read_file', input: { path: 'src/a.ts' } },
      { kind: 'call', name: 'submit', input: { answer: 'first' } },
      { kind: 'call', name: 'submit', input: { answer: 'second' } },
      { kind: 'result' },
    );
    const validateTerminal = vi.fn()
      .mockReturnValueOnce({ ok: false, feedback: 'cite a file you read' })
      .mockReturnValue({ ok: true });
    const recorded = capturedRun();
    await runReadOnlyAgentSdk(fakeInput({ validateTerminal }), recorded.run);
    expect(recorded.events.find((event) => event.type === 'validator_rejection')).toEqual({
      type: 'validator_rejection', message: 'cite a file you read', payload: { answer: 'first' },
    });
  });

  it('logs the exception the runner converts into an api_error stop', async () => {
    sdk.actions.push({ kind: 'assistant', id: 'm1', text: 'x' }, { kind: 'throw', error: new Error('socket hang up') });
    const recorded = capturedRun();
    const result = await runReadOnlyAgentSdk(fakeInput(), recorded.run);
    expect(result.stop).toBe('api_error');
    expect(recorded.events.map((event) => event.type)).toEqual(['response', 'error']);
    expect(recorded.events[1]).toMatchObject({ type: 'error', errorClass: 'Error', message: 'socket hang up' });
  });

  it('flushes the transcript and usage before rethrowing machine loss', async () => {
    sdk.actions.push({ kind: 'assistant', id: 'm1', text: 'x' }, { kind: 'call', name: 'read_file', input: { path: 'a' } });
    const reader = fakeReader();
    reader.readFile.mockRejectedValueOnce(new MachineUnavailableError('gone', 'gone'));
    const recorded = capturedRun();
    await expect(runReadOnlyAgentSdk(fakeInput({ reader }), recorded.run)).rejects.toThrow(MachineUnavailableError);
    expect(recorded.events.some((event) => event.type === 'response')).toBe(true);
    expect(recorded.usage).toEqual({ 'claude-sonnet-4-6': { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } });
  });
});
