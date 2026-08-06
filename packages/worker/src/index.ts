import crypto from 'node:crypto';
import http from 'node:http';
import type { ClaimedJob, ErrorEventData, QueueDepthRow } from './db.js';
import * as db from './db.js';
import {
  requeueStaleJobs,
  updateGroupStatus,
  closePool,
  updateGroupInvestigation,
  updateGroupAndCreateFixJob,
  getGroupInvestigation,
  resolveInactiveGroups,
  resolveSilentMergedGroups,
  updateJobTraceUrl,
  getQueueDepth,
} from './db.js';
import { buildReason } from './reason-codes.js';
import { logger, safeErrorMessage, setWorkerId } from './logger.js';
import { fetchObject, getMinIOConfig } from './minio-client.js';
import { investigateError } from './investigate.js';
import { runPipeline } from './pipeline.js';
import { createPoller } from './poller.js';
import { buildRepoUrl, cloneFailureReason, cloneRepo } from './repo-clone.js';
import { getInstallationToken } from './github-app.js';
import { type ReplaySignals } from './pr.js';
import { processSetupPrJob } from './setup-pr.js';

import type { ResolvedFrame } from './source-map.js';
import { framesFromEnvelope, resolveEventStack } from './resolve-stack.js';
import { initTracing, shutdownTracing, withJobTrace, getActiveTraceId, buildLangfuseTraceUrl } from './tracing.js';
import { runVisualAnalysis, type VisualAnalysisOutput } from './visual-analysis.js';
import {
  buildReplayEvidenceFromRecording,
  fetchChunkViaIngestion,
  pickEvidenceChunks,
  waitForErrorWindowCoverage,
} from './replay-evidence.js';
import { hasNoAppFrames } from './harness/stack-trace-utils.js';
import { gatherFrictionEvidence } from './friction/friction-evidence.js';
import { investigateFriction } from './friction/investigate-friction.js';
import { readChunksBounded } from './friction/chunk-reader.js';
import { analyzeSession, RULE_VERSION } from './friction/analyzer.js';
import { writeFrictionSignals } from './friction/persist.js';
import { processFrictionOutcomes } from './friction/promotion.js';
import { createAnthropicAdjudicator, type Adjudicator } from './friction/adjudicator.js';
import { VerificationInfraError } from './harness/errors.js';
import { processCIWatchJob } from './ci-watch.js';
import { effectivePlatform, pythonPipelineEnabled } from './platform.js';
import { parseRuntimeInfo } from './runtime-info.js';

/** Injectable seam: unit tests and the e2e gate substitute a deterministic
 * adjudicator; production uses the real Anthropic-backed one. */
let frictionAdjudicatorFactory: (apiKey: string) => Adjudicator = createAnthropicAdjudicator;
export function setFrictionAdjudicatorFactory(factory: (apiKey: string) => Adjudicator): void {
  frictionAdjudicatorFactory = factory;
}

/**
 * Maps the raw DB/SDK replay_signals JSON (nested, snake_case) to the flat camelCase
 * ReplaySignals interface used by pr.ts for PR body rendering.
 *
 * SDK format:  { event_type_counts, console: { error_count, ... }, network: { ... }, last_user_actions }
 * Worker format: { eventTypeCounts, consoleErrorCount, ..., lastUserActions }
 */
function mapDbSignals(raw: unknown): ReplaySignals | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;

  const console_ = (s['console'] ?? {}) as Record<string, unknown>;
  const network_ = (s['network'] ?? {}) as Record<string, unknown>;

  return {
    eventTypeCounts: (s['event_type_counts'] ?? s['eventTypeCounts'] ?? undefined) as Record<string, number> | undefined,
    consoleErrorCount: (console_['error_count'] ?? s['consoleErrorCount'] ?? 0) as number,
    consoleWarningCount: (console_['warning_count'] ?? s['consoleWarningCount'] ?? 0) as number,
    consoleErrorMessages: (console_['error_messages'] ?? s['consoleErrorMessages'] ?? []) as string[],
    consoleWarningMessages: (console_['warning_messages'] ?? s['consoleWarningMessages'] ?? []) as string[],
    networkAnomalyCount: (network_['anomaly_count'] ?? s['networkAnomalyCount'] ?? 0) as number,
    networkAnomalies: (network_['anomalies'] ?? s['networkAnomalies'] ?? []) as ReplaySignals['networkAnomalies'],
    lastUserActions: (s['last_user_actions'] ?? s['lastUserActions'] ?? []) as ReplaySignals['lastUserActions'],
  };
}

const POLL_INTERVAL_MS_DEFAULT = 5000;
const POLL_INTERVAL_MS_RAW = parseInt(
  process.env['POLL_INTERVAL_MS'] ?? String(POLL_INTERVAL_MS_DEFAULT),
  10
);
// Guard against NaN/non-positive misconfiguration. Under the drain loop this is
// the only pacing left on the empty-queue and claim-error paths: setTimeout
// coerces NaN to 0, so a typo here would spin claims against Postgres.
const POLL_INTERVAL_MS_MIN = 50;
const POLL_INTERVAL_MS_MAX = 300_000;
const POLL_INTERVAL_MS =
  Number.isInteger(POLL_INTERVAL_MS_RAW) &&
  POLL_INTERVAL_MS_RAW >= POLL_INTERVAL_MS_MIN &&
  POLL_INTERVAL_MS_RAW <= POLL_INTERVAL_MS_MAX
    ? POLL_INTERVAL_MS_RAW
    : POLL_INTERVAL_MS_DEFAULT;
// An unvalidated NaN here becomes a 0ms deadline, so every deploy would
// abandon its in-flight job instead of waiting for it.
const SHUTDOWN_GRACE_MS_DEFAULT = 25_000;
const SHUTDOWN_GRACE_MS_RAW = parseInt(
  process.env['SHUTDOWN_GRACE_MS'] ?? String(SHUTDOWN_GRACE_MS_DEFAULT),
  10,
);
const SHUTDOWN_GRACE_MS_MIN = 1_000;
const SHUTDOWN_GRACE_MS_MAX = 120_000;
const SHUTDOWN_GRACE_MS =
  Number.isInteger(SHUTDOWN_GRACE_MS_RAW) &&
  SHUTDOWN_GRACE_MS_RAW >= SHUTDOWN_GRACE_MS_MIN &&
  SHUTDOWN_GRACE_MS_RAW <= SHUTDOWN_GRACE_MS_MAX
    ? SHUTDOWN_GRACE_MS_RAW
    : SHUTDOWN_GRACE_MS_DEFAULT;
