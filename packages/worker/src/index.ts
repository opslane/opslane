import crypto from 'node:crypto';
import http from 'node:http';
import type { ClaimedJob, ErrorEventData, QueueDepthRow } from './db.js';
import type { SessionChunkEnvelope } from '@opslane/shared';
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
  recordJobUsage,
  resolveEvidenceEventId,
} from './db.js';
import { buildReason, reasonCodeForDecision, reproductionRemediation } from './reason-codes.js';
import { logger, safeErrorMessage, setWorkerId } from './logger.js';
import { fetchObject, getMinIOConfig } from './minio-client.js';
import { INVESTIGATION_MODEL, investigateError } from './investigate.js';
import { runPipeline } from './pipeline.js';
import { buildSessionUrl } from './narrative.js';
import { createPoller } from './poller.js';
import { buildRepoUrl, cloneFailureReason, cloneRepo } from './repo-clone.js';
import { getInstallationToken } from './github-app.js';
import { type ReplaySignals } from './pr.js';
import { processSetupPrJob } from './setup-pr.js';

import type { ResolvedFrame } from './source-map.js';
import { framesFromEnvelope } from './resolve-stack.js';
import { runStackResolve } from './resolve/job.js';
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
import { FRICTION_INVESTIGATION_MODEL, investigateFriction } from './friction/investigate-friction.js';
import { readChunksBounded } from './friction/chunk-reader.js';
import { analyzeSession, RULE_VERSION } from './friction/analyzer.js';
import { classifyActivity, deriveCoverage, extractSessionFacts, formatSessionContext } from './friction/facts.js';
import { replaceSessionFacts } from './facts/persist.js';
import { writeFrictionSignals } from './friction/persist.js';
import { processFrictionOutcomes } from './friction/promotion.js';
import {
  createAnthropicAdjudicator,
  type Adjudicator,
  type EvidenceWindowMode,
} from './friction/adjudicator.js';
import { buildEvidenceWindows, EVIDENCE_WINDOW_MS } from './friction/evidence-window.js';
import { VerificationInfraError } from './harness/errors.js';
import { processCIWatchJob } from './ci-watch.js';
import { processRouteMapJob } from './route-map.js';
import { runProductContext } from './product-context/job.js';
import { effectivePlatform, pythonPipelineEnabled } from './platform.js';
import { parseRuntimeInfo } from './runtime-info.js';
import { parseDiagnosis } from './diagnosis-schema.js';
import { pushScore } from './scores.js';
import { processScoreSyncJob } from './score-sync.js';

/** Injectable seam: unit tests and the e2e gate substitute a deterministic
 * adjudicator; production uses the real Anthropic-backed one. */
let frictionAdjudicatorFactory: (apiKey: string, mode: EvidenceWindowMode) => Adjudicator = createAnthropicAdjudicator;
export function setFrictionAdjudicatorFactory(
  factory: (apiKey: string, mode: EvidenceWindowMode) => Adjudicator,
): void {
  frictionAdjudicatorFactory = factory;
}

const configuredEvidenceWindowMode = process.env['ADJUDICATION_EVIDENCE_WINDOWS'] ?? 'off';
const evidenceWindowMode: EvidenceWindowMode = ['off', 'shadow', 'on'].includes(configuredEvidenceWindowMode)
  ? configuredEvidenceWindowMode as EvidenceWindowMode
  : 'off';
if (evidenceWindowMode !== configuredEvidenceWindowMode) {
  logger.warn('Invalid ADJUDICATION_EVIDENCE_WINDOWS; using off', {
    configured: configuredEvidenceWindowMode,
  });
}
const configuredDailyCap = Number(process.env['ADJUDICATION_DAILY_CAP'] ?? 500);
const adjudicationDailyCap = Number.isInteger(configuredDailyCap) && configuredDailyCap >= 0
  ? configuredDailyCap
  : 500;
