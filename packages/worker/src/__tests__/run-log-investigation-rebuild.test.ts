import { createHash } from 'node:crypto';
import { canonicalJson } from '@opslane/agent-runs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../harness/sdk-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/sdk-agent.js')>()),
  runReadOnlyAgentSdk: vi.fn(async () => ({
    stop: 'no_tool_call', terminalInput: null, filesRead: [], lastModelText: '', costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })),
}));

import { buildInvestigationPrompt, investigateError, type InvestigateInput } from '../investigate.js';
import {
  buildFrictionInvestigationPrompt,
  investigateFriction,
  type FrictionInvestigateInput,
  type FrictionPromptInput,
} from '../friction/investigate-friction.js';
import { setRunLogDepsForTests } from '../run-logs/handle.js';
import { memoryRunLogDeps } from './helpers/run-log-memory-sink.js';

const context = {
  jobId: '11111111-1111-4111-8111-111111111111', jobType: 'investigate', projectId: 'p1', attempts: 0,
  leaseGeneration: '4', errorGroupId: '22222222-2222-4222-8222-222222222222', ticketId: null, episodeId: null, batchId: null, sessionId: null,
};
const reader = { readFile: async () => '', grep: async () => '', list: async () => '', exists: async (paths: string[]) => paths };

afterEach(() => setRunLogDepsForTests(null));

describe('investigation run logs rebuild', () => {
  it('rebuilds the error investigation request from the bundle', async () => {
    const memory = memoryRunLogDeps();
    setRunLogDepsForTests(memory.deps);
    const input: InvestigateInput = {
      platform: 'javascript', errorType: 'TypeError', title: 'x is null', errorMessage: 'Cannot read x',
      stackTrace: 'at load (src/app/load.ts:10:3)', resolvedStackTrace: null, breadcrumbs: '[]',
      sessionContext: 'clicked Save', investigationBrief: 'look at load.ts',
    };
    await investigateError('k', input, reader, 'abc1234', context, 'acme/web');

    const bundle = memory.bundle();
    const rebuilt = buildInvestigationPrompt(bundle.structuredInput as InvestigateInput, bundle.settings['maxTurns'] as number);
    const request = bundle.request as { systemPrompt: string; firstMessage: string };
    expect(canonicalJson({ systemPrompt: request.systemPrompt, firstMessage: request.firstMessage })).toBe(canonicalJson(rebuilt));
    expect(bundle.repository).toEqual({ provider: 'github', fullName: 'acme/web', commitSha: 'abc1234' });
    expect(memory.started[0]).toMatchObject({ phase: 'investigation', entryPoint: 'investigate#investigateError', commitSha: 'abc1234' });
  });

  it('rebuilds the friction investigation request from the bundle and the tree', async () => {
    const memory = memoryRunLogDeps();
    setRunLogDepsForTests(memory.deps);
    const tree = 'client/app.ts\nvue3/client/src/main.ts\n';
    const input: FrictionInvestigateInput = {
      group: { title: 'Save does nothing', signal_type: 'dead_click', element_selector: 'button.save', page_url_normalized: '/assets' } as FrictionInvestigateInput['group'],
      confirmedSignalIds: ['s1'],
      ticketDefinition: { name: 'Save', control: 'Save button', what_happened: 'nothing', kind: 'defect' },
      evidence: { signals: [{ id: 's1' }], timeline: 'L1 click Save', truncated: false } as unknown as FrictionInvestigateInput['evidence'],
      reader, tree, sessionContext: null, narrativeObservation: null, investigatedCommit: 'def4567',
      runContext: context, repositoryFullName: 'acme/web',
    };
    await investigateFriction('k', input);

    const bundle = memory.bundle();
    const structured = bundle.structuredInput as FrictionPromptInput & { tree: { commitSha: string; bytes: number; sha256: string } };
    expect(structured.tree).toEqual({ commitSha: 'def4567', bytes: tree.length, sha256: createHash('sha256').update(tree).digest('hex') });
    const { tree: _tree, ...promptInput } = structured;
    const rebuilt = buildFrictionInvestigationPrompt(promptInput, tree);
    const request = bundle.request as { systemPrompt: string; firstMessage: string };
    expect(canonicalJson({ systemPrompt: request.systemPrompt, firstMessage: request.firstMessage })).toBe(canonicalJson(rebuilt));
    expect(memory.started[0]).toMatchObject({ phase: 'investigation', entryPoint: 'friction/investigate-friction#investigateFriction' });
  });
});