// Silently clamping to the default is how an operator ends up debugging a value
// the process never used. Say so once, at the point of rejection.
for (const clamped of [
  { name: 'POLL_INTERVAL_MS', raw: process.env['POLL_INTERVAL_MS'], applied: POLL_INTERVAL_MS,
    rejected: POLL_INTERVAL_MS !== POLL_INTERVAL_MS_RAW,
    min: POLL_INTERVAL_MS_MIN, max: POLL_INTERVAL_MS_MAX },
  { name: 'SHUTDOWN_GRACE_MS', raw: process.env['SHUTDOWN_GRACE_MS'], applied: SHUTDOWN_GRACE_MS,
    rejected: SHUTDOWN_GRACE_MS !== SHUTDOWN_GRACE_MS_RAW,
    min: SHUTDOWN_GRACE_MS_MIN, max: SHUTDOWN_GRACE_MS_MAX },
]) {
  if (clamped.raw !== undefined && clamped.rejected) {
    logger.warn('Ignoring out-of-range environment value; using the default', {
      variable: clamped.name,
      provided: clamped.raw,
      applied_ms: clamped.applied,
      accepted_min_ms: clamped.min,
      accepted_max_ms: clamped.max,
    });
  }
}
const LEASE_DURATION_MS = parseInt(
  process.env['LEASE_DURATION_MS'] ?? '300000', // 5 minutes default
  10
);
const REAPER_INTERVAL_MS = parseInt(
  process.env['REAPER_INTERVAL_MS'] ?? '60000', // 60 seconds default
  10
);
const SILENCE_CHECK_INTERVAL_MS = parseInt(
  process.env['SILENCE_CHECK_INTERVAL_MS'] ?? '300000', // 5 minutes default
  10
);
const RESOLVE_AGE_DAYS_DEFAULT = 14;
const RESOLVE_AGE_DAYS_RAW = parseInt(
  process.env['RESOLVE_AGE_DAYS'] ?? String(RESOLVE_AGE_DAYS_DEFAULT),
  10
);
// Guard against NaN/negative misconfiguration: a negative value would flip the
// `now() - N days` window into the future and auto-resolve recent/active issues.
const RESOLVE_AGE_DAYS =
  Number.isInteger(RESOLVE_AGE_DAYS_RAW) && RESOLVE_AGE_DAYS_RAW > 0
    ? RESOLVE_AGE_DAYS_RAW
    : RESOLVE_AGE_DAYS_DEFAULT;
const INACTIVITY_CHECK_INTERVAL_MS = parseInt(
  process.env['INACTIVITY_CHECK_INTERVAL_MS'] ?? '900000', // 15 minutes default
  10
);
const WORKER_ID =
  process.env['WORKER_ID'] ?? `worker-${crypto.randomUUID()}`;
setWorkerId(WORKER_ID);
const HEALTH_PORT = parseInt(
  process.env['HEALTH_PORT'] ?? '8081',
  10
);

// Counters for health endpoint
let jobsProcessed = 0;
let jobsFailed = 0;
let lastJobAt: string | null = null;
let jobsInFlight = 0;
let claimsLastMinute = 0;
let claimRatePerMinute = 0;
let queueDepth: QueueDepthRow[] = [];
let queueSampleInFlight: Promise<void> = Promise.resolve();
/** Epoch ms of the last SUCCESSFUL sample. Null until the first one lands. */
let queueSampleAt: number | null = null;
let queueSampleError: string | null = null;
const QUEUE_SAMPLE_INTERVAL_MS = 60_000;
const startTime = Date.now();

export interface HealthInput {
  queueDepth: QueueDepthRow[];
  claimRatePerMinute: number;
  jobsInFlight: number;
  /** Epoch ms of the last successful sample, or null if none has landed. */
  queueSampleAt: number | null;
  now: number;
  startedAt: number;
  sampleIntervalMs: number;
}

/**
 * Health verdict as a pure function of sampled state, so the decision can be
 * tested without booting the worker.
 *
 * `unknown` before any successful sample and once a sample goes stale: a failed
 * sample must not read as health. getQueueDepth and claimJob fail from the same
 * cause, so treating a missing sample as "no eligible work" would report ok
 * during exactly the database outage this field exists to surface.
 *
 * `stalled` needs all three of eligible work, no claims, and nothing in flight.
 * A single multi-minute fix job legitimately produces zero claims across several
 * windows while eligible work waits, and flagging that would fire on healthy
 * operation. The uptime guard exists because claimRatePerMinute is only computed
 * at the first sample tick, so before then it reads 0 for a worker that has been
 * claiming fine since boot.
 */
export function computeHealthStatus(input: HealthInput): 'ok' | 'stalled' | 'unknown' {
  if (input.queueSampleAt === null) return 'unknown';
  if (input.now - input.queueSampleAt > input.sampleIntervalMs * 2) return 'unknown';
  if (input.now - input.startedAt < input.sampleIntervalMs) return 'ok';
  const eligible = input.queueDepth.reduce((total, depth) => total + depth.eligible, 0);
  return eligible > 0 && input.claimRatePerMinute === 0 && input.jobsInFlight === 0
    ? 'stalled'
    : 'ok';
}

function healthStatus(): 'ok' | 'stalled' | 'unknown' {
  return computeHealthStatus({
    queueDepth,
    claimRatePerMinute,
    jobsInFlight,
    queueSampleAt,
    now: Date.now(),
    startedAt: startTime,
    sampleIntervalMs: QUEUE_SAMPLE_INTERVAL_MS,
  });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Pipeline aborted: lease lost');
  }
}

