import { describe, expect, it, vi } from 'vitest';
import type { ClaimedJob } from '../db.js';
import type { EvidenceBundle } from '../evidence/bundle.js';
import { evidenceSignature, runInquiry, type InquiryPersistInput } from '../inquiry/job.js';
import { inquiryDecisionTerminalTool, parseInquiryDecision } from '../inquiry/schema.js';

const evidence: EvidenceBundle = {
  frames: {
    sourceEventId: 'event-1',
    status: 'resolved',
    resolverVersion: 2,
    envelope: { version: 2, frames: [] },
    commitSha: 'abc123',
  },
  failedRequests: [],
  writeRollups: [],
  productContext: [],
  replayPointers: [],
  availability: { recording: 'missing', sourceMap: 'resolved' },
  affectedUnits: 3,
  relatedCandidates: [{ issueId: '00000000-0000-4000-8000-000000000002', title: 'Related', route: '/assets' }],
};

const job = {
  id: 'job-1',
  workerId: 'worker-1',
  errorGroupId: '00000000-0000-4000-8000-000000000001',
  eventId: null,
  episodeId: '00000000-0000-4000-8000-000000000003',
  sourceId: null,
  projectId: '00000000-0000-4000-8000-000000000004',
  jobType: 'issue_inquiry',
  attempts: 0,
  guidance: null,
  leaseGeneration: '1',
  triggeredBy: 'auto',
  sessionId: null,
} satisfies ClaimedJob;

describe('issue inquiry', () => {
  it('records an investigate decision through the persist seam', async () => {
    const persist = vi.fn(async (_input: InquiryPersistInput) => true);

    const decision = await runInquiry(job, new AbortController().signal, {
      loadEvidence: async () => evidence,
      prepareRepository: async () => ({
        reader: { readFile: async () => '', grep: async () => '', list: async () => '', exists: async () => [] },
        cleanup: async () => undefined,
      }),
      askModel: async () => ({
        raw: { decision: 'investigate', reason: 'real failed write', brief: 'check delete path' },
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.001,
      }),
      persist,
      recordUsage: async () => undefined,
    });

    expect(decision).toEqual({
      decision: 'investigate',
      reason: 'real failed write',
      brief: 'check delete path',
      relatedIssues: [],
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      decision: 'investigate',
      affectedUnits: 3,
      projectId: job.projectId,
      episodeId: job.episodeId,
    });
  });

  it('stores do_not_pursue and creates no work itself', async () => {
    const persisted: unknown[] = [];
    const decision = await runInquiry(job, new AbortController().signal, {
      loadEvidence: async () => evidence,
      prepareRepository: async () => ({
        reader: { readFile: async () => '', grep: async () => '', list: async () => '', exists: async () => [] },
        cleanup: async () => undefined,
      }),
      askModel: async () => ({
        raw: { decision: 'do_not_pursue', reason: 'browser extension noise' },
        usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.001,
      }),
      persist: async (input) => { persisted.push(input); return true; },
      recordUsage: async () => undefined,
    });

    expect(decision).toEqual({
      decision: 'do_not_pursue',
      reason: 'browser extension noise',
      relatedIssues: [],
    });
    expect(persisted).toHaveLength(1);
  });

  it('fails silent or invalid model output without storing a decision', async () => {
    const persist = vi.fn(async () => true);
    await expect(runInquiry(job, new AbortController().signal, {
      loadEvidence: async () => evidence,
      prepareRepository: async () => ({
        reader: { readFile: async () => '', grep: async () => '', list: async () => '', exists: async () => [] },
        cleanup: async () => undefined,
      }),
      askModel: async () => ({
        raw: { reason: 'no decision field' },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
      }),
      persist,
      recordUsage: async () => undefined,
    })).rejects.toThrow(/decision/);
    expect(persist).not.toHaveBeenCalled();
  });

  it('cites only issue IDs supplied in the evidence', () => {
    expect(() => parseInquiryDecision({
      decision: 'investigate', reason: 'related defect', related_issues: ['not-a-supplied-id'],
    }, new Set(evidence.relatedCandidates.map((candidate) => candidate.issueId))))
      .toThrow(/unknown issue/);
  });

  it('exposes a strict terminal schema and rejects extra fields', () => {
    expect(inquiryDecisionTerminalTool()).toMatchObject({
      strict: true,
      input_schema: { additionalProperties: false, required: ['decision', 'reason'] },
    });
    expect(() => parseInquiryDecision({
      decision: 'investigate', reason: 'r', confidence: 1,
    }, new Set())).toThrow(/unknown field/);
  });

  it('signs canonical evidence independently of object key insertion order', () => {
    const { relatedCandidates, ...rest } = evidence;
    const reordered = { relatedCandidates, ...rest };
    expect(evidenceSignature(reordered)).toBe(evidenceSignature(evidence));
  });
});
