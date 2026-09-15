import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../harness/sdk-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/sdk-agent.js')>()),
  runReadOnlyAgentSdk: vi.fn(async () => ({
    stop: 'terminal', terminalInput: { decision: 'investigate' }, filesRead: ['src/a.ts'], lastModelText: '', costUsd: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  })),
}));

import { askInquiryModel, buildInquiryPrompt } from '../inquiry/job.js';
import type { RepositoryRef } from '@opslane/agent-runs';
import { askModelForClaims, buildProductContextPrompt, type DiscoveredRoute } from '../product-context/job.js';
import type { EvidenceBundle } from '../evidence/bundle.js';
import { setRunLogDepsForTests } from '../run-logs/handle.js';
import { memoryRunLogDeps } from './helpers/run-log-memory-sink.js';

const context = {
  jobId: '11111111-1111-4111-8111-111111111111', jobType: 'issue_inquiry', projectId: 'p1', attempts: 0,
  leaseGeneration: '2', errorGroupId: null, ticketId: null, episodeId: '33333333-3333-4333-8333-333333333333', batchId: null, sessionId: null,
};
const reader = { readFile: async () => 'x', grep: async () => '', list: async () => '', exists: async (paths: string[]) => paths };

afterEach(() => {
  setRunLogDepsForTests(null);
  delete process.env['ANTHROPIC_API_KEY'];
});

describe('inquiry and product context run logs rebuild', () => {
  it('rebuilds the inquiry first message from the logged evidence', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'k';
    const memory = memoryRunLogDeps();
    setRunLogDepsForTests(memory.deps);
    const evidence = { affectedUnits: 3, relatedCandidates: [], productContext: [] } as unknown as EvidenceBundle;
    await askInquiryModel({ evidence, reader, signal: new AbortController().signal, runContext: context, repository: { provider: 'github', fullName: 'acme/web', commitSha: 'abcdef1' } });
    const bundle = memory.bundle();
    expect((bundle.request as { firstMessage: string }).firstMessage).toBe(buildInquiryPrompt(bundle.structuredInput as EvidenceBundle));
    expect(bundle.settings).toMatchObject({ maxTurns: 12, budgetUsd: 0.35, commandEnabled: false });
    expect(bundle.repository).toEqual({ provider: 'github', fullName: 'acme/web', commitSha: 'abcdef1' });
    expect(memory.started[0]).toMatchObject({ phase: 'inquiry', episodeId: context.episodeId, commitSha: 'abcdef1' });
  });

  it('rebuilds the product context first message from the logged routes', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'k';
    const memory = memoryRunLogDeps();
    setRunLogDepsForTests(memory.deps);
    const routes: DiscoveredRoute[] = [{ route: '/assets', clientRefs: [], serverRefs: [], declaredRequests: [] }];
    await askModelForClaims({
      reader, commandRunner: { run: async () => ({ stdout: '', exitCode: 0 }) }, routes, signal: new AbortController().signal,
      runContext: { ...context, jobType: 'route_map', episodeId: null }, commitSha: 'abcdef1',
      repository: { provider: 'github', fullName: 'acme/web', commitSha: 'abcdef1' },
    }).catch(() => undefined); // grounding of the fake terminal input may reject; the run is logged either way
    const bundle = memory.bundle();
    const structured = bundle.structuredInput as { routes: DiscoveredRoute[] };
    expect((bundle.request as { firstMessage: string }).firstMessage).toBe(buildProductContextPrompt(structured.routes));
    expect(bundle.settings).toMatchObject({ commandEnabled: true });
    expect(bundle.repository).toEqual({ provider: 'github', fullName: 'acme/web', commitSha: 'abcdef1' });
    expect(memory.started[0]).toMatchObject({ phase: 'product_context', commitSha: 'abcdef1' });
  });
});
