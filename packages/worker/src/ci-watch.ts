import type { ClaimedJob } from './db.js';
import type { EvidenceRecord, ExternalCIEvidence } from '@opslane/shared';
import * as db from './db.js';
import { getInstallationToken } from './github-app.js';
import {
  createGitHubClient,
  replaceCIStatusSection,
  CI_STATUS_END,
  CI_STATUS_START,
  type GitHubClient,
} from './pr.js';
import { logger } from './logger.js';

const WATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_POLL_DELAY_MS = 30 * 60 * 1000;

export interface CIWatchPayload {
  prNumber: number;
  headSha: string;
  watchStartedAt: string;
  pollCount?: number;
}

export interface CIState {
  state: 'green' | 'red' | 'pending';
  checkNames: string[];
  failingChecks: string[];
}

const BLOCKING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'stale',
  'startup_failure',
]);

export function evaluateCI(
  checks: Array<{ name: string; status: string; conclusion: string | null }>,
  statuses: Array<{ context: string; state: string }>,
): CIState {
  const failingChecks = [
    ...checks
      .filter((check) => check.conclusion && BLOCKING_CONCLUSIONS.has(check.conclusion))
      .map((check) => check.name),
    ...statuses
      .filter((status) => status.state === 'failure' || status.state === 'error')
      .map((status) => status.context),
  ];
  const checkNames = [
    ...checks.filter((check) => check.conclusion === 'success').map((check) => check.name),
    ...statuses.filter((status) => status.state === 'success').map((status) => status.context),
  ];
  const pending = checks.some((check) => check.status !== 'completed')
    || statuses.some((status) => status.state === 'pending');

  if (failingChecks.length > 0) {
    return { state: 'red', checkNames: [...new Set(checkNames)], failingChecks: [...new Set(failingChecks)] };
  }
  if (checkNames.length > 0 && !pending) {
    return { state: 'green', checkNames: [...new Set(checkNames)], failingChecks: [] };
  }
  return { state: 'pending', checkNames: [...new Set(checkNames)], failingChecks: [] };
}

function parsePayload(value: unknown): CIWatchPayload {
  if (!value || typeof value !== 'object') throw new Error('ci_watch payload is missing');
  const input = value as Record<string, unknown>;
  if (!Number.isInteger(input['prNumber']) || Number(input['prNumber']) <= 0) {
    throw new Error('ci_watch payload has an invalid prNumber');
  }
  if (typeof input['headSha'] !== 'string' || input['headSha'].trim() === '') {
    throw new Error('ci_watch payload has an invalid headSha');
  }
  if (typeof input['watchStartedAt'] !== 'string' || !Number.isFinite(Date.parse(input['watchStartedAt']))) {
    throw new Error('ci_watch payload has an invalid watchStartedAt');
  }
  return {
    prNumber: Number(input['prNumber']),
    headSha: input['headSha'],
    watchStartedAt: input['watchStartedAt'],
    pollCount: Number.isInteger(input['pollCount']) ? Number(input['pollCount']) : 0,
  };
}

function withExternalCI(
  evidence: EvidenceRecord | null | undefined,
  externalCI: ExternalCIEvidence,
): EvidenceRecord {
  return {
    ...(evidence ?? { version: 1 as const, tier: null, checks: [] }),
    version: 2,
    external_ci: externalCI,
  };
}

function permissionDenied(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return Number((error as { status?: unknown }).status) === 403;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('403') || message.toLowerCase().includes('forbidden');
}

function externalEvidence(
  payload: CIWatchPayload,
  outcome: ExternalCIEvidence['outcome'],
  checkNames: string[] = [],
  failingChecks: string[] = [],
): ExternalCIEvidence {
  return {
    outcome,
    pr_number: payload.prNumber,
    head_sha: payload.headSha,
    check_names: checkNames,
    ...(failingChecks.length > 0 ? { failing_checks: failingChecks } : {}),
    observed_at: new Date().toISOString(),
  };
}

function promotedVerification(names: string[]): string {
  return [
    CI_STATUS_START,
    'External CI: passed for the exact commit published on this PR.',
    ...names.map((name) => `- ✅ ${name.replace(/[<>]/g, '').slice(0, 100)}`),
    CI_STATUS_END,
  ].join('\n');
}

