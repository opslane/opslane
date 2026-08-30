import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured: Array<Record<string, unknown>> = [];
const scripted: Array<Record<string, unknown>> = [];
const mockCreate = vi.fn(async (request: Record<string, unknown>) => {
  captured.push(structuredClone(request));
  const response = scripted.shift();
  if (!response) throw new Error('missing scripted response');
  return response;
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}));

import { createHostReader } from '../harness/host-reader.js';
import { runReadOnlyAgent, type ReadOnlyRunInput } from '../readonly-agent.js';

const USAGE = {
  input_tokens: 1_000,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const terminalTool = {
  name: 'finish',
  description: 'Submit the result.',
  input_schema: { type: 'object' as const, properties: {} },
};

function response(content: Array<Record<string, unknown>>, stopReason = 'tool_use'): Record<string, unknown> {
  return { content, usage: USAGE, stop_reason: stopReason };
}

function tool(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'tool_use', id: `${name}-${Math.random()}`, name, input };
}

let repoPath: string;

function input(overrides: Partial<ReadOnlyRunInput> = {}): ReadOnlyRunInput {
  return {
    apiKey: 'test',
    model: 'test-model',
    maxTurns: 1,
    budgetUsd: 10,
    pricing: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 },
    systemPrompt: 'Stable system prompt',
    firstMessage: 'Investigate.',
    terminalTool,
    reader: createHostReader(repoPath),
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  captured.splice(0);
  scripted.splice(0);
  repoPath = await mkdtemp(join(tmpdir(), 'readonly-classification-'));
  await writeFile(join(repoPath, 'a.ts'), 'export const a = 1;\n');
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe('read-only classification phase', () => {
  it('adds one forced classification call after evidence-gathering turns', async () => {
    scripted.push(
      response([tool('read_file', { path: 'a.ts' })]),
      response([tool('finish', { result: 'done' })]),
    );

    const result = await runReadOnlyAgent(input({ classification: { minFilesRead: 1 } }));

    expect(result.stop).toBe('terminal');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(captured[1]?.['tool_choice']).toEqual({ type: 'tool', name: 'finish' });
  });

  it('skips all calls when zero turns cannot meet the evidence gate', async () => {
    const result = await runReadOnlyAgent(input({
      maxTurns: 0,
      classification: { minFilesRead: 1 },
    }));

    expect(result.stop).toBe('no_evidence');
    expect(result.filesRead).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not classify after list-only exploration', async () => {
    scripted.push(response([tool('list_files', { path: '.' })]));

    const result = await runReadOnlyAgent(input({ classification: { minFilesRead: 1 } }));

    expect(result.stop).toBe('no_evidence');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('preserves the legacy final-turn forcing when classification is absent', async () => {
    scripted.push(response([tool('finish', { result: 'done' })]));

    await runReadOnlyAgent(input());

    expect(captured).toHaveLength(1);
    expect(captured[0]?.['tool_choice']).toEqual({ type: 'tool', name: 'finish' });
  });

  it('does not force or nudge the terminal tool during exploration', async () => {
    scripted.push(
      response([tool('read_file', { path: 'a.ts' })]),
      response([tool('search', { pattern: 'a' })]),
      response([tool('list_files', { path: '.' })]),
      response([tool('finish', { result: 'done' })]),
    );

    await runReadOnlyAgent(input({ maxTurns: 3, classification: { minFilesRead: 1 } }));

    expect(captured).toHaveLength(4);
    for (const request of captured.slice(0, 3)) {
      expect(request['tool_choice']).toBeUndefined();
      expect(JSON.stringify(request['messages'])).not.toContain('Call finish now');
    }
  });

  it('includes the truncated call usage in cost', async () => {
    scripted.push(response([], 'max_tokens'));

    const result = await runReadOnlyAgent(input());

    expect(result.stop).toBe('truncated');
    expect(result.costUsd).toBe(0.0011);
  });

  it('keeps the system and prior conversation prefix stable across calls', async () => {
    scripted.push(
      response([tool('read_file', { path: 'a.ts' })]),
      response([tool('search', { pattern: 'a' })]),
      response([tool('list_files', { path: '.' })]),
      response([tool('finish', { result: 'done' })]),
    );

    await runReadOnlyAgent(input({ maxTurns: 3, classification: { minFilesRead: 1 } }));

    const stripCache = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripCache);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, child]) => [key, stripCache(child)]));
      }
      return value;
    };
    for (const request of captured) expect(request['system']).toEqual(captured[0]?.['system']);
    for (let index = 1; index < 3; index++) {
      const previous = stripCache(captured[index - 1]?.['messages']) as unknown[];
      const current = stripCache(captured[index]?.['messages']) as unknown[];
      expect(current.slice(0, previous.length)).toEqual(previous);
    }
  });
});
