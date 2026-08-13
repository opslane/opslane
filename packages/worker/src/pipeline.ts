import { createHash } from 'node:crypto';
import type { Diagnosis, NeedsHumanReason, ConfidenceLevel, EvidenceRecord } from '@opslane/shared';
import type { VisualAnalysisOutput } from './harness/types.js';
import type { Platform } from './platform.js';
import type { RuntimeInfo } from './runtime-info.js';
import type { ReplayInput } from './pr.js';
import { runAgentFix } from './agent-fix.js';
import { createPR, createGitHubClient } from './pr.js';
import { gitCommitAndPush, validateDiffPaths } from './repo-clone.js';
import { buildReason } from './reason-codes.js';
import { logger } from './logger.js';
import { traceSpan } from './tracing.js';
import { scrubSecrets } from './harness/redact.js';
import {
  buildFallbackNarrative,
  buildIncidentUrl,
  renderCommitMessage,
  type FixNarrative,
  type StoryImpact,
} from './narrative.js';
import { createLedgerRecorder } from './verification-ledger.js';
import { insertFixRunLedger } from './db.js';

export interface PipelineInput {
  platform?: Platform;
  customerRuntime?: RuntimeInfo | null;
  jobId: string;
  usageContext?: { jobId: string; execution: number };
  errorGroupId: string;
  projectId: string;
  title: string;
  errorType: string;
  errorMessage: string;
  stackTrace: string;
  resolvedStackTrace: unknown;
  breadcrumbs: string;
  context: string;
  environmentNames: string[];
  environmentTotal: number;
  sourceFiles: Array<{ filePath: string; content: string }>;
  visualAnalysis: VisualAnalysisOutput | null;
  repoPath: string;
  repoUrl: string;
  githubRepo: string;
  defaultBranch: string;
  githubToken?: string;
  abortSignal?: AbortSignal;
  /** Authoritative lease check immediately before irreversible provider writes. */
  assertLeaseOwned?: () => Promise<void>;
  replay?: ReplayInput | null;
  kind?: 'error' | 'friction';
  /** Who created the fix job. `human` authorises it past the persisted-decision gate. */
  triggeredBy?: 'auto' | 'human' | null;
  sourceJobId?: string | null;
  frictionEvidence?: string;
  /** Pre-computed investigation results. When set, agent skips internal triage. */
  investigation?: {
    rootCause: string;
    diagnosis?: Diagnosis | null;
    guidance?: string;
  };
  prPosture?: 'verified_only' | 'draft_when_unverified';
  reserveDelivery?: (input: {
    operationKey: string;
    branchName: string;
    posture: 'ready' | 'draft';
    diffHash: string;
    candidateDiff: string;
  }) => Promise<
    | { status: 'cap_reached' }
    | { status: 'reserved'; reservation: {
        branchName: string;
        posture: 'ready' | 'draft';
        candidateDiff: string;
        state: 'reserved' | 'pushed' | 'open' | 'closed';
        headSha?: string;
        prUrl?: string;
        prNumber?: number;
      } }
  >;
  recordDeliveryPushed?: (headSha: string) => Promise<void>;
  occurrenceCount?: number | null;
  impact?: StoryImpact | null;
  watchUrl?: string | null;
}

export interface PipelineResult {
  status: 'pr_created' | 'pr_draft' | 'needs_human';
  pr_url?: string;
  pr_number?: number;
  confidence?: ConfidenceLevel;
  reason?: NeedsHumanReason;
  /** Scrubbed and bounded candidate diff preserved for manual review. */
  candidateDiff?: string;
  evidence?: EvidenceRecord;
  head_sha?: string;
  narrative?: FixNarrative;
}

const MAX_STORED_DIFF = 262_144;