export async function processCIWatchJob(
  job: ClaimedJob & { errorGroupId: string },
  signal: AbortSignal,
  deps?: { client?: GitHubClient; now?: Date },
): Promise<void> {
  if (signal.aborted) throw new Error('Pipeline aborted: lease lost');
  const payload = parsePayload(job.payload);
  const group = await db.getErrorGroup(job.errorGroupId, job.projectId);
  if (!group || group.status !== 'pr_draft') return;
  const project = await db.getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} not found`);
  const [owner, repo] = project.github_repo.split('/');
  if (!owner || !repo) throw new Error(`Invalid repository format: ${project.github_repo}`);

  let client = deps?.client;
  if (!client) {
    let token: string | undefined;
    const installation = await db.getProjectGitHubInstallation(job.projectId);
    if (installation?.installationId) {
      token = await getInstallationToken(installation.installationId);
    }
    token ??= process.env['GITHUB_TOKEN'];
    client = createGitHubClient(token) ?? undefined;
  }
  if (!client?.getPullRequest || !client.listCheckRuns || !client.listCommitStatuses) {
    throw new Error('GitHub client does not support CI watching');
  }

  const pull = await client.getPullRequest({ owner, repo, number: payload.prNumber });
  if (pull.headSha !== payload.headSha) {
    const evidence = withExternalCI(
      group.verification_evidence,
      externalEvidence(payload, 'head_moved'),
    );
    await db.saveExternalCIResult(job.errorGroupId, job.projectId, {
      evidence,
      promote: false,
      remediation: 'The draft branch changed after Opslane published it. Review the new commit and its CI results manually.',
    }, job);
    return;
  }

  let checks: Awaited<ReturnType<NonNullable<GitHubClient['listCheckRuns']>>>;
  let statuses: Awaited<ReturnType<NonNullable<GitHubClient['listCommitStatuses']>>>;
  try {
    [checks, statuses] = await Promise.all([
      client.listCheckRuns({ owner, repo, ref: payload.headSha }),
      client.listCommitStatuses({ owner, repo, ref: payload.headSha }),
    ]);
  } catch (error: unknown) {
    if (!permissionDenied(error)) throw error;
    const evidence = withExternalCI(
      group.verification_evidence,
      externalEvidence(payload, 'permission_denied'),
    );
    await db.saveExternalCIResult(job.errorGroupId, job.projectId, {
      evidence,
      promote: false,
      remediation: 'Approve the GitHub App Checks: read permission upgrade, then review CI on the draft manually.',
    }, job);
    return;
  }

  const state = evaluateCI(checks, statuses);
  if (state.state === 'red') {
    const evidence = withExternalCI(
      group.verification_evidence,
      externalEvidence(payload, 'failed', state.checkNames, state.failingChecks),
    );
    await db.saveExternalCIResult(job.errorGroupId, job.projectId, {
      evidence,
      promote: false,
      remediation: `Repository CI failed: ${state.failingChecks.join(', ')}. Review the failing checks before using this draft.`,
    }, job);
    return;
  }

  if (state.state === 'green') {
    const external = externalEvidence(payload, 'passed', state.checkNames);
    const evidence = withExternalCI(group.verification_evidence, external);
    const body = replaceCIStatusSection(pull.body, promotedVerification(state.checkNames));
    await client.updatePullRequestBody?.({ owner, repo, number: payload.prNumber, body });
    const humanTriggered = group.pr_fix_triggered_by === 'human';
    if (pull.draft && humanTriggered) await client.markPullRequestReady?.({ nodeId: pull.nodeId });
    const promoted = await db.saveExternalCIResult(job.errorGroupId, job.projectId, {
      evidence,
      promote: humanTriggered,
    }, job);
    if (promoted) {
      logger.info('Draft PR promoted after external CI', {
        error_group_id: job.errorGroupId,
        pr_number: payload.prNumber,
        checks: state.checkNames,
      });
    }
    return;
  }

  const now = deps?.now ?? new Date();
  if (now.getTime() - Date.parse(payload.watchStartedAt) >= WATCH_TIMEOUT_MS) {
    const evidence = withExternalCI(
      group.verification_evidence,
      externalEvidence(payload, 'no_ci_observed'),
    );
    await db.saveExternalCIResult(job.errorGroupId, job.projectId, {
      evidence,
      promote: false,
      remediation: 'No successful repository CI check was observed within 24 hours. Review and verify this draft manually.',
    }, job);
    return;
  }

  const pollCount = payload.pollCount ?? 0;
  const delay = Math.min(60_000 * 2 ** Math.min(pollCount, 5), MAX_POLL_DELAY_MS);
  await db.rescheduleJob(job, new Date(now.getTime() + delay), {
    ...payload,
    pollCount: pollCount + 1,
  });
  throw new db.JobRescheduledError(job.id);
}
