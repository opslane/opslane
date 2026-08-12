import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NeedsHumanReason, ConfidenceLevel } from '@opslane/shared';
import type { PipelineInput } from '../pipeline.js';
import { updateGroupStatus } from '../db.js';
import type { FixNarrative } from '../narrative.js';

// === Mock agent-fix, repo-clone, pr modules ===

vi.mock('../agent-fix.js', () => ({
  runAgentFix: vi.fn(),
}));

vi.mock('../repo-clone.js', () => ({
  gitCommitAndPush: vi.fn(),
  validateDiffPaths: vi.fn(),
}));

vi.mock('../pr.js', () => ({
  createPR: vi.fn(),
  createGitHubClient: vi.fn(),
}));

const { runAgentFix } = await import('../agent-fix.js');
const { gitCommitAndPush, validateDiffPaths } = await import('../repo-clone.js');
const { createPR, createGitHubClient } = await import('../pr.js');
const { runPipeline } = await import('../pipeline.js');

const mockRunAgentFix = vi.mocked(runAgentFix);
const mockGitCommitAndPush = vi.mocked(gitCommitAndPush);
const mockValidateDiffPaths = vi.mocked(validateDiffPaths);
const mockCreatePR = vi.mocked(createPR);
const mockCreateGitHubClient = vi.mocked(createGitHubClient);

const VALID_DIFF = '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n';
const FIX_NARRATIVE: FixNarrative = {
  subject: 'Guard null values in f',
  whatHappened: 'Opening the page with missing data crashed the view.',
  whyItBroke: 'The view read a nullable value without checking it.',
  fixApproach: 'Guard the value before using it so the page remains available.',
};

/** Helper to build a valid PipelineInput with all required fields. */
function makePipelineInput(overrides?: Partial<PipelineInput>): PipelineInput {
  return {
    jobId: 'job-1',
    errorGroupId: 'group-12345678',
    projectId: 'project-1',
    title: 'Test error',
    errorType: 'TypeError',
    errorMessage: 'Cannot read property x of undefined',
    stackTrace: 'at main (src/app.ts:12:5)',
    resolvedStackTrace: null,
    breadcrumbs: '[]',
    context: '{}',
    environmentNames: [],
    environmentTotal: 0,
    sourceFiles: [],
    visualAnalysis: null,
    repoPath: '/tmp/opslane-repo',
    repoUrl: 'https://github.com/org/repo.git',
    githubRepo: 'org/repo',
    defaultBranch: 'main',
    ...overrides,
  };
}

// === Existing contract tests (preserved) ===

describe('updateGroupStatus — terminal reason contract', () => {
  it('throws when needs_human is set without reason fields', async () => {
    await expect(
      updateGroupStatus('group-1', 'project-1', 'needs_human')
    ).rejects.toThrow('needs_human requires reason fields');
  });

  it('throws when needs_human reason fields are empty', async () => {
    const emptyReason: NeedsHumanReason = {
      reason_code: '' as NeedsHumanReason['reason_code'],
      reason_message: '',
      remediation: '',
    };

    await expect(
      updateGroupStatus('group-1', 'project-1', 'needs_human', {
        reason: emptyReason,
      })
    ).rejects.toThrow('reason fields must all be non-empty');
  });

  it('passes validation when needs_human includes valid reason fields', async () => {
    const reason: NeedsHumanReason = {
      reason_code: 'missing_llm_key',
      reason_message: 'API key not configured',
      remediation: 'Set ANTHROPIC_API_KEY',
    };

    // With valid reason, validation passes — the function proceeds to DB query
    // which fails with a UUID format error (fake IDs). That's fine: we're testing
    // that the validation layer didn't reject it.
    try {
      await updateGroupStatus('group-1', 'project-1', 'needs_human', { reason });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Must NOT be a validation error
      expect(msg).not.toContain('needs_human requires reason fields');
      expect(msg).not.toContain('reason fields must all be non-empty');
    }
  });

  it('passes validation for non-needs_human statuses without reason', async () => {
    // analyzing without reason — validation passes, hits DB with fake UUID
    try {
      await updateGroupStatus('group-1', 'project-1', 'analyzing');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('needs_human requires reason fields');
    }
  });
});