if (adjudicationDailyCap !== configuredDailyCap) {
  logger.warn('Invalid ADJUDICATION_DAILY_CAP; using 500', { configured: configuredDailyCap });
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

// Investigate and fix prompts read the resolution the stack_resolve job
// persisted; events resolved before that job existed fall back to the legacy
// column on the event row.
async function resolvedFramesForEvent(
  event: ErrorEventData | null,
  projectId: string,
): Promise<ResolvedFrame[] | null> {
  if (!event) return null;
  return framesFromEnvelope(await db.getResolvedEnvelope(event.id, projectId))
    ?? framesFromEnvelope(event.stack_trace_resolved);
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

  if (job.jobType === 'route_map') {
    await processRouteMapJob(job, signal);
    return;
  }

  if (job.jobType === 'product_context') {
    await runProductContext(job, signal);
    return;
  }

  if (job.jobType === 'score_sync') {
    await processScoreSyncJob(job);
    return;
  }

  if (job.jobType === 'stack_resolve') {
    await runStackResolve(job);
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
  } else if (errorJob.jobType === 'investigate' || errorJob.jobType === 'error_fix') {
    await processInvestigateJob(errorJob, signal);
  } else {
    // Never fall through to a paid investigation: a job type this binary does
    // not know (enqueued by a newer ingestion during a skewed deploy) must
    // fail loudly and dead-letter instead of silently investigating a group
    // that may already be terminal.
    throw new Error(`Unknown job_type '${errorJob.jobType}' for job ${errorJob.id}`);
  }
}

/**
 * Loads the evidence event for a job: the anchored triggering event when it
 * still exists, else the group's mutable sample. Retention can delete the
 * anchor between claim and read (the FK's SET NULL lands after the claim
 * snapshot), and analyzing with the sample beats analyzing with no event.
 */
async function loadEvidenceEvent(
  job: { eventId: string | null; projectId: string },
  group: { sample_event_id: string | null },
) {
  const anchorEventId = resolveEvidenceEventId(job, group);
  let event = anchorEventId
    ? await db.getErrorEvent(anchorEventId, job.projectId)
    : null;
  if (!event && group.sample_event_id && group.sample_event_id !== anchorEventId) {
    event = await db.getErrorEvent(group.sample_event_id, job.projectId);
  }
  return event;
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

  const event = await loadEvidenceEvent(job, group);
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
  let investigatedCommit: string;
  let cleanup: () => Promise<void>;
  try {
    const cloneResult = await cloneRepo({
      githubRepo: project.github_repo,
      jobId: job.id,
      githubToken,
    });
    repoDir = cloneResult.repoDir;
    investigatedCommit = cloneResult.headSha;
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
    checkAbort(signal);

    const sessionPointer = await db.getSessionPointerForGroup(job.errorGroupId, job.projectId);
    const sessionAnalysis = sessionPointer
      ? await db.getSessionAnalysis(sessionPointer.session_id, job.projectId)
      : null;
    const sessionContext = sessionAnalysis ? formatSessionContext(sessionAnalysis) : null;

    // Run codebase-aware investigation
    const triage = await investigateError(apiKey, {
      platform,
      customerRuntime,
      errorType: event?.error_type ?? 'Unknown',
      title: group.title,
      errorMessage: event?.error_message ?? '',
      stackTrace: event?.stack_trace_raw ?? '',
      resolvedStackTrace: await resolvedFramesForEvent(event, job.projectId),
      breadcrumbs: event?.breadcrumbs ?? '[]',
      sessionContext,
    }, repoDir, investigatedCommit);
    await recordJobUsage({
      jobId: job.id,
      execution: job.attempts,
      phase: 'investigation',
      model: INVESTIGATION_MODEL,
      usage: triage.usage,
      costUsd: triage.costUsd,
    });
    checkAbort(signal);

    logger.info('Investigation result', {
      job_id: job.id,
      fixable: triage.fixable,
      confidence: triage.confidence,
      reason: triage.reason,
    });

    const durationMs = Date.now() - jobStart;
    const persistedDiagnosis = triage.diagnosis
      ? {
        ...triage.diagnosis,
        evidence: triage.evidence,
        agentTaskBrief: triage.agentTaskBrief ?? undefined,
        investigatedCommit: triage.investigatedCommit,
      }
      : null;
    const impactBar = triage.outcome === 'code_fix'
      ? await db.getGroupImpactBar(job.errorGroupId, job.projectId)
      : null;
    const decision = {
      outcome: triage.outcome,
      decisionReason: triage.decisionReason,
      causeLocation: persistedDiagnosis?.cause_location ?? null,
      diagnosis: persistedDiagnosis,
      model: INVESTIGATION_MODEL,
      promptVersion: 'diagnosis-v1',
      jobId: job.id,
      // Persisted because the fix job loads this row to decide whether it may
      // run at all, and outcome alone cannot answer that.
      basis: triage.decisionBasis,
      confidence: triage.confidence,
      causeKind: triage.adjudication?.cause_kind,
      dispositions: triage.dispositions,
      ...db.policyFields(impactBar),
    };

    /** Set when the result is held for a human instead of opening a fix job. */
    let parked = false;
    let kindGateRefusal: string | null = null;

    if (triage.outcome === 'incomplete') {
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
        rootCause: null,
        confidence: triage.confidence,
        reason: {
          reason_code: 'insufficient_context',
          reason_message: triage.decisionReason,
          remediation: 'Re-run the investigation after more evidence accumulates; the previous run could not verify a cause.',
        },
        decision,
      }, job);
      jobsFailed++;
      logger.warn('Investigation: needs_human (unverified verdict)', {
        job_id: job.id, duration_ms: durationMs,
      });

    } else if (triage.outcome === 'needs_more_context') {
      // decisionReason here is model-derived prose from an UNVALIDATED verdict.
      // It must not reach any rendered field: the readiness gate nulls
      // root_cause on the API, but reason_message renders ungated, so both get
      // computed copy. The prose survives in the decision row for forensics.
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
        rootCause: null,
        confidence: triage.confidence,
        reason: {
          reason_code: 'insufficient_context',
          reason_message: 'The investigation could not establish a verified cause from the available evidence.',
          remediation: 'Review the error manually; the investigation could not establish a cause.',
        },
        decision,
      }, job);
      jobsFailed++;
      logger.warn('Investigation: needs_human (no usable diagnosis)', {
        job_id: job.id, duration_ms: durationMs,
      });

    } else if (triage.outcome === 'not_actionable') {
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'insight', {
        rootCause: triage.diagnosis?.one_line_description ?? triage.decisionReason,
        confidence: triage.confidence,
        reason: {
          // Read the outcome, never the prose. Matching substrings of our own
          // message meant rewording it silently changed the reason code.
          reason_code: reasonCodeForDecision(decision),
          reason_message: triage.decisionReason,
          remediation: reproductionRemediation(
            triage.diagnosis?.reproduction_steps ?? [],
            'Investigate the named system; no reproduction steps were established.',
          ),
        },
        decision,
      }, job);
      jobsProcessed++;
      logger.info('Investigation: conclusion', { job_id: job.id, duration_ms: durationMs });

    } else if (impactBar?.eligible && job.triggeredBy !== 'reinvestigate_report_only') {
      const fixResult = await updateGroupAndCreateFixJob(job.errorGroupId, job.projectId, {
        rootCause: triage.diagnosis?.one_line_description ?? triage.decisionReason,
        diagnosis: triage.diagnosis,
        confidence: triage.confidence,
        platform,
        decision,
        sourceJobId: job.id,
      }, job);
      if (fixResult.created) {
        jobsProcessed++;
        logger.info('Investigation: auto-triggering fix', {
          job_id: job.id, fix_job_id: fixResult.fixJobId, duration_ms: durationMs,
        });
      } else {
        // Defense-in-depth refusal (kind gate): park the result for a human
        // instead of silently dropping the investigation.
        parked = true;
        kindGateRefusal = fixResult.reason ?? 'refused';
      }
    } else {
      parked = true;
    }

    // Both parking paths write the same row and differ only in what they log,
    // so the write happens once and the branch chooses the message.
    if (parked) {
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'investigated', {
        rootCause: triage.diagnosis?.one_line_description ?? triage.decisionReason,
        confidence: triage.confidence,
        decision,
      }, job);
      jobsProcessed++;
      if (kindGateRefusal) {
        logger.warn('Investigation: automatic fix refused by kind gate', {
          job_id: job.id, reason: kindGateRefusal, duration_ms: durationMs,
        });
      } else {
        logger.info('Investigation: investigated (awaiting user)', {
          job_id: job.id, confidence: triage.confidence, duration_ms: durationMs,
        });
      }
    }

    const outcomeTraceId = getActiveTraceId();
    if (outcomeTraceId) {
      try {
        await pushScore({
          traceId: outcomeTraceId,
          name: 'diagnosis_outcome',
          value: triage.outcome,
          dataType: 'CATEGORICAL',
          id: `diagnosis-outcome-${job.id}-${job.attempts}`,
        });
        if (triage.confidence) {
          await pushScore({
            traceId: outcomeTraceId,
            name: 'diagnosis_confidence',
            value: triage.confidence,
            dataType: 'CATEGORICAL',
            id: `diagnosis-confidence-${job.id}-${job.attempts}`,
          });
        }
      } catch (err: unknown) {
        logger.warn('diagnosis score push failed', {
          job_id: job.id,
          error: safeErrorMessage(err),
        });
      }
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
    const evidenceSessionID = evidence?.signals[0]?.session_id;
    const sessionAnalysis = evidenceSessionID
      ? await db.getSessionAnalysis(evidenceSessionID, job.projectId)
      : null;
    const sessionContext = sessionAnalysis ? formatSessionContext(sessionAnalysis) : null;
    checkAbort(signal);
    const result = await investigateFriction(apiKey, {
      group,
      evidence,
      repoPath: clone.repoDir,
      sessionContext,
      investigatedCommit: clone.headSha,
    });
    await recordJobUsage({
      jobId: job.id,
      execution: job.attempts,
      phase: 'investigation',
      model: FRICTION_INVESTIGATION_MODEL,
      usage: result.usage,
      costUsd: result.costUsd,
    });
    checkAbort(signal);
    if (result.status === 'incomplete') {
      const decision = {
        outcome: 'incomplete' as const,
        decisionReason: result.reason,
        causeLocation: null,
        // The rejected verdict's evidence and brief are kept for forensics.
        // They never render: incomplete decisions are readiness-ineligible and
        // GetLatestAgentTaskBrief filters to validated outcomes.
        diagnosis: {
          evidence: result.rejected?.evidence ?? [],
          agentTaskBrief: result.rejected?.agentTaskBrief ?? null,
          investigatedCommit: result.investigatedCommit,
        },
        model: FRICTION_INVESTIGATION_MODEL,
        promptVersion: 'friction-diagnosis-v2',
        jobId: job.id,
        basis: 'friction_classify' as const,
        confidence: 'low' as const,
      };
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
        rootCause: null,
        confidence: 'low',
        reason: {
          reason_code: 'insufficient_context',
          reason_message: result.reason,
          remediation: 'Re-run the investigation after more evidence accumulates; the previous run could not verify a cause.',
        },
        decision,
      }, job);
      jobsFailed++;
      lastJobAt = new Date().toISOString();
      return;
    }

    const verdict = result.verdict;
    const impactBar = verdict.codeCause
      ? await db.getFrictionGroupImpactBar(job.errorGroupId, job.projectId)
      : null;
    const decision = {
      outcome: verdict.codeCause ? 'code_fix' as const : 'not_actionable' as const,
      decisionReason: verdict.reason,
      causeLocation: verdict.evidence.map((citation) => citation.path).join(', ') || null,
      diagnosis: {
        evidence: verdict.evidence,
        agentTaskBrief: verdict.agentTaskBrief,
        investigatedCommit: result.investigatedCommit,
        verdict,
      },
      model: FRICTION_INVESTIGATION_MODEL,
      promptVersion: 'friction-diagnosis-v2',
      jobId: job.id,
      basis: 'friction_classify' as const,
      confidence: verdict.confidence,
      ...db.policyFields(impactBar),
    };

    if (verdict.codeCause) {
      // auto_fix_ux shares the code-caused auto-fix path until UX-suggestion
      // fixes exist; insights remain terminal and never produce a PR.
      const autonomyAllowsFix = project.friction_autonomy === 'auto_fix'
        || project.friction_autonomy === 'auto_fix_ux';
      if (impactBar?.eligible && autonomyAllowsFix && job.triggeredBy !== 'reinvestigate_report_only') {
        // allowFriction is the ladder's explicit opt-in past the kind gate;
        // refuse-by-default stays intact for every other caller (issue #56).
        const fixResult = await updateGroupAndCreateFixJob(job.errorGroupId, job.projectId, {
          rootCause: verdict.reason,
          confidence: verdict.confidence,
          sourceJobId: job.id,
          decision,
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
            rootCause: verdict.reason,
            confidence: verdict.confidence,
            decision,
          }, job);
          logger.warn('Friction investigation: auto-fix refused by kind gate — parked for approval', {
            job_id: job.id,
            reason: fixResult.reason,
          });
        }
      } else {
        await updateGroupInvestigation(job.errorGroupId, job.projectId, 'awaiting_approval', {
          rootCause: verdict.reason,
          confidence: verdict.confidence,
          decision,
        }, job);
        logger.info('Friction investigation: awaiting human approval', {
          job_id: job.id,
          confidence: verdict.confidence,
        });
      }
    } else {
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'insight', {
        rootCause: verdict.reason,
        confidence: verdict.confidence,
        decision,
      }, job);
      logger.info('Friction investigation: recorded insight', {
        job_id: job.id,
        confidence: verdict.confidence,
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
    const read = await readChunksBounded(chunks, { skipUnreadable: true });
    if (read.unreadableCount > 0) {
      // Skipped chunks degrade coverage below 'complete'. Log it: otherwise a
      // corrupt-chunk session is indistinguishable from a short one.
      logger.warn('Session analysis skipped unreadable chunks', {
        job_id: job.id,
        session_id: job.sessionId,
        unreadable_chunks: read.unreadableCount,
        readable_chunks: read.envelopes.length,
      });
    }
    checkAbort(signal);
    const signals = analyzeSession(read.envelopes);
    await db.assertJobLease(job);
    const facts = extractSessionFacts(read.envelopes);
    const coverage = deriveCoverage({
      totalChunkCount: session.chunk_count,
      envelopeCount: read.envelopes.length,
      truncated: read.truncated,
    });
    await replaceSessionFacts(session.project_id, session.id, {
      ...facts,
      ruleVersion: RULE_VERSION,
    });
    await db.upsertSessionAnalysis({
      sessionId: session.id,
      projectId: session.project_id,
      environmentId: session.environment_id,
      sessionStartedAt: session.started_at,
      coverage,
      activityClass: classifyActivity(facts, coverage),
      entryPath: facts.entryPath,
      clickCount: facts.clickCount,
      inputEventCount: facts.inputEventCount,
      pageEventCount: facts.pageEventCount,
      failedRequest4xxCount: facts.failedRequest4xxCount,
      failedRequest5xxCount: facts.failedRequest5xxCount,
      unattributedFailedRequestCount: facts.unattributedFailedRequestCount,
      successfulWriteCount: facts.successfulWriteCount,
      failedWriteCount: facts.failedWriteCount,
      ruleVersion: RULE_VERSION,
    });
    await writeFrictionSignals(session, signals, RULE_VERSION);
    // Batch 4: adjudicate → fold/aggregate before the session is marked
    // analyzed, so a crash retries the whole ordered pass. Keyless
    // deployments skip adjudication; signals stay pending and invisible.
    const adjudicationKey = process.env['ANTHROPIC_API_KEY'];
    if (adjudicationKey) {
      checkAbort(signal);
      await processFrictionOutcomes(
        session,
        job.id,
        frictionAdjudicatorFactory(adjudicationKey, evidenceWindowMode),
        {
          windowMode: evidenceWindowMode,
          dailyCap: adjudicationDailyCap,
          loadWindows: async (candidate) => {
            const occurredAts = candidate.occurred_ats ?? [];
            if (occurredAts.length === 0) return [];
            const envelopesBySeq = new Map<number, SessionChunkEnvelope>();
            for (const occurredAt of occurredAts) {
              const rangeChunks = await db.getScrubbedChunksInRange(
                candidate.session_id,
                candidate.project_id,
                occurredAt - EVIDENCE_WINDOW_MS,
                occurredAt + EVIDENCE_WINDOW_MS,
              );
              const unseen = rangeChunks.filter((chunk) => !envelopesBySeq.has(chunk.seq));
              if (unseen.length === 0) continue;
              const windowRead = await readChunksBounded(unseen, { skipUnreadable: true });
              windowRead.envelopes.forEach((envelope, index) => {
                const seq = windowRead.envelopeSeqs[index];
                if (seq !== undefined) envelopesBySeq.set(seq, envelope);
              });
            }
            return buildEvidenceWindows([...envelopesBySeq.values()], occurredAts);
          },
        },
      );
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

  // Report-only attribution is only valid for investigation jobs. Refuse a
  // malformed/stale fix job before any group read or mutation, and narrow the
  // trigger type passed into the fix pipeline below.
  if (job.triggeredBy === 'reinvestigate_report_only') {
    logger.warn('Refused report-only fix job', {
      job_id: job.id,
      error_group_id: job.errorGroupId,
    });
    return;
  }

  // Fetch real data
  const group = await db.getErrorGroup(job.errorGroupId, job.projectId);
  if (!group) throw new Error(`Error group ${job.errorGroupId} not found`);
  const platform = job.platform ?? effectivePlatform(group.platform, pythonPipelineEnabled());

  if (group.terminal_fix_job_id === job.id) {
    logger.info('Fix delivery already committed; adopting existing state', {
      job_id: job.id,
      error_group_id: job.errorGroupId,
      status: group.status,
    });
    return;
  }
  if (group.status === 'pr_created' || group.status === 'pr_draft' || group.status === 'needs_human') {
    logger.warn('Refused terminal state owned by another fix job', {
      job_id: job.id,
      terminal_fix_job_id: group.terminal_fix_job_id ?? null,
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

  const event = await loadEvidenceEvent(job, group);
  const customerRuntime = parseRuntimeInfo(event?.context ?? '');
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
  let watchUrl: string | null = null;
  try {
    const watchable = await db.getWatchableSessionForGroup(job.projectId, job.errorGroupId);
    if (watchable) {
      watchUrl = buildSessionUrl(process.env['DASHBOARD_URL'], watchable.sessionId, watchable.anchorMs, job.projectId);
    }
  } catch (err: unknown) {
    logger.warn('Failed to load coverage-proven recording link', {
      project_id: job.projectId,
      error_group_id: job.errorGroupId,
      error: String(err),
    });
  }
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
      terminalFixJobId: job.id,
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
      usageContext: { jobId: job.id, execution: job.attempts },
      errorGroupId: job.errorGroupId,
      projectId: job.projectId,
      title: group.title,
      errorType: event?.error_type ?? 'Unknown',
      errorMessage: event?.error_message ?? '',
      stackTrace: event?.stack_trace_raw ?? '',
      resolvedStackTrace: await resolvedFramesForEvent(event, job.projectId),
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
      triggeredBy: job.triggeredBy,
      sourceJobId: job.sourceJobId ?? null,
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
        diagnosis: (() => {
          if (!job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) return null;
          const raw = (job.payload as Record<string, unknown>)['diagnosis'];
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
          return parseDiagnosis(raw as Record<string, unknown>);
        })(),
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
      occurrenceCount: group.occurrence_count,
      impact: {
        class: group.impact_class ?? null,
        visits: group.impact_visits ?? null,
        recovered: group.impact_visits_recovered ?? null,
      },
      watchUrl,
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
          terminalFixJobId: job.id,
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
        terminalFixJobId: job.id,
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
