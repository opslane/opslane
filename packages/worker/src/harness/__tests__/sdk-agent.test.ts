import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineUnavailableError } from '../errors.js';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface FakeTool { name: string; handler: Handler }
type Action =
  | { kind: 'call'; name: string; input: Record<string, unknown> }
  | { kind: 'assistant'; id?: string; text?: string; usage?: Partial<typeof DEFAULT_USAGE> }
  | { kind: 'result'; subtype?: string; isError?: boolean };

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

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: Handler): FakeTool => ({ name, handler }),
  createSdkMcpServer: (options: unknown) => options,
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.queryOptions = options;
    const iterator = (async function* () {
      const server = (options['mcpServers'] as { repo: { tools: FakeTool[] } }).repo;
      for (const action of sdk.actions) {
        if (action.kind === 'call') {
          const selected = server.tools.find((candidate) => candidate.name === action.name);
          if (!selected) throw new Error(`missing fake tool ${action.name}`);
          await selected.handler(action.input);
        } else if (action.kind === 'assistant') {
          yield {
            type: 'assistant', uuid: 'u', session_id: 's', parent_tool_use_id: null,
            message: {
              id: action.id ?? crypto.randomUUID(), type: 'message', role: 'assistant', model: 'test-model',
              content: action.text ? [{ type: 'text', text: action.text }] : [],
              stop_reason: null, stop_sequence: null,
              usage: { ...DEFAULT_USAGE, ...action.usage },
            },
          };
        } else {
          yield action.subtype === 'success' || action.subtype === undefined
            ? {
                type: 'result', subtype: 'success', is_error: action.isError ?? false,
                result: action.isError ? 'failed' : 'done', api_error_status: action.isError ? 503 : null,
                duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null,
                total_cost_usd: 0, usage: DEFAULT_USAGE, modelUsage: {}, permission_denials: [],
                uuid: 'r', session_id: 's',
              }
            : {
                type: 'result', subtype: action.subtype, is_error: true,
                errors: ['query failed'], duration_ms: 1, duration_api_ms: 1,
                num_turns: 1, stop_reason: null, total_cost_usd: 0,
                usage: DEFAULT_USAGE, modelUsage: {}, permission_denials: [], uuid: 'r', session_id: 's',
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
});

describe('SDK read-only agent', () => {
  it('exposes only our tools, by allowlist', () => {
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
