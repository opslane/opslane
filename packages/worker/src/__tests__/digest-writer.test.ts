import { describe, expect, it, vi } from 'vitest';
import {
  writeDigest,
  type DigestCandidate,
  type DigestPayload,
  type DigestWriterDependencies,
} from '../digest-writer/job.js';

function candidate(index: number, overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    episodeId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    episodeSequence: 1,
    label: 'new',
    issueId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title: `Issue ${index}`,
    outcome: 'verified_fix',
    summary: `Cause ${index}`,
    prUrl: `https://github.com/acme/shop/pull/${index}`,
    affectedUsers: index,
    accounts: [`Account ${index}`],
    lastSeen: '2026-08-20T08:00:00Z',
    decidedAt: '2026-08-20T08:30:00Z',
    ...overrides,
  };
}

function dependencies(candidates: DigestCandidate[], raw?: unknown): DigestWriterDependencies {
  return {
    loadRun: async () => ({
      id: '20000000-0000-4000-8000-000000000001',
      projectId: '30000000-0000-4000-8000-000000000001',
      status: 'frozen',
      candidates,
      payload: null,
    }),
    askModel: async () => raw ?? ({
      included: candidates.map((item) => ({
        episodeId: item.episodeId,
        copy: item.summary,
        action: 'Review the verified fix',
        claimedUsers: item.affectedUsers,
        accounts: item.accounts,
        prUrl: item.prUrl,
      })),
      deferred: [],
    }),
    persist: vi.fn(async () => true),
  };
}

describe('digest writer', () => {
  it('accounts for every candidate and persists the written payload', async () => {
    const candidates = [1, 2, 3, 4, 5].map((index) => candidate(index));
    const deps = dependencies(candidates);
    const payload = await writeDigest('run-1', 'project-1', deps);
    const seen = new Set([
      ...payload.included.map((card) => card.episodeId),
      ...payload.deferred.map((item) => item.episodeId),
    ]);
    expect(seen.size).toBe(5);
    expect(deps.persist).toHaveBeenCalledOnce();
  });

  it('rejects a card citing an episode that was not frozen', async () => {
    const deps = dependencies([candidate(1)], {
      included: [{ episodeId: 'not-frozen', copy: 'x', action: 'y' }], deferred: [],
    });
    await expect(writeDigest('run-1', 'project-1', deps)).rejects.toThrow(/unknown episode/);
  });

  it('rejects unsupported counts and account names', async () => {
    const frozen = candidate(1, { affectedUsers: 9, accounts: ['Acme'] });
    await expect(writeDigest('run-1', 'project-1', dependencies([frozen], {
      included: [{
        episodeId: frozen.episodeId, copy: '40 customers affected', action: 'Review',
        claimedUsers: 40, accounts: ['Not Acme'], prUrl: frozen.prUrl,
      }], deferred: [],
    }))).rejects.toThrow(/unsupported count/);
  });

  it('rejects invented links and omitted candidates', async () => {
    const frozen = candidate(1);
    await expect(writeDigest('run-1', 'project-1', dependencies([frozen], {
      included: [{
        episodeId: frozen.episodeId, copy: 'x', action: 'Review',
        prUrl: 'https://evil.example/pull/1',
      }], deferred: [],
    }))).rejects.toThrow(/unsupported link/);

    await expect(writeDigest('run-1', 'project-1', dependencies([frozen], {
      included: [], deferred: [],
    }))).rejects.toThrow(/neither included nor deferred/);
  });

  it('labels a second episode as returned and reuses an already written payload', async () => {
    const frozen = candidate(2, { episodeSequence: 2, label: 'returned' });
    const deps = dependencies([frozen]);
    const payload = await writeDigest('run-1', 'project-1', deps);
    expect(payload.included[0]?.label).toBe('returned');

    const stored: DigestPayload = { included: payload.included, deferred: [] };
    const replay = dependencies([frozen]);
    replay.loadRun = async () => ({
      id: 'run-1', projectId: 'project-1', status: 'written', candidates: [frozen], payload: stored,
    });
    expect(await writeDigest('run-1', 'project-1', replay)).toEqual(stored);
  });
});