function boundDiff(diff: string | undefined): string | undefined {
  if (!diff || diff.trim().length === 0) return undefined;
  const scrubbed = scrubSecrets(diff);
  return scrubbed.length > MAX_STORED_DIFF
    ? `${scrubbed.slice(0, MAX_STORED_DIFF)}\n... [truncated]`
    : scrubbed;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  // Stage 1: Agent fix (E2B sandbox + LLM tool loop)
  const ledgerRecorder = createLedgerRecorder(input.jobId, input.projectId);
  let fixResult;
  try {
    fixResult = await runAgentFix({
    errorGroupId: input.errorGroupId,
    projectId: input.projectId,
    title: input.title,
    errorType: input.errorType,
    errorMessage: input.errorMessage,
    stackTrace: input.stackTrace,
    resolvedStackTrace: input.resolvedStackTrace,
    breadcrumbs: input.breadcrumbs,
    context: input.context,
    environmentNames: input.environmentNames,
    environmentTotal: input.environmentTotal,
    sourceFiles: input.sourceFiles,
    visualAnalysis: input.visualAnalysis,
    repoUrl: input.repoUrl,
    githubRepo: input.githubRepo,
    githubToken: input.githubToken,
    repoPath: input.repoPath,
    investigation: input.investigation,
    abortSignal: input.abortSignal,
    frictionEvidence: input.frictionEvidence,
    kind: input.kind,
    triggeredBy: input.triggeredBy,
    sourceJobId: input.sourceJobId ?? null,
    platform: input.platform,
    customerRuntime: input.customerRuntime,
    usageContext: input.usageContext,
    ledgerRecorder,
    });
  } finally {
    try {
      await insertFixRunLedger(ledgerRecorder.entries());
    } catch (error: unknown) {
      logger.error('fix_run_ledger persistence failed', {
        job_id: input.jobId,
        run_id: ledgerRecorder.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const draftCandidate = fixResult.status === 'needs_human'
    && fixResult.draftEligible === true
    && input.prPosture === 'draft_when_unverified'
    && input.platform !== 'python';
  const opensPR = fixResult.status === 'fix_ready' || draftCandidate;

  if (!opensPR) {
    return {
      status: 'needs_human',
      reason: fixResult.reason,
      confidence: fixResult.confidence,
      candidateDiff: boundDiff(fixResult.diff),
      evidence: fixResult.evidence,
    };
  }

  let diff = fixResult.diff!;
  let deliveryPosture: 'ready' | 'draft' = input.triggeredBy !== 'human'
    ? 'draft'
    : draftCandidate ? 'draft' : 'ready';

  logger.info('Agent fix complete', {
    error_group_id: input.errorGroupId,
    confidence: fixResult.confidence,
    root_cause: fixResult.rootCause?.slice(0, 200),
    affected_files: fixResult.affectedFiles,
    diff_length: diff.length,
  });

  // Validate diff paths before applying to local clone
  const pathCheck = validateDiffPaths(diff);
  if (!pathCheck.valid) {
    return {
      status: 'needs_human',
      reason: {
        reason_code: 'malformed_diff',
        reason_message: pathCheck.error ?? 'Diff contains unsafe paths',
        remediation: 'Review the generated diff manually — it contains path traversal',
      },
      candidateDiff: boundDiff(diff),
      evidence: fixResult.evidence,
    };
  }

  const narrative = input.kind === 'friction'
    ? undefined
    : fixResult.narrative ?? buildFallbackNarrative({
        errorType: input.errorType,
        errorMessage: input.errorMessage,
        primaryFile: fixResult.affectedFiles?.[0],
      });
  const incidentUrl = buildIncidentUrl(
    process.env['DASHBOARD_URL'],
    input.errorGroupId,
    input.projectId,
  );
  const commitMessage = input.kind === 'friction'
    ? `fix: ${input.title.slice(0, 72)}`
    : renderCommitMessage(narrative!, fixResult.evidence, incidentUrl);

  // Stage 2: reserve a stable logical delivery before any provider write.
  let branchName = `opslane/fix-${input.errorGroupId.slice(0, 8)}`;
  const operationKey = `fix:${input.errorGroupId}`;
  if (input.reserveDelivery) {
    const reservation = await input.reserveDelivery({
      operationKey,
      branchName,
      posture: deliveryPosture,
      diffHash: createHash('sha256').update(diff).digest('hex'),
      candidateDiff: boundDiff(diff) ?? diff,
    });
    if (reservation.status === 'cap_reached') {
      return {
        status: 'needs_human',
        confidence: fixResult.confidence,
        reason: buildReason(
          'draft_cap_reached',
          'This project has reached its open Opslane draft PR limit.',
        ),
        candidateDiff: boundDiff(diff),
        evidence: fixResult.evidence,
      };
    }
    branchName = reservation.reservation.branchName;
    deliveryPosture = reservation.reservation.state === 'open'
      ? reservation.reservation.posture
      : input.triggeredBy !== 'human' ? 'draft' : reservation.reservation.posture;
    diff = reservation.reservation.candidateDiff;
    if (
      reservation.reservation.state === 'open'
      && reservation.reservation.prUrl
      && reservation.reservation.prNumber
      && reservation.reservation.headSha
    ) {
      return {
        status: deliveryPosture === 'draft' ? 'pr_draft' : 'pr_created',
        pr_url: reservation.reservation.prUrl,
        pr_number: reservation.reservation.prNumber,
        head_sha: reservation.reservation.headSha,
        confidence: fixResult.confidence,
        reason: deliveryPosture === 'draft' ? fixResult.reason : undefined,
        candidateDiff: deliveryPosture === 'draft' ? boundDiff(diff) : undefined,
        evidence: fixResult.evidence,
        narrative,
      };
    }
  }

  const githubClient = createGitHubClient(input.githubToken);
  const [owner, repo] = input.githubRepo.split('/');
  if (!owner || !repo) {
    return {
      status: 'needs_human',
      reason: buildReason('repo_access_denied', `Invalid repository format: ${input.githubRepo}`),
      candidateDiff: boundDiff(diff),
      evidence: fixResult.evidence,
      narrative,
    };
  }

  const existingPR = await githubClient?.listOpenPullsByHead?.({ owner, repo, head: branchName });
  if (existingPR) {
    await input.recordDeliveryPushed?.(existingPR.headSha);
    return {
      status: deliveryPosture === 'draft' ? 'pr_draft' : 'pr_created',
      pr_url: existingPR.url,
      pr_number: existingPR.number,
      head_sha: existingPR.headSha,
      confidence: fixResult.confidence,
      reason: deliveryPosture === 'draft' ? fixResult.reason : undefined,
      candidateDiff: deliveryPosture === 'draft' ? boundDiff(diff) : undefined,
      evidence: fixResult.evidence,
    };
  }

  let headSha = await githubClient?.getBranchHead?.({ owner, repo, branch: branchName }) ?? undefined;
  await input.assertLeaseOwned?.();
  if (!headSha) {
    try {
      headSha = await traceSpan('git-push', { 'git.branch': branchName }, () =>
        gitCommitAndPush(
          input.repoPath,
          branchName,
          commitMessage,
          diff,
        ),
      );
    } catch (err: unknown) {
      return {
        status: 'needs_human',
        reason: {
          reason_code: 'repo_access_denied',
          reason_message: `Failed to push branch: ${err instanceof Error ? err.message : String(err)}`,
          remediation: 'Ensure GITHUB_TOKEN has push access to the repository',
        },
        candidateDiff: boundDiff(diff),
        evidence: fixResult.evidence,
      };
    }
  }
  await input.recordDeliveryPushed?.(headSha);

  // Stage 3: Create PR
  await input.assertLeaseOwned?.();
  const prResult = await traceSpan(
    'create-pr',
    { 'pr.repo': input.githubRepo, 'pr.branch': branchName },
    () => createPR({
      projectId: input.projectId,
      errorGroupId: input.errorGroupId,
      githubRepo: input.githubRepo,
      defaultBranch: input.defaultBranch,
      branchName,
      diff,
      title: input.title,
      confidence: fixResult.confidence!,
      narrative,
      incidentUrl,
      rootCause: fixResult.rootCause,
      humanSummary: fixResult.humanSummary,
      stackTrace: input.stackTrace,
      replay: input.replay,
      visualAnalysis: input.visualAnalysis,
      errorType: input.errorType,
      errorMessage: input.errorMessage,
      environmentNames: input.environmentNames,
      environmentTotal: input.environmentTotal,
      kind: input.kind,
      evidence: fixResult.evidence ?? null,
      ledger: fixResult.ledger,
      ledgerRoles: fixResult.ledgerRoles,
      tierRecord: fixResult.tierRecord,
      judge: fixResult.evidence?.judge,
      draft: deliveryPosture === 'draft',
      customerRuntime: input.customerRuntime,
      sandboxRuntime: fixResult.sandboxRuntime,
      occurrenceCount: input.occurrenceCount,
      impact: input.impact,
      watchUrl: input.watchUrl,
    }, () => githubClient),
  );

  if (prResult.status === 'failed') {
    return {
      status: 'needs_human',
      reason: prResult.reason,
      candidateDiff: boundDiff(diff),
      evidence: fixResult.evidence,
    };
  }

  return {
    status: deliveryPosture === 'draft' ? 'pr_draft' : 'pr_created',
    pr_url: prResult.prUrl,
    pr_number: prResult.prNumber,
    head_sha: headSha,
    confidence: fixResult.confidence,
    reason: deliveryPosture === 'draft' ? fixResult.reason : undefined,
    candidateDiff: deliveryPosture === 'draft' ? boundDiff(diff) : undefined,
    evidence: fixResult.evidence,
    narrative,
  };
}