async function resolveStackForEvent(
  event: ErrorEventData,
  projectId: string,
  platform: string,
): Promise<ResolvedFrame[] | null> {
  if (platform !== 'javascript') return null;
  const minioConfig = getMinIOConfig();
  const resolution = await resolveEventStack(
    {
      stackTraceRaw: event.stack_trace_raw,
      debugMeta: event.debug_meta,
      projectId,
    },
    {
      getMapRows: db.getSourceMapRows,
      fetchMap: async (objectKey) => {
        if (!minioConfig) return null;
        return (await fetchObject(objectKey, minioConfig)).toString('utf-8');
      },
    },
  );
  await db.setEventResolution(
    event.id,
    projectId,
    resolution.status,
    resolution.envelope,
  );
  return resolution.frames;
}

export async function processJob(job: ClaimedJob, signal: AbortSignal): Promise<void> {
  jobsInFlight += 1;
  try {
    await withJobTrace(
      job.id,
      job.errorGroupId ?? job.sourceId ?? 'unknown',
      job.projectId,
      () => processJobInner(job, signal),
    );
  } finally {
    jobsInFlight -= 1;
  }
}

export async function processJobInner(job: ClaimedJob, signal: AbortSignal): Promise<void> {
  // Fire-and-forget: persist Langfuse trace URL on the job row
  const traceId = getActiveTraceId();
  if (traceId) {
    const traceUrl = buildLangfuseTraceUrl(traceId);
    if (traceUrl) {
      updateJobTraceUrl(
        job.id,
        job.workerId,
        job.leaseGeneration,
        traceUrl,
      ).catch((err: unknown) => {
        // A false return (rowCount 0) stays ignored: that means the lease moved
        // on, which is routine and already covered by the lease contract.
        // Only a genuine rejection is worth a line. safeErrorMessage because a
        // raw String(err) here would throw a second, unhandled rejection.
        logger.warn('Failed to persist trace_url', {
          job_id: job.id,
          error: safeErrorMessage(err),
        });
      });
    }
  }

  logger.info('Processing job', {
    job_id: job.id,
    job_type: job.jobType,
    error_group_id: job.errorGroupId,
    source_id: job.sourceId,
    project_id: job.projectId,
    attempt: job.attempts + 1,
  });

  if (job.jobType === 'setup_pr') {
    await processSetupPrJob(job, signal);
    return;
  }

  if (job.jobType === 'session_analysis') {
    if (!job.sessionId) throw new Error(`Job ${job.id} missing session_id`);
    await processSessionAnalysisJob(job as ClaimedJob & { sessionId: string }, signal);
    return;
  }

  if (job.jobType === 'ci_watch') {
    if (!job.errorGroupId) throw new Error(`Job ${job.id} missing error_group_id`);
    await processCIWatchJob(job as ClaimedJob & { errorGroupId: string }, signal);
    return;
  }

  if (!job.errorGroupId) {
    throw new Error(`Job ${job.id} missing error_group_id`);
  }
  const errorJob = job as ClaimedJob & { errorGroupId: string };

  if (errorJob.jobType === 'fix') {
    try {
      await processFixJob(errorJob, signal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Lease-lost / abort: do NOT terminate the group — rethrow so the job can be
      // legitimately requeued and picked up by another worker. The heartbeat sets
      // signal.aborted before checkAbort throws, so that flag is the reliable signal;
      // 'lease lost' is a narrow belt-and-suspenders. We deliberately do NOT match a
      // bare 'aborted' substring — genuine errors ("operation was aborted") would
      // otherwise be misclassified as lease-loss and requeued instead of handed to a human.
      if (signal.aborted || message.includes('lease lost')) {
        throw err;
      }
      if (err instanceof VerificationInfraError) {
        const finalAttempt = errorJob.attempts + 1 >= (errorJob.maxAttempts ?? 3);
        if (!finalAttempt) {
          // The poller will call failJob, which requeues with the existing
          // attempts/backoff machinery. Infrastructure errors are not patch evidence.
          throw err;
        }
        try {
          await updateGroupStatus(
            errorJob.errorGroupId,
            errorJob.projectId,
            'needs_human',
            {
              reason: buildReason('verification_infra_error', err.message),
              evidence: err.evidence,
            },
            errorJob,
          );
        } catch (writeErr: unknown) {
          if (!(writeErr instanceof db.LeaseLostError)) throw writeErr;
        }
        logger.error('Verification infrastructure retries exhausted', {
          job_id: errorJob.id,
          attempt: errorJob.attempts + 1,
        });
        return;
      }
      // Genuine error: terminate as needs_human (preserve reason; root_cause untouched)
      // and DO NOT rethrow, so the poller completes the job rather than requeuing it
      // and re-running over a now-terminal incident.
      const safeMessage = message.replace(/https:\/\/[^@]{1,512}@/g, 'https://***@');
      try {
        await updateGroupStatus(
          errorJob.errorGroupId,
          errorJob.projectId,
          'needs_human',
          { reason: buildReason('worker_runtime_error', `Fix job error: ${safeMessage}`) },
          errorJob,
        );
      } catch (writeErr: unknown) {
        // Only lease loss is safe to swallow — a newer owner will re-process the
        // job. Any other write failure (e.g. transient DB error) must propagate,
        // or the poller would complete the job and strand the incident in
        // 'fixing' with no live work.
        if (!(writeErr instanceof db.LeaseLostError)) throw writeErr;
      }
      logger.error('Fix job threw — terminated as needs_human', { job_id: errorJob.id, error: safeMessage });
    }
  } else {
    await processInvestigateJob(errorJob, signal);
  }
}

/**
 * Investigation job: runs codebase-aware investigation, stores results,
 * and routes based on confidence (high → auto-fix, medium/low → investigated).
 */
export async function processInvestigateJob(job: ClaimedJob & { errorGroupId: string }, signal: AbortSignal): Promise<void> {
  const jobStart = Date.now();
  checkAbort(signal);

  const group = await db.getErrorGroup(job.errorGroupId, job.projectId);
  if (!group) throw new Error(`Error group ${job.errorGroupId} not found`);
  const platform = effectivePlatform(group.platform, pythonPipelineEnabled());

  // A reclaimed investigate job may have committed its durable outcome before
  // losing the lease at the final queue-completion boundary. Adopt that outcome
  // rather than resetting the incident and repeating delivery work.
  if (!['new', 'queued', 'analyzing', 'candidate'].includes(group.status)) {
    logger.info('Investigation outcome already committed; adopting existing state', {
      job_id: job.id,
      error_group_id: job.errorGroupId,
      status: group.status,
    });
    return;
  }

  await updateGroupStatus(job.errorGroupId, job.projectId, 'analyzing', undefined, job);
  checkAbort(signal);

  if (group.kind === 'friction') {
    await processFrictionInvestigateJob(job, group, signal);
    return;
  }

  const event = group.sample_event_id
    ? await db.getErrorEvent(group.sample_event_id, job.projectId)
    : null;
  const customerRuntime = parseRuntimeInfo(event?.context ?? '');

  // Pre-clone guard: errors with no application stack frames (cross-origin
  // "Script error.", non-Error promise rejections) are inherently unfixable by
  // the agent. Short-circuit to needs_human BEFORE cloning the repo or spending
  // an LLM/sandbox. The reason code is non-retriable, so the single collapsed
  // stackless group won't reopen on every recurrence.
  if (hasNoAppFrames(event?.stack_trace_raw ?? '', platform)) {
    await updateGroupStatus(job.errorGroupId, job.projectId, 'needs_human', {
      reason: buildReason(
        'unfixable_no_app_frames',
        platform === 'python'
          ? 'The Python traceback has no application frames, so there is nothing safe to investigate.'
          : 'Error has no application stack frames (cross-origin "Script error." or a non-Error promise rejection), so there is nothing to investigate.',
        undefined,
        platform,
      ),
    }, job);
    jobsFailed++;
    lastJobAt = new Date().toISOString();
    logger.info('Investigation: needs_human (no app frames, pre-clone short-circuit)', {
      job_id: job.id,
      error_group_id: job.errorGroupId,
    });
    return;
  }

  // Debug-ID resolution depends only on Postgres and object storage. Persist
  // it before LLM credentials or repository access can terminate the job.
  const resolvedStack = event
    ? await resolveStackForEvent(event, job.projectId, platform)
    : null;

  const project = await db.getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} not found`);

  checkAbort(signal);

  // The LLM key is the pipeline's most fundamental prerequisite. Check it
  // before token resolution and the repo clone so the terminal reason names
  // the real blocker instead of a downstream clone failure.
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
      reason: {
        reason_code: 'missing_llm_key',
        reason_message: 'ANTHROPIC_API_KEY environment variable is not set',
        remediation: 'Set the ANTHROPIC_API_KEY environment variable with a valid Anthropic API key',
      },
    }, job);
    jobsFailed++;
    lastJobAt = new Date().toISOString();
    return;
  }

  // Resolve GitHub token
  let githubToken: string | undefined;
  const installInfo = await db.getProjectGitHubInstallation(job.projectId);
  if (installInfo?.installationId) {
    try {
      githubToken = await getInstallationToken(installInfo.installationId);
    } catch (err: unknown) {
      logger.error('Failed to get GitHub installation token', { project_id: job.projectId, error: String(err) });
    }
  }
  if (!githubToken) {
    githubToken = process.env['GITHUB_TOKEN'];
  }

  checkAbort(signal);

  // Clone repo for investigation
  let repoDir: string;
  let cleanup: () => Promise<void>;
  try {
    const cloneResult = await cloneRepo({
      githubRepo: project.github_repo,
      jobId: job.id,
      githubToken,
    });
    repoDir = cloneResult.repoDir;
    cleanup = cloneResult.cleanup;
    await db.cacheProjectDefaultBranch(job.projectId, cloneResult.defaultBranch);
  } catch (err: unknown) {
    await updateGroupStatus(job.errorGroupId, job.projectId, 'needs_human', {
      reason: cloneFailureReason(err),
    }, job);
    jobsFailed++;
    lastJobAt = new Date().toISOString();
    return;
  }

  try {
    const surface = await db.loadFixSurface(job.projectId);

    checkAbort(signal);

    // Run codebase-aware investigation
    const triage = await investigateError(apiKey, {
      platform,
      customerRuntime,
      errorType: event?.error_type ?? 'Unknown',
      title: group.title,
      errorMessage: event?.error_message ?? '',
      stackTrace: event?.stack_trace_raw ?? '',
      resolvedStackTrace: resolvedStack ?? framesFromEnvelope(event?.stack_trace_resolved) ?? null,
      breadcrumbs: event?.breadcrumbs ?? '[]',
    }, repoDir, surface);
    checkAbort(signal);

    logger.info('Investigation result', {
      job_id: job.id,
      fixable: triage.fixable,
      confidence: triage.confidence,
      reason: triage.reason,
    });

    const durationMs = Date.now() - jobStart;

    // Route based on investigation result
    if (!triage.fixable && triage.confidence === 'high') {
      // Definitely unfixable → needs_human with investigation results
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
        rootCause: triage.reason,
        confidence: triage.confidence,
        reason: {
          reason_code: triage.reason_code ?? 'triage_unfixable',
          reason_message: triage.reason ?? 'Error classified as unfixable by investigation',
          remediation: triage.remediation ?? 'Review the error manually',
        },
      }, job);
      jobsFailed++;
      logger.warn('Investigation: needs_human (unfixable)', {
        job_id: job.id, duration_ms: durationMs,
      });
    } else if (triage.fixable && triage.confidence === 'high') {
      // High confidence fixable → auto-trigger fix (atomic transaction)
      const fixResult = await updateGroupAndCreateFixJob(job.errorGroupId, job.projectId, {
        rootCause: triage.reason,
        suggestedMitigation: triage.remediation,
        confidence: triage.confidence,
        platform,
      }, job);
      if (fixResult.created) {
        jobsProcessed++;
        logger.info('Investigation: auto-triggering fix', {
          job_id: job.id, fix_job_id: fixResult.fixJobId, duration_ms: durationMs,
        });
      } else {
        // Defense-in-depth refusal (kind gate): park the result for a human
        // instead of silently dropping the investigation.
        await updateGroupInvestigation(job.errorGroupId, job.projectId, 'investigated', {
          rootCause: triage.reason,
          suggestedMitigation: triage.remediation,
          confidence: triage.confidence,
        }, job);
        jobsProcessed++;
        logger.warn('Investigation: automatic fix refused by kind gate', {
          job_id: job.id, reason: fixResult.reason, duration_ms: durationMs,
        });
      }
    } else {
      // Medium/low confidence → investigated, wait for user
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'investigated', {
        rootCause: triage.reason,
        suggestedMitigation: triage.remediation,
        confidence: triage.confidence,
      }, job);
      jobsProcessed++;
      logger.info('Investigation: investigated (awaiting user)', {
        job_id: job.id, confidence: triage.confidence, duration_ms: durationMs,
      });
    }
  } finally {
    await cleanup();
  }

  lastJobAt = new Date().toISOString();
}

export async function processFrictionInvestigateJob(
  job: ClaimedJob & { errorGroupId: string },
  group: db.ErrorGroupData,
  signal: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
      reason: {
        reason_code: 'missing_llm_key',
        reason_message: 'ANTHROPIC_API_KEY environment variable is not set',
        remediation: 'Set ANTHROPIC_API_KEY so the friction incident can be classified against the codebase',
      },
    }, job);
    jobsFailed++;
    lastJobAt = new Date().toISOString();
    return;
  }

  const project = await db.getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} not found`);

  let githubToken: string | undefined;
  const installInfo = await db.getProjectGitHubInstallation(job.projectId);
  if (installInfo?.installationId) {
    try {
      githubToken = await getInstallationToken(installInfo.installationId);
    } catch (error: unknown) {
      logger.error('Failed to get GitHub installation token', {
        project_id: job.projectId,
        error: String(error),
      });
    }
  }
  githubToken ??= process.env['GITHUB_TOKEN'];
  checkAbort(signal);

  let clone: Awaited<ReturnType<typeof cloneRepo>>;
  try {
    clone = await cloneRepo({
      githubRepo: project.github_repo,
      jobId: job.id,
      githubToken,
    });
    await db.cacheProjectDefaultBranch(job.projectId, clone.defaultBranch);
  } catch (error: unknown) {
    await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
      reason: cloneFailureReason(error),
    }, job);
    jobsFailed++;
    lastJobAt = new Date().toISOString();
    return;
  }

  try {
    const evidence = await gatherFrictionEvidence(job.errorGroupId, job.projectId);
    checkAbort(signal);
    const result = await investigateFriction(apiKey, group, evidence, clone.repoDir);
    checkAbort(signal);
    if (result.codeCause) {
      // auto_fix_ux shares the code-caused auto-fix path until UX-suggestion
      // fixes exist; insights remain terminal and never produce a PR.
      const autonomyAllowsFix = project.friction_autonomy === 'auto_fix'
        || project.friction_autonomy === 'auto_fix_ux';
      if (result.confidence === 'high' && autonomyAllowsFix) {
        // allowFriction is the ladder's explicit opt-in past the kind gate;
        // refuse-by-default stays intact for every other caller (issue #56).
        const fixResult = await updateGroupAndCreateFixJob(job.errorGroupId, job.projectId, {
          rootCause: result.reason,
          suggestedMitigation: result.remediation,
          confidence: result.confidence,
        }, job, { allowFriction: true });
        if (fixResult.created) {
          logger.info('Friction investigation: auto-triggering fix (autonomy ladder)', {
            job_id: job.id,
            fix_job_id: fixResult.fixJobId,
            autonomy: project.friction_autonomy,
          });
        } else {
          // Never drop the investigation: park it for human approval instead.
          await updateGroupInvestigation(job.errorGroupId, job.projectId, 'awaiting_approval', {
            rootCause: result.reason,
            suggestedMitigation: result.remediation,
            confidence: result.confidence,
          }, job);
          logger.warn('Friction investigation: auto-fix refused by kind gate — parked for approval', {
            job_id: job.id,
            reason: fixResult.reason,
          });
        }
      } else {
        await updateGroupInvestigation(job.errorGroupId, job.projectId, 'awaiting_approval', {
          rootCause: result.reason,
          suggestedMitigation: result.remediation,
          confidence: result.confidence,
        }, job);
        logger.info('Friction investigation: awaiting human approval', {
          job_id: job.id,
          confidence: result.confidence,
        });
      }
    } else {
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'insight', {
        rootCause: result.reason,
        confidence: result.confidence,
      }, job);
      logger.info('Friction investigation: recorded insight', {
        job_id: job.id,
        confidence: result.confidence,
      });
    }
    jobsProcessed++;
    lastJobAt = new Date().toISOString();
  } finally {
    await clone.cleanup();
  }
}

