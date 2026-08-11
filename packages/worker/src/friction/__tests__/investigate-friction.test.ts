import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorGroupData } from '../../db.js';

const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { investigateFriction, type FrictionInvestigateInput } from '../investigate-friction.js';

const execFile = promisify(execFileCb);
const USAGE = { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let repoPath: string;

function group(): ErrorGroupData {
  return {
    id: 'g1', title: 'Rage click on save', fingerprint: 'fp', sample_event_id: '',
    occurrence_count: 1, status: 'queued', kind: 'friction',
    signal_type: 'rage_click', element_selector: '[data-testid="save"]',
    page_url_normalized: 'https://app.example.com/checkout/:id', confidence: null,
  };
}

function input(): FrictionInvestigateInput {
  return { group: group(), evidence: null, repoPath, sessionContext: null, investigatedCommit: 'commit-123' };
}

function response(content: Array<Record<string, unknown>>, usage = USAGE) {
  return { content, usage, stop_reason: 'tool_use' };
}

function tool(name: string, body: Record<string, unknown>) {
  return { type: 'tool_use', id: `${name}-${Math.random()}`, name, input: body };
}

function verdict(overrides: Record<string, unknown> = {}) {
  return tool('classify_friction', {
    codeCause: true,
    confidence: 'high',
    reason: 'The save button has no click handler.',
    remediation: 'Wire the save action.',
    evidence: [{ path: 'src/App.vue', detail: 'button has no handler', symptomLink: 'clicks do nothing' }],
    agent_task_brief: '## Symptom\nSave does nothing.\n## Change\nWire the click handler.',
    ...overrides,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  repoPath = await mkdtemp(join(tmpdir(), 'friction-investigate-'));
  await mkdir(join(repoPath, 'src'));
  await writeFile(join(repoPath, 'src', 'App.vue'), '<button>Save</button>\n');
  await execFile('git', ['init', '-q'], { cwd: repoPath });
  await execFile('git', ['add', 'src/App.vue'], { cwd: repoPath });
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe('investigateFriction', () => {
  it('returns a validated verdict with evidence, usage and cost', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(response([tool('read_file', { path: 'src/App.vue' })]))
      .mockResolvedValueOnce(response([verdict()]));

    const result = await investigateFriction('key', input());

    expect(result).toMatchObject({
      status: 'verdict',
      investigatedCommit: 'commit-123',
      verdict: { codeCause: true, evidence: [{ path: 'src/App.vue' }] },
    });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('rejects filler and absent-file citations', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(response([tool('read_file', { path: 'src/App.vue' })]))
      .mockResolvedValueOnce(response([verdict({ reason: 'placeholder' })]));
    expect(await investigateFriction('key', input())).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^filler_verdict:/),
    });

    mockMessagesCreate.mockReset();
    mockMessagesCreate
      .mockResolvedValueOnce(response([tool('read_file', { path: 'src/App.vue' })]))
      .mockResolvedValueOnce(response([verdict({ evidence: [{ path: 'src/missing.ts', detail: 'x', symptomLink: 'y' }] })]));
    expect(await investigateFriction('key', input())).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^citation_unresolvable:/),
    });
  });

  it('does not add a classification call when exploration read no file', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(response([tool('list_files', { path: '.' })]))
      .mockResolvedValueOnce(response([{ type: 'text', text: 'I cannot tell.' }]));

    const result = await investigateFriction('key', input());

    expect(result).toMatchObject({ status: 'incomplete', reason: expect.stringMatching(/^no_files_read:/) });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(mockMessagesCreate.mock.calls.every(([request]) => request.tool_choice === undefined)).toBe(true);
  });

  it.each([
    [{ codeCause: 'yes' }, 'codeCause'],
    [{ confidence: 'certain' }, 'confidence'],
  ])('degrades malformed %s input without throwing', async (overrides, _field) => {
    mockMessagesCreate
      .mockResolvedValueOnce(response([tool('read_file', { path: 'src/App.vue' })]))
      .mockResolvedValueOnce(response([verdict(overrides)]));

    await expect(investigateFriction('key', input())).resolves.toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^malformed_verdict:/),
    });
  });

  it('rethrows infrastructure failures so the poller retries', async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error('429 rate limited'));
    await expect(investigateFriction('key', input())).rejects.toThrow(/Friction investigation API call failed/);
  });

  it('maps a spend-ceiling stop to structured incomplete', async () => {
    mockMessagesCreate.mockResolvedValueOnce(response(
      [tool('list_files', { path: '.' })],
      { ...USAGE, input_tokens: 1_000_000_000 },
    ));

    await expect(investigateFriction('key', input())).resolves.toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^budget_exhausted:/),
    });
  });

  it('includes a fenced file tree in a system prompt stable across turns', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(response([tool('read_file', { path: 'src/App.vue' })]))
      .mockResolvedValueOnce(response([verdict()]));

    await investigateFriction('key', input());

    const first = mockMessagesCreate.mock.calls[0]![0];
    const second = mockMessagesCreate.mock.calls[1]![0];
    expect(JSON.stringify(first.system)).toContain('src/App.vue');
    expect(first.system).toEqual(second.system);
  });
});