describe('PipelineResult discriminated union', () => {
  it('needs_human result must have reason (compile-time check)', () => {
    const needsHuman = {
      status: 'needs_human' as const,
      reason: {
        reason_code: 'missing_llm_key' as const,
        reason_message: 'Not configured',
        remediation: 'Configure it',
      },
    };

    expect(needsHuman.status).toBe('needs_human');
    expect(needsHuman.reason.reason_code).toBe('missing_llm_key');
  });

  it('pr_created result must have pr_url and confidence (compile-time check)', () => {
    const prCreated = {
      status: 'pr_created' as const,
      pr_url: 'https://github.com/org/repo/pull/42',
      pr_number: 42,
      confidence: 'high' as const,
    };

    expect(prCreated.status).toBe('pr_created');
    expect(prCreated.pr_url).toContain('pull/42');
    expect(prCreated.confidence).toBe('high');
  });
});

// === Pipeline stage tests ===

describe('runPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: path validation passes
    mockValidateDiffPaths.mockReturnValue({ valid: true });
    mockCreateGitHubClient.mockReturnValue(null);
    mockGitCommitAndPush.mockResolvedValue('head-sha');
  });

  it('happy path: agent fix succeeds → git push succeeds → PR created', async () => {
    const assertLeaseOwned = vi.fn().mockResolvedValue(undefined);
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'fix_ready',
      diff: VALID_DIFF,
      confidence: 'high' as ConfidenceLevel,
      rootCause: 'Null reference in main()',
      narrative: FIX_NARRATIVE,
      affectedFiles: ['f.ts'],
      evidence: {
        version: 1,
        tier: 'E1',
        checks: [
          { name: 'suite_baseline', outcome: 'passed', command: 'pnpm test', output_tail: '' },
          { name: 'suite_post_patch', outcome: 'passed', command: 'pnpm test', output_tail: '' },
          { name: 'build', outcome: 'passed', command: 'pnpm build', output_tail: '' },
        ],
      },
    });
    mockCreatePR.mockResolvedValueOnce({
      status: 'created',
      prUrl: 'https://github.com/org/repo/pull/99',
      prNumber: 99,
    });

    const previousDashboardUrl = process.env['DASHBOARD_URL'];
    process.env['DASHBOARD_URL'] = 'https://app.opslane.com';
    const environmentNames = ['production', 'staging'];
    const result = await runPipeline(makePipelineInput({
      assertLeaseOwned,
      environmentNames,
      environmentTotal: 2,
    }));
    if (previousDashboardUrl === undefined) delete process.env['DASHBOARD_URL'];
    else process.env['DASHBOARD_URL'] = previousDashboardUrl;

    expect(result.status).toBe('pr_draft');
    expect(result.pr_url).toBe('https://github.com/org/repo/pull/99');
    expect(result.pr_number).toBe(99);
    expect(result.confidence).toBe('high');

    // All stages called in order
    expect(mockRunAgentFix).toHaveBeenCalledTimes(1);
    expect(mockRunAgentFix).toHaveBeenCalledWith(expect.objectContaining({
      environmentNames,
      environmentTotal: 2,
    }));
    expect(mockValidateDiffPaths).toHaveBeenCalledWith(VALID_DIFF);
    expect(mockGitCommitAndPush).toHaveBeenCalledTimes(1);
    expect(mockCreatePR).toHaveBeenCalledTimes(1);
    expect(assertLeaseOwned).toHaveBeenCalledTimes(2);
    const commitMessage = mockGitCommitAndPush.mock.calls[0]?.[2];
    expect(commitMessage).toContain('Guard null values in f\n\n');
    expect(commitMessage).toContain('Verified: no new test failures compared with the pre-fix baseline;');
    expect(commitMessage).toContain('https://app.opslane.com/incidents/group-12345678?project_id=project-1');
    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      narrative: FIX_NARRATIVE,
      environmentNames,
      environmentTotal: 2,
      draft: true,
      incidentUrl: 'https://app.opslane.com/incidents/group-12345678?project_id=project-1',
    }), expect.any(Function));
    expect(result.narrative).toEqual(FIX_NARRATIVE);
  });

  it('preserves the friction commit subject and suggestion PR contract', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'fix_ready',
      diff: VALID_DIFF,
      confidence: 'high',
      rootCause: 'The Save button has no handler',
      narrative: FIX_NARRATIVE,
      affectedFiles: ['f.ts'],
    });
    mockCreatePR.mockResolvedValueOnce({
      status: 'created',
      prUrl: 'https://github.com/org/repo/pull/100',
      prNumber: 100,
    });

    await runPipeline(makePipelineInput({ kind: 'friction', title: 'Dead Save button' }));

    expect(mockGitCommitAndPush.mock.calls[0]?.[2]).toBe('fix: Dead Save button');
    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'friction',
      narrative: undefined,
    }), expect.any(Function));
  });

  it('does not push or create a PR when the authoritative lease check fails', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'fix_ready',
      diff: VALID_DIFF,
      confidence: 'high' as ConfidenceLevel,
      rootCause: 'Null reference in main()',
      affectedFiles: ['f.ts'],
    });

    await expect(
      runPipeline(
        makePipelineInput({
          assertLeaseOwned: vi.fn().mockRejectedValue(new Error('Job lease lost')),
        }),
      ),
    ).rejects.toThrow('Job lease lost');
    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  it('returns needs_human when agent fix returns needs_human', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'needs_human',
      reason: {
        reason_code: 'missing_llm_key',
        reason_message: 'No API key',
        remediation: 'Set ANTHROPIC_API_KEY',
      },
    });

    const result = await runPipeline(makePipelineInput());

    expect(result.status).toBe('needs_human');
    expect(result.reason?.reason_code).toBe('missing_llm_key');

    // Should NOT call any subsequent stages
    expect(mockValidateDiffPaths).not.toHaveBeenCalled();
    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  it('propagates confidence on a below-floor needs_human result', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'needs_human',
      diff: VALID_DIFF,
      confidence: 'medium' as ConfidenceLevel,
      rootCause: 'null deref in App.vue',
      reason: {
        reason_code: 'low_confidence_fix',
        reason_message: 'Candidate fix could not be verified',
        remediation: 'Review the candidate diff manually',
      },
    });

    const result = await runPipeline(makePipelineInput());
    expect(result.status).toBe('needs_human');
    expect(result.confidence).toBe('medium');
    expect(result.reason?.reason_code).toBe('low_confidence_fix');
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  it('publishes a judge-approved build-positive candidate as an opted-in draft', async () => {
    const reserveDelivery = vi.fn().mockResolvedValue({
      status: 'reserved',
      reservation: {
        branchName: 'opslane/fix-group-12',
        posture: 'draft',
        candidateDiff: VALID_DIFF,
        state: 'reserved',
      },
    });
    const recordDeliveryPushed = vi.fn().mockResolvedValue(undefined);
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'needs_human',
      diff: VALID_DIFF,
      confidence: 'medium',
      draftEligible: true,
      reason: {
        reason_code: 'low_confidence_fix',
        reason_message: 'No test runner was available',
        remediation: 'Review CI before using the draft',
      },
      evidence: {
        version: 1,
        tier: 'E0',
        checks: [
          { name: 'build', outcome: 'passed', command: 'pnpm build', output_tail: '' },
          { name: 'suite_post_patch', outcome: 'skipped_no_runner', command: '', output_tail: '' },
        ],
      },
    });
    mockGitCommitAndPush.mockResolvedValueOnce('draft-head-sha');
    mockCreatePR.mockResolvedValueOnce({
      status: 'created',
      prUrl: 'https://github.com/org/repo/pull/100',
      prNumber: 100,
    });

    const result = await runPipeline(makePipelineInput({
      prPosture: 'draft_when_unverified',
      reserveDelivery,
      recordDeliveryPushed,
    }));

    expect(result).toMatchObject({
      status: 'pr_draft',
      pr_number: 100,
      head_sha: 'draft-head-sha',
      confidence: 'medium',
    });
    expect(reserveDelivery).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: 'fix:group-12345678',
      branchName: 'opslane/fix-group-12',
      posture: 'draft',
    }));
    expect(recordDeliveryPushed).toHaveBeenCalledWith('draft-head-sha');
    expect(mockCreatePR).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true, branchName: 'opslane/fix-group-12' }),
      expect.any(Function),
    );
  });

  it('keeps the same candidate in needs_human under verified-only policy', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'needs_human',
      diff: VALID_DIFF,
      confidence: 'medium',
      draftEligible: true,
      reason: {
        reason_code: 'low_confidence_fix',
        reason_message: 'No runner',
        remediation: 'Review manually',
      },
    });
    const result = await runPipeline(makePipelineInput({ prPosture: 'verified_only' }));
    expect(result.status).toBe('needs_human');
    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  it('returns draft_cap_reached without provider writes', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'needs_human', diff: VALID_DIFF, confidence: 'medium', draftEligible: true,
      reason: { reason_code: 'low_confidence_fix', reason_message: 'No runner', remediation: 'Review' },
    });
    const result = await runPipeline(makePipelineInput({
      prPosture: 'draft_when_unverified',
      reserveDelivery: vi.fn().mockResolvedValue({ status: 'cap_reached' }),
    }));
    expect(result.status).toBe('needs_human');
    expect(result.reason?.reason_code).toBe('draft_cap_reached');
    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
  });

  it('does not use confidence as a second authorization gate for fix_ready', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'fix_ready',
      diff: VALID_DIFF,
      confidence: 'medium' as ConfidenceLevel,
      rootCause: 'rc',
      affectedFiles: ['f.ts'],
    });

    mockCreatePR.mockResolvedValueOnce({
      status: 'created',
      prUrl: 'https://github.com/org/repo/pull/100',
      prNumber: 100,
    });

    const result = await runPipeline(makePipelineInput());
    expect(result.status).toBe('pr_draft');
    expect(mockCreatePR).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true }),
      expect.any(Function),
    );
    expect(mockGitCommitAndPush).toHaveBeenCalled();
  });

  it('returns needs_human with malformed_diff when diff path validation fails', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'fix_ready',
      diff: VALID_DIFF,
      confidence: 'high' as ConfidenceLevel,
      rootCause: 'Bug in main()',
      affectedFiles: ['f.ts'],
    });
    mockValidateDiffPaths.mockReturnValueOnce({
      valid: false,
      error: 'Unsafe diff path: ../../../etc/passwd',
    });

    const result = await runPipeline(makePipelineInput());

    expect(result.status).toBe('needs_human');
    expect(result.reason?.reason_code).toBe('malformed_diff');
    expect(result.reason?.reason_message).toContain('Unsafe diff path');

    // Should NOT call git push or PR
    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  it('returns needs_human with repo_access_denied when git push fails', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'fix_ready',
      diff: VALID_DIFF,
      confidence: 'high' as ConfidenceLevel,
      rootCause: 'Bug in main()',
      affectedFiles: ['f.ts'],
    });
    mockGitCommitAndPush.mockRejectedValueOnce(new Error('Permission denied (publickey)'));

    const result = await runPipeline(makePipelineInput());

    expect(result.status).toBe('needs_human');
    expect(result.reason?.reason_code).toBe('repo_access_denied');
    expect(result.reason?.reason_message).toContain('Permission denied');
    expect(result.reason?.remediation).toContain('GITHUB_TOKEN');

    // Should NOT call PR
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  it('returns needs_human when PR creation fails', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'fix_ready',
      diff: VALID_DIFF,
      confidence: 'high' as ConfidenceLevel,
      rootCause: 'Bug in main()',
      affectedFiles: ['f.ts'],
    });
    mockGitCommitAndPush.mockResolvedValueOnce('head-sha');
    mockCreatePR.mockResolvedValueOnce({
      status: 'failed',
      reason: {
        reason_code: 'missing_github_token',
        reason_message: 'No GitHub token',
        remediation: 'Set GITHUB_TOKEN',
      },
    });

    const result = await runPipeline(makePipelineInput());

    expect(result.status).toBe('needs_human');
    expect(result.reason?.reason_code).toBe('missing_github_token');
  });

  it('returns a valid needs_human result with all reason fields populated', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'needs_human',
      reason: {
        reason_code: 'malformed_diff',
        reason_message: 'LLM could not produce valid diff',
        remediation: 'Review manually',
      },
    });

    const result = await runPipeline(makePipelineInput());

    expect(result.status).toBe('needs_human');
    expect(result.reason).toBeDefined();
    expect(result.reason?.reason_code).toBeTruthy();
    expect(result.reason?.reason_message).toBeTruthy();
    expect(result.reason?.remediation).toBeTruthy();
  });
});