export async function processSessionAnalysisJob(
  job: ClaimedJob & { sessionId: string },
  signal: AbortSignal,
): Promise<void> {
  try {
    const session = await db.getSessionForAnalysis(job.sessionId, job.projectId);
    if (!session) throw new Error(`Session ${job.sessionId} not found`);
    await db.setSessionAnalysisStatus(job.sessionId, job.projectId, 'analyzing', undefined, job);
    checkAbort(signal);
    const chunks = await db.getScrubbedChunksForSession(job.sessionId, job.projectId);
    const read = await readChunksBounded(chunks);
    checkAbort(signal);
    const signals = analyzeSession(read.envelopes);
    await db.assertJobLease(job);
    await writeFrictionSignals(session, signals, RULE_VERSION);
    // Batch 4: adjudicate → fold/aggregate before the session is marked
    // analyzed, so a crash retries the whole ordered pass. Keyless
    // deployments skip adjudication; signals stay pending and invisible.
    const adjudicationKey = process.env['ANTHROPIC_API_KEY'];
    if (adjudicationKey) {
      checkAbort(signal);
      await processFrictionOutcomes(session, job.id, frictionAdjudicatorFactory(adjudicationKey));
    } else {
      logger.warn('ANTHROPIC_API_KEY unset; friction adjudication skipped, signals stay pending', {
        job_id: job.id,
        session_id: job.sessionId,
      });
    }
    await db.setSessionAnalysisStatus(job.sessionId, job.projectId, 'analyzed', RULE_VERSION, job);
    if (read.truncated) {
      logger.warn('Session analysis completed from bounded prefix', {
        job_id: job.id,
        session_id: job.sessionId,
        inflated_bytes: read.inflatedBytes,
        chunk_count: read.envelopes.length,
      });
    }
    jobsProcessed++;
    lastJobAt = new Date().toISOString();
  } catch (error: unknown) {
    if (signal.aborted || error instanceof db.LeaseLostError) throw error;
    try {
      await db.setSessionAnalysisStatus(job.sessionId, job.projectId, 'analysis_failed', undefined, job);
    } catch (writeError: unknown) {
      // A newer owner will reconcile the session. Other database failures must
      // replace the analyzer error so the poller does not complete stale state.
      if (!(writeError instanceof db.LeaseLostError)) throw writeError;
    }
    throw error;
  }
}

