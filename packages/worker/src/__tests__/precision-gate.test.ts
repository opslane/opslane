import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineInput } from '../pipeline.js';

vi.mock('../agent-fix.js', () => ({ runAgentFix: vi.fn() }));
vi.mock('../repo-clone.js', () => ({ gitCommitAndPush: vi.fn(), validateDiffPaths: vi.fn(() => ({ valid: true })) }));
vi.mock('../pr.js', () => ({ createPR: vi.fn(), createGitHubClient: vi.fn() }));

const { runAgentFix } = await import('../agent-fix.js');
const { createPR } = await import('../pr.js');
const { gitCommitAndPush } = await import('../repo-clone.js');
const { runPipeline } = await import('../pipeline.js');

const mockRunAgentFix = vi.mocked(runAgentFix);
const mockCreatePR = vi.mocked(createPR);

function input(): PipelineInput {
  return {
    jobId: 'j', errorGroupId: 'grp-12345678', projectId: 'p', title: 'T',
    errorType: 'TypeError', errorMessage: 'm', stackTrace: 's', resolvedStackTrace: null,
    breadcrumbs: '[]', context: '{}', environmentNames: [], environmentTotal: 0, sourceFiles: [], visualAnalysis: null,
    repoPath: '/tmp/r', repoUrl: 'https://github.com/o/r.git', githubRepo: 'o/r', defaultBranch: 'main',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitCommitAndPush).mockResolvedValue(undefined as never);
  mockCreatePR.mockResolvedValue({ status: 'created', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 } as never);
});

describe('precision gate — directional invariants (C3)', () => {
  it('ABOVE floor: verified automated fix → draft PR opens', async () => {
    mockRunAgentFix.mockResolvedValue({
      status: 'fix_ready',
      diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
      confidence: 'high',
      rootCause: 'rc',
      affectedFiles: ['f'],
    });
    const r = await runPipeline(input());
    expect(r.status).toBe('pr_draft');
    expect(mockCreatePR).toHaveBeenCalledTimes(1);
    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({ draft: true }), expect.any(Function));
  });

  for (const c of ['medium', 'low'] as const) {
    it(`BELOW floor: ${c} confidence needs_human → NO PR, reason preserved`, async () => {
      mockRunAgentFix.mockResolvedValue({
        status: 'needs_human',
        diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
        confidence: c,
        rootCause: 'rc',
        reason: { reason_code: 'low_confidence_fix', reason_message: 'unverified', remediation: 'review manually' },
      });
      const r = await runPipeline(input());
      expect(r.status).toBe('needs_human');
      expect(r.pr_url).toBeUndefined();
      expect(mockCreatePR).not.toHaveBeenCalled();
      expect(r.reason?.reason_code).toBe('low_confidence_fix');
      expect(r.reason?.reason_message).toBeTruthy();
      expect(r.reason?.remediation).toBeTruthy();
      expect(r.confidence).toBe(c);
    });
  }

  it('confidence does not override the fix_ready authorization result', async () => {
    mockRunAgentFix.mockResolvedValue({
      status: 'fix_ready',
      diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
      confidence: 'medium',
      rootCause: 'rc',
      affectedFiles: ['f'],
    });
    const r = await runPipeline(input());
    expect(r.status).toBe('pr_draft');
    expect(mockCreatePR).toHaveBeenCalledTimes(1);
  });

  it('needs_human preserves the candidate diff and evidence for persistence', async () => {
    const diff = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n';
    mockRunAgentFix.mockResolvedValue({
      status: 'needs_human',
      diff,
      confidence: 'medium',
      rootCause: 'rc',
      reason: { reason_code: 'low_confidence_fix', reason_message: 'm', remediation: 'r' },
      evidence: { version: 1, tier: 'E0', checks: [] },
    });
    const r = await runPipeline(input());
    expect(r.status).toBe('needs_human');
    expect(r.candidateDiff).toBe(diff);
    expect(r.evidence?.tier).toBe('E0');
  });

  it('a draft delivery preserves diff + evidence', async () => {
    mockRunAgentFix.mockResolvedValue({
      status: 'fix_ready',
      diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
      confidence: 'medium',
      rootCause: 'rc',
      evidence: { version: 1, tier: 'E1', checks: [] },
    });
    const r = await runPipeline(input());
    expect(r.status).toBe('pr_draft');
    expect(r.candidateDiff).toBeTruthy();
    expect(r.evidence?.tier).toBe('E1');
  });
});