/**
 * Fix job: loads investigation context, runs the full agent fix pipeline,
 * and creates a PR or reverts to investigated on failure.
 */
export async function processFixJob(job: ClaimedJob & { errorGroupId: string }, signal: AbortSignal): Promise<void> {
  const jobStart = Date.now();
  checkAbort(signal);

  // Fetch real data
  const group = await db.getErrorGroup(job.errorGroupId, job.projectId);
  if (!group) throw new Error(`Error group ${job.errorGroupId} not found`);
  const platform = job.platform ?? effectivePlatform(group.platform, pythonPipelineEnabled());

  if (group.status === 'pr_created' || group.status === 'pr_draft') {
    logger.info('Fix delivery already committed; adopting existing state', {
      job_id: job.id,
      error_group_id: job.errorGroupId,
      status: group.status,
    });
    return;
  }

  if (group.kind === 'friction' && job.triggeredBy !== 'human') {
    // Settings can change after enqueue, so enforce the current project rung
    // when the job is claimed. Legacy jobs without attribution stay parked.
    const gateProject = await db.getProject(job.projectId);
    const autonomy = gateProject?.friction_autonomy ?? 'ask_first';
    if (job.triggeredBy !== 'auto' || autonomy === 'ask_first') {
      await updateGroupStatus(job.errorGroupId, job.projectId, 'awaiting_approval', {
        confidence: group.confidence ?? undefined,
      }, job);
      logger.warn('Refused non-human friction fix job', { job_id: job.id, autonomy });
      return;
    }
  }

  const event = group.sample_event_id
    ? await db.getErrorEvent(group.sample_event_id, job.projectId)
    : null;
  const customerRuntime = parseRuntimeInfo(event?.context ?? '');
  const resolvedStack = event
    ? await resolveStackForEvent(event, job.projectId, platform)
    : null;

  const project = await db.getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} not found`);

  // Load investigation context
  const investigation = await getGroupInvestigation(job.errorGroupId, job.projectId);

  // Parallel fetch for independent data
  const [replay, sessionPointer, environmentContext] = await Promise.all([
    db.getReplayForGroup(job.errorGroupId, job.projectId),
    db.getSessionPointerForGroup(job.errorGroupId, job.projectId),
    db.getEnvironmentNamesForGroup(job.errorGroupId, job.projectId, group.kind),
  ]);
  const artifacts = replay ? await db.getReplayArtifacts(replay.id, job.projectId) : [];

  checkAbort(signal);

  // Resolve GitHub token
  let githubToken: string | undefined;
  const installInfo = await db.getProjectGitHubInstallation(job.projectId);
  if (installInfo?.installationId) {
    try {
      githubToken = await getInstallationToken(installInfo.installationId);
    } catch (err: unknown) {
      logger.error('Failed to get GitHub installation token', { project_id: job.projectId, error: String(err) });
    }
  }
  if (!githubToken) {
    githubToken = process.env['GITHUB_TOKEN'];
  }

  checkAbort(signal);

  // Clone repo
  let repoDir: string;
  let defaultBranch: string;
  let cleanup: () => Promise<void>;
  try {
    const cloneResult = await cloneRepo({
      githubRepo: project.github_repo,
      jobId: job.id,
      githubToken,
    });
    repoDir = cloneResult.repoDir;
    defaultBranch = cloneResult.defaultBranch;
    cleanup = cloneResult.cleanup;
    await db.cacheProjectDefaultBranch(job.projectId, defaultBranch);
  } catch (err: unknown) {
    await updateGroupStatus(job.errorGroupId, job.projectId, 'needs_human', {
      reason: cloneFailureReason(err),
    }, job);
    jobsFailed++;
    lastJobAt = new Date().toISOString();
    return;
  }

  const minioConfig = getMinIOConfig();

  try {
    // Visual analysis
    let visualOutput: VisualAnalysisOutput | null = null;
    if (sessionPointer) {
      // Prefer the always-on stream. Ingestion owns the scrub gate, bounded
      // inflate, and redact-on-read; the worker never reads raw chunk objects.
      const errorAtMs = Date.parse(sessionPointer.error_at);
      const chunks = await waitForErrorWindowCoverage(
        sessionPointer.session_id,
        job.projectId,
        errorAtMs,
      );
      const picked = pickEvidenceChunks(chunks, errorAtMs);
      const envelopes = await Promise.all(
        picked.map((chunk) => fetchChunkViaIngestion(job.projectId, sessionPointer.session_id, chunk.seq)),
      );
      const events = envelopes
        .flatMap((envelope) => envelope?.events ?? [])
        .sort((left, right) => left.timestamp - right.timestamp);
      if (events.length > 0) {
        const firstTimestamp = events[0]!.timestamp;
        const lastTimestamp = events[events.length - 1]!.timestamp;
        const crashTimestamp = Number.isFinite(errorAtMs)
          ? Math.min(Math.max(errorAtMs, firstTimestamp), lastTimestamp)
          : lastTimestamp;
        visualOutput = buildReplayEvidenceFromRecording(
          { events, meta: { crash_timestamp: crashTimestamp } },
          {
            errorType: event?.error_type ?? 'Unknown',
            errorMessage: event?.error_message ?? '',
          },
        );
      }
    }

    if (!visualOutput && artifacts.length > 0) {
      if (minioConfig) {
        const screenshots = await Promise.all(
          artifacts.map(async (a) => {
            const data = await fetchObject(a.object_key, minioConfig);
            return {
              base64: data.toString('base64'),
              contentType: a.content_type,
              kind: a.kind,
            };
          }),
        );
        visualOutput = await runVisualAnalysis({
          screenshots,
          signals: mapDbSignals(replay?.replay_signals) ?? {},
          errorType: event?.error_type ?? 'Unknown',
          errorMessage: event?.error_message ?? '',
        });
      }
    } else if (!visualOutput && replay?.object_key && minioConfig) {
      // rrweb replays upload a recording.json (no screenshot artifacts). Extract
      // crash-time DOM + user-action evidence directly from the event stream so the
      // fix agent and PR body get real replay evidence instead of `visual_replay: n/a`.
      try {
        const recordingBuf = await fetchObject(replay.object_key, minioConfig);
        const recording = JSON.parse(recordingBuf.toString('utf-8')) as Parameters<
          typeof buildReplayEvidenceFromRecording
        >[0];
        visualOutput = buildReplayEvidenceFromRecording(recording, {
          errorType: event?.error_type ?? 'Unknown',
          errorMessage: event?.error_message ?? '',
        });
      } catch (err: unknown) {
        logger.warn('Failed to build rrweb replay evidence', { replay_id: replay.id, error: String(err) });
      }
    }

    checkAbort(signal);

    const repoUrl = buildRepoUrl(project.github_repo);
    const frictionEvidence = group.kind === 'friction'
      ? await gatherFrictionEvidence(job.errorGroupId, job.projectId)
      : null;

    const result = await runPipeline({
      platform,
      customerRuntime,
      jobId: job.id,
      errorGroupId: job.errorGroupId,
      projectId: job.projectId,
      title: group.title,
      errorType: event?.error_type ?? 'Unknown',
      errorMessage: event?.error_message ?? '',
      stackTrace: event?.stack_trace_raw ?? '',
      resolvedStackTrace: resolvedStack ?? framesFromEnvelope(event?.stack_trace_resolved) ?? null,
      breadcrumbs: event?.breadcrumbs ?? '[]',
      context: event?.context ?? '{}',
      environmentNames: environmentContext.names,
      environmentTotal: environmentContext.totalCount,
      sourceFiles: [],
      visualAnalysis: visualOutput,
      repoPath: repoDir,
      repoUrl,
      githubRepo: project.github_repo,
      defaultBranch,
      githubToken,
      abortSignal: signal,
      assertLeaseOwned: () => db.assertJobLease(job),
      kind: group.kind,
      frictionEvidence: frictionEvidence
        ? JSON.stringify({
            signals: frictionEvidence.signals,
            timeline: frictionEvidence.timeline,
            truncated: frictionEvidence.truncated,
          })
        : undefined,
      replay: replay ? {
        id: replay.id,
        sessionId: replay.session_id,
        triggerType: replay.trigger_type,
        pageUrl: replay.page_url,
        startedAt: replay.started_at,
        endedAt: replay.ended_at,
        status: replay.status,
        sizeBytes: replay.size_bytes,
        signals: mapDbSignals(replay.replay_signals),
      } : null,
      investigation: investigation.rootCause ? {
        rootCause: investigation.rootCause,
        suggestedMitigation: investigation.suggestedMitigation ?? '',
        guidance: job.guidance ?? undefined,
      } : undefined,
      prPosture: project.pr_posture ?? 'verified_only',
      reserveDelivery: (delivery) => db.reserveDelivery(
        job.errorGroupId,
        job.projectId,
        delivery,
        job,
      ),
      recordDeliveryPushed: (headSha) => db.recordDeliveryPushed(
        job.errorGroupId,
        job.projectId,
        headSha,
        job,
      ),
    });
    checkAbort(signal);

    const durationMs = Date.now() - jobStart;

    if (result.status === 'pr_created' || result.status === 'pr_draft') {
      if (!result.pr_url || !result.pr_number) {
        throw new Error(`Delivery result ${result.status} is missing PR identity`);
      }
      if (!result.head_sha && result.status === 'pr_created') {
        // Compatibility path for older injected pipeline implementations. The
        // production pipeline always returns a reserved delivery head SHA.
        await updateGroupStatus(job.errorGroupId, job.projectId, 'pr_created', {
          confidence: result.confidence,
          pr_url: result.pr_url,
          pr_number: result.pr_number,
          pr_fix_job_id: job.id,
          evidence: result.evidence,
        }, job);
      } else {
        if (!result.head_sha) throw new Error('Draft delivery result is missing head SHA');
        await db.finalizeDelivery(job.errorGroupId, job.projectId, {
          status: result.status,
          confidence: result.confidence ?? (result.status === 'pr_draft' ? 'medium' : 'high'),
          prUrl: result.pr_url,
          prNumber: result.pr_number,
          headSha: result.head_sha,
          fixJobId: job.id,
          reason: result.reason,
          candidateDiff: result.candidateDiff,
          evidence: result.evidence,
        }, job);
      }
      jobsProcessed++;
      logger.info(`Fix job completed: ${result.status}`, {
        job_id: job.id, duration_ms: durationMs, pr_url: result.pr_url,
      });
    } else {
      // Fix did not clear the precision floor (or failed) — terminate as needs_human,
      // preserving the full writeup (reason + confidence). root_cause is untouched.
      await updateGroupStatus(job.errorGroupId, job.projectId, 'needs_human', {
        reason: result.reason ?? buildReason('worker_runtime_error', 'Fix pipeline failed without a reason'),
        confidence: result.confidence,
        candidate_diff: result.candidateDiff,
        evidence: result.evidence,
      }, job);
      jobsFailed++;
      logger.warn('Fix job completed: needs_human (writeup preserved)', {
        job_id: job.id, duration_ms: durationMs, reason_code: result.reason?.reason_code, confidence: result.confidence,
      });
    }
  } finally {
    await cleanup();
  }

  lastJobAt = new Date().toISOString();
}

async function main(): Promise<void> {
  logger.info('Opslane worker starting');

  const requiredEnv = ['DATABASE_URL'];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      logger.error('Missing required environment variable', { key });
      process.exit(1);
    }
  }

  // Warn about optional env vars that will cause job failures if missing
  const warnEnv = ['ANTHROPIC_API_KEY', 'E2B_API_KEY', 'GITHUB_TOKEN'];
  for (const key of warnEnv) {
    if (!process.env[key]) {
      logger.warn('Optional environment variable not set — jobs requiring it will fail', { key });
    }
  }

  // Initialize tracing (no-op if LANGFUSE env vars unset).
  // Must complete before poller starts so Anthropic SDK is instrumented.
  await initTracing();

  // Start health HTTP server
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        worker_id: WORKER_ID,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        jobs_processed: jobsProcessed,
        jobs_failed: jobsFailed,
        last_job_at: lastJobAt,
        claims_per_minute: claimRatePerMinute,
        // Serialized snake_case to match the rest of the payload; QueueDepthRow
        // stays camelCase as the internal type.
        queue_depth: queueDepth.map((depth) => ({
          job_type: depth.jobType,
          eligible: depth.eligible,
          backed_off: depth.backedOff,
          oldest_eligible_seconds: depth.oldestEligibleSeconds,
        })),
        queue_depth_sampled_at:
          queueSampleAt === null ? null : new Date(queueSampleAt).toISOString(),
        queue_sample_error: queueSampleError,
        status: healthStatus(),
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, () => {
    logger.info('Health server started', { port: HEALTH_PORT });
  });

  const poller = createPoller({
    intervalMs: POLL_INTERVAL_MS,
    leaseDurationMs: LEASE_DURATION_MS,
    workerId: WORKER_ID,
    processJob,
    onClaim: () => { claimsLastMinute += 1; },
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
  });
  poller.start();

  // Sampled on a timer, never per claim: the aggregate scans the pending set
  // and the drain loop claims far too often to pay for it each time.
  function sampleQueueDepth(): void {
    queueSampleInFlight = getQueueDepth()
      .then((depth) => {
        queueDepth = depth;
        queueSampleAt = Date.now();
        queueSampleError = null;
      })
      .catch((err: unknown) => {
        // Leave queueDepth alone and record the failure. healthStatus() reads
        // queueSampleAt, so a stale sample degrades to 'unknown' rather than
        // being mistaken for an empty queue.
        queueSampleError = err instanceof Error ? err.message : String(err);
        logger.error('Queue depth sample failed', { error: queueSampleError });
      });
  }

  // Prime once so /health has a verdict before the first interval fires,
  // instead of reporting on an empty array for the first minute.
  sampleQueueDepth();

  const queueSampleTimer = setInterval(() => {
    claimRatePerMinute = claimsLastMinute;
    claimsLastMinute = 0;
    sampleQueueDepth();
  }, QUEUE_SAMPLE_INTERVAL_MS);

  // Reaper: periodically reclaim jobs with expired leases
  const reaperTimer = setInterval(() => {
    requeueStaleJobs()
      .then((count) => {
        if (count > 0) {
          logger.info('Reaper: requeued stale jobs', { count });
        }
      })
      .catch((err: unknown) => {
        logger.error('Reaper error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, REAPER_INTERVAL_MS);

  // Silence window checker — auto-resolve merged groups after 24h of no recurrence
  const silenceTimer = setInterval(() => {
    resolveSilentMergedGroups()
      .then((ids) => {
        if (ids.length > 0) {
          logger.info('Silence checker: resolved merged groups', { count: ids.length, group_ids: ids });
        }
      })
      .catch((err: unknown) => {
        logger.error('Silence checker error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, SILENCE_CHECK_INTERVAL_MS);

  // Inactivity checker — auto-resolve unresolved groups after the configured age
  const inactivityTimer = setInterval(() => {
    resolveInactiveGroups(RESOLVE_AGE_DAYS)
      .then((ids) => {
        if (ids.length > 0) {
          logger.info('Inactivity checker: auto-resolved inactive groups', {
            count: ids.length,
            // Cap the sample: the first post-deploy sweep can resolve a large
            // historical backlog and a full UUID array would blow up the log line.
            group_ids: ids.slice(0, 50),
            group_ids_truncated: ids.length > 50,
            resolve_age_days: RESOLVE_AGE_DAYS,
          });
        }
      })
      .catch((err: unknown) => {
        logger.error('Inactivity checker error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, INACTIVITY_CHECK_INTERVAL_MS);

  logger.info('Worker ready', {
    worker_id: WORKER_ID,
    poll_interval_ms: POLL_INTERVAL_MS,
    shutdown_grace_ms: SHUTDOWN_GRACE_MS,
    lease_duration_ms: LEASE_DURATION_MS,
    reaper_interval_ms: REAPER_INTERVAL_MS,
    silence_check_interval_ms: SILENCE_CHECK_INTERVAL_MS,
    resolve_age_days: RESOLVE_AGE_DAYS,
    inactivity_check_interval_ms: INACTIVITY_CHECK_INTERVAL_MS,
    health_port: HEALTH_PORT,
  });

  async function shutdown(): Promise<void> {
    logger.info('Worker shutting down');
    clearInterval(reaperTimer);
    clearInterval(silenceTimer);
    clearInterval(inactivityTimer);
    clearInterval(queueSampleTimer);
    await poller.stop();
    healthServer.close();
    await shutdownTracing();
    await queueSampleInFlight;
    await closePool();
    logger.info('Worker shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

// Auto-start only when run as the entrypoint (node dist/index.js / tsx watch).
// Under vitest (which sets VITEST) this module is imported to unit-test
// processInvestigateJob, so skip startup to avoid booting the poller/servers.
if (!process.env['VITEST']) {
  main().catch((err: unknown) => {
    logger.error('Worker failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
