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
  recordJobUsage,
  resolveEvidenceEventId,
} from './db.js';
import { buildReason, reasonCodeForDecision, reproductionRemediation } from './reason-codes.js';
import { logger, safeErrorMessage, setWorkerId } from './logger.js';
import { fetchObject, getMinIOConfig, putFrameObject } from './minio-client.js';
import { INVESTIGATION_MODEL, investigateError } from './investigate.js';
import { runPipeline } from './pipeline.js';
import { buildSessionUrl } from './narrative.js';
import { createPoller } from './poller.js';
import { cloneFailureReason, cloneRepo, isRetriableCloneFailure, sweepAbandonedClones } from './repo-clone.js';
import { buildRepoUrl } from './repo-url.js';
import { getInstallationToken } from './github-app.js';
import { type ReplaySignals } from './pr.js';

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
import { RULE_VERSION } from './friction/analyzer.js';
import { classifyActivity, deriveCoverage, extractSessionFacts, formatSessionContext } from './friction/facts.js';
import { replaceSessionFacts } from './facts/persist.js';
import { narrativeClientFromEnv } from './narrative/client.js';
import { processNarration } from './narrative/job.js';
import { NARRATIVE_PROMPT_VERSION } from './narrative/prompt.js';
import { captureFrames } from './narrative/frames/capture.js';
import { processFrameVerification } from './narrative/verify.js';
import { MachineUnavailableError, VerificationInfraError } from './harness/errors.js';
import {
  createReadOnlyCheckout,
  NO_VERIFICATION_EVIDENCE,
  toInfraError,
  type ReadOnlyCheckout,
} from './harness/readonly-sandbox.js';
import { processCIWatchJob } from './ci-watch.js';
import { processRouteMapJob } from './route-map.js';
import { runProductContext } from './product-context/job.js';
import { runInquiry } from './inquiry/job.js';
import { writeDigest } from './digest-writer/job.js';
import { loadEvidence, type EvidenceBundle } from './evidence/bundle.js';
import { effectivePlatform, pythonPipelineEnabled } from './platform.js';
import { parseRuntimeInfo } from './runtime-info.js';
import { parseDiagnosis } from './diagnosis-schema.js';
import { pushScore } from './scores.js';
import { processScoreSyncJob } from './score-sync.js';
import * as billing from './billing.js';
import { emitUsageEvent } from './usage-events.js';

function nonNegativeIntegerEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Maps the raw DB/SDK replay_signals JSON (nested, snake_case) to the flat camelCase
 * ReplaySignals interface used by pr.ts for PR body rendering.
 *
 * SDK format:  { event_type_counts, console: { error_count, ... }, network: { ... }, last_user_actions }
 * Worker format: { eventTypeCounts, consoleErrorCount, ..., lastUserActions }
 */
export function mapDbSignals(raw: unknown): ReplaySignals | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;

  const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(s, key);
  const hasKnownSignal = [
    'event_type_counts', 'console', 'network', 'last_user_actions',
    'eventTypeCounts', 'consoleErrorCount', 'consoleWarningCount',
    'consoleErrorMessages', 'consoleWarningMessages', 'networkAnomalyCount',
    'networkAnomalies', 'lastUserActions',
  ].some(hasOwn);
  if (!hasKnownSignal) return null;

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

  if (job.jobType === 'session_analysis') {
    if (!job.sessionId) throw new Error(`Job ${job.id} missing session_id`);
    await processSessionAnalysisJob(job as ClaimedJob & { sessionId: string }, signal);
    return;
  }

  if (job.jobType === 'session_narrate') {
    if (!job.sessionId) throw new Error(`Job ${job.id} missing session_id`);
    await processSessionNarrateJob(job as ClaimedJob & { sessionId: string }, signal);
    return;
  }

  if (job.jobType === 'session_verify_frames') {
    if (!job.sessionId) throw new Error(`Job ${job.id} missing session_id`);
    await processSessionVerifyFramesJob(job as ClaimedJob & { sessionId: string }, signal);
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

  if (job.jobType === 'issue_inquiry') {
    await runInquiry(job, signal);
    return;
  }

  if (job.jobType === 'digest_write') {
    if (!job.runId) throw new Error(`Digest writer job ${job.id} missing run_id`);
    await writeDigest(job.runId, job.projectId);
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

/** Compact, bounded rendering of the frozen evidence bundle for model
 * prompts. Never the raw JSON: a realistic bundle runs tens of kilobytes and
 * the prompt slots that carry this are capped, so a stringified bundle
 * arrived as a few hundred bytes of JSON cut mid-object. Every list is
 * top-N'd and every free-text field is length-clamped. */
function investigationEvidenceContext(evidence: EvidenceBundle): string {
  const clamp = (value: string, max: number): string => value.slice(0, max);
  const failed = evidence.failedRequests.slice(0, 8).map((r) =>
    `${clamp(r.method, 8)} ${clamp(r.endpointPattern, 80)} -> ${r.status} on ${clamp(r.pageRoute, 60)}`);
  const rollups = evidence.writeRollups.slice(0, 5).map((r) =>
    `${clamp(r.method, 8)} ${clamp(r.endpointPattern, 80)} ${r.statusClass}xx x${r.occurrenceCount}`);
  const routes = evidence.productContext.slice(0, 5).map((p) =>
    `${clamp(p.route, 60)}: ${clamp(p.purpose, 100)}`);
  const lines = [
    `Affected units: ${evidence.affectedUnits}`,
    `Availability: recording=${evidence.availability.recording}, sourceMap=${evidence.availability.sourceMap}`,
    failed.length > 0
      ? `Failed requests (${evidence.failedRequests.length} total, first ${failed.length}):\n  ${failed.join('\n  ')}`
      : 'Failed requests: none recorded',
    rollups.length > 0 ? `Successful-write rollups:\n  ${rollups.join('\n  ')}` : null,
    routes.length > 0 ? `Product context:\n  ${routes.join('\n  ')}` : null,
    `Replay pointers: ${evidence.replayPointers.length}`,
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

function preflightDecision(
  job: ClaimedJob,
  outcome: 'needs_human' | 'unable_to_establish_cause',
  reason: string,
): db.DecisionRow {
  return {
    outcome,
    decisionReason: reason,
    diagnosis: null,
    model: 'deterministic-preflight',
    promptVersion: 'diagnosis-v1',
    jobId: job.id,
    episodeId: job.episodeId ?? null,
    basis: 'no_evidence',
    confidence: 'low',
    policyEligible: true,
    policyBasis: null,
  };
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

  // Fair-use cap is enforced at the single claim-time seam before any model
  // or sandbox spend. Autumn documents send_event as an atomic allowed-check
  // consumption; denied non-consumption still needs the deployment sandbox
  // smoke because no sandbox credential was available during implementation.
  // Provider failures fail open inside checkQuota.
  if (billing.billingEnabled()) {
    const org = await billing.billingOrgForProject(db.getProjectOrg, job.projectId);
    if (org) {
      const quota = await billing.checkQuota(
        org.orgId,
        org.orgName,
        'investigations',
        { sendEvent: true },
      );
      if (!quota.allowed) {
        emitUsageEvent('investigation_quota_skipped', {
          org_id: org.orgId,
          project_id: job.projectId,
          error_group_id: job.errorGroupId,
        });
        return;
      }
    }
  }

  await updateGroupStatus(job.errorGroupId, job.projectId, 'analyzing', undefined, job);
  checkAbort(signal);

  if (group.kind === 'friction') {
    await processFrictionInvestigateJob(job, group, signal);
    return;
  }

  if (!job.episodeId) {
    throw new Error(`Investigation job ${job.id} missing episode_id`);
  }
  const evidence = await loadEvidence(job.projectId, job.episodeId);
  const event = await db.getErrorEvent(evidence.frames.sourceEventId, job.projectId);
  const customerRuntime = parseRuntimeInfo(event?.context ?? '');

  // Pre-clone guard: errors with no application stack frames (cross-origin
  // "Script error.", non-Error promise rejections) are inherently unfixable by
  // the agent. Short-circuit to needs_human BEFORE cloning the repo or spending
  // an LLM/sandbox. The reason code is non-retriable, so the single collapsed
  // stackless group won't reopen on every recurrence.
  if (hasNoAppFrames(event?.stack_trace_raw ?? '', platform)) {
    const reason = buildReason(
        'unfixable_no_app_frames',
        platform === 'python'
          ? 'The Python traceback has no application frames, so there is nothing safe to investigate.'
          : 'Error has no application stack frames (cross-origin "Script error." or a non-Error promise rejection), so there is nothing to investigate.',
        undefined,
        platform,
      );
    await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
      reason,
      decision: preflightDecision(job, 'unable_to_establish_cause', reason.reason_message),
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
    const reason = {
      reason_code: 'missing_llm_key' as const,
      reason_message: 'ANTHROPIC_API_KEY environment variable is not set',
      remediation: 'Set the ANTHROPIC_API_KEY environment variable with a valid Anthropic API key',
    };
    await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
      reason,
      decision: preflightDecision(job, 'needs_human', reason.reason_message),
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

  // Rent an isolated machine and clone into it. The customer's code is never
  // written to this shared host, and the worker-side model loop keeps the
  // Anthropic credential out of the machine entirely.
  let checkout: ReadOnlyCheckout;
  try {
    checkout = await createReadOnlyCheckout({
      repoUrl: buildRepoUrl(project.github_repo),
      commitSha: evidence.frames.commitSha ?? undefined,
      githubToken,
    });
  } catch (err: unknown) {
    // A machine that died or went unreachable during setup is infrastructure,
    // not a repository problem. Retry the durable job rather than telling the
    // customer their repository is inaccessible.
    if (err instanceof MachineUnavailableError || isRetriableCloneFailure(err)) {
      // A network blip is not a diagnosis. Fail the durable job so it retries
      // and, when exhausted, dead-letters into the operator's view instead of
      // becoming a customer-facing terminal.
      throw err;
    }
    const reason = cloneFailureReason(err);
    await updateGroupInvestigation(job.errorGroupId, job.projectId, 'needs_human', {
      reason,
      decision: preflightDecision(job, 'needs_human', reason.reason_message),
    }, job);
    jobsFailed++;
    lastJobAt = new Date().toISOString();
    return;
  }

  // Separate from the block above, because everything here runs with a machine
  // already rented. Leaving through the clone-failure catch would both bill the
  // machine until its 15-minute lifetime expired and report a database failure
  // to the customer as `repo_access_denied`.
  let investigatedCommit: string;
  try {
    investigatedCommit = checkout.headSha;
    // Empty when the branch could not be read, or when HEAD was already
    // detached. Caching it then would overwrite the project's real default
    // branch with a value we cannot stand behind.
    if (checkout.defaultBranch) {
      await db.cacheProjectDefaultBranch(job.projectId, checkout.defaultBranch);
    }
    // Stamp the checkout on the job row now, not inside the diagnosis: the
    // diagnosis is null exactly when the run fails, and those are the runs
    // whose checkout needs auditing.
    const requestedCommit = evidence.frames.commitSha ?? null;
    const fellBack = requestedCommit !== null
      && requestedCommit.toLowerCase() !== investigatedCommit.toLowerCase();
    await db.recordInvestigatedCommit(job, investigatedCommit);
    logger.info('Investigation checkout', {
      job_id: job.id,
      requested_commit: requestedCommit,
      investigated_commit: investigatedCommit,
      fell_back_to_default_head: fellBack,
    });
  } catch (err: unknown) {
    await checkout.close();
    throw err;
  }

  try {
    checkAbort(signal);

    // Run codebase-aware investigation
    const triage = await investigateError(apiKey, {
      platform,
      customerRuntime,
      errorType: event?.error_type ?? 'Unknown',
      title: group.title,
      errorMessage: event?.error_message ?? '',
      stackTrace: event?.stack_trace_raw ?? '',
      resolvedStackTrace: evidence.frames.envelope,
      breadcrumbs: event?.breadcrumbs ?? '[]',
      sessionContext: investigationEvidenceContext(evidence),
      investigationBrief: job.guidance,
    }, checkout.reader, investigatedCommit);
    await recordJobUsage({
      jobId: job.id,
      execution: job.attempts,
      phase: 'investigation',
      model: INVESTIGATION_MODEL,
      usage: triage.usage,
      costUsd: triage.costUsd,
    });
    checkAbort(signal);

    if (triage.stop === 'api_error') {
      const status = triage.apiErrorStatus;
      const detail = triage.apiErrorDetail ?? 'model call failed';
      const oversized = status === 400 && /prompt is too long|too many tokens|exceeds? .*(context|token)/i.test(detail);
      const deterministic = status !== undefined && status >= 400 && status < 500
        && status !== 408 && status !== 429 && !oversized;
      if (deterministic) {
        // A 4xx here is a request-construction failure — tool schema, model id,
        // auth — an operator bug that retries cannot fix and evidence did not
        // cause. Writing unable_to_establish_cause would blame missing evidence
        // for a config failure, so fail the durable job instead: it retries
        // cheaply (the call dies before any tokens) and dead-letters into the
        // operator's view with the real error.
        throw new Error(`Investigation model request rejected (HTTP ${status}): ${detail}`);
      }
      if (!oversized && job.attempts + 1 < (job.maxAttempts ?? 3)) {
        // A transient outage (429/5xx/network) with retry budget left retries
        // the same durable job rather than terminalizing the round on its
        // first bad minute. Exhausted budget falls through to the existing
        // unable_to_establish_cause terminal, which is the designed ending for
        // exhausted model failures. Oversized input also falls through: it is
        // deterministic per input, so retries cannot help, but it is an
        // evidence-shaped condition, not an operator bug.
        throw new Error(`Investigation model unavailable${status !== undefined ? ` (HTTP ${status})` : ''}; retrying: ${detail}`);
      }
    }

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
    const decision = {
      outcome: triage.outcome,
      decisionReason: triage.decisionReason,
      causeLocation: persistedDiagnosis?.cause_location ?? null,
      diagnosis: persistedDiagnosis,
      model: INVESTIGATION_MODEL,
      promptVersion: 'diagnosis-v1',
      jobId: job.id,
      episodeId: job.episodeId,
      // Persisted because the fix job loads this row to decide whether it may
      // run at all, and outcome alone cannot answer that.
      basis: triage.decisionBasis,
      confidence: triage.confidence,
      causeKind: triage.adjudication?.cause_kind,
      dispositions: triage.dispositions,
      // The cheap filter and inquiry already admitted this work round. The old
      // post-investigation reach check must not veto an accepted diagnosis.
      policyEligible: true,
      policyBasis: null,
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
        decision: { ...decision, outcome: 'unable_to_establish_cause' as const },
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
        decision: { ...decision, outcome: 'unable_to_establish_cause' as const },
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
        decision: { ...decision, outcome: 'needs_human' as const },
      }, job);
      jobsProcessed++;
      logger.info('Investigation: conclusion', { job_id: job.id, duration_ms: durationMs });

    } else {
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
    }

    // Both parking paths write the same row and differ only in what they log,
    // so the write happens once and the branch chooses the message.
    if (parked) {
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'investigated', {
        rootCause: triage.diagnosis?.one_line_description ?? triage.decisionReason,
        confidence: triage.confidence,
        decision: {
          ...decision,
          outcome: 'needs_human' as const,
        },
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
  } catch (err: unknown) {
    // Converted here, not inside investigateError: this is the only scope that
    // holds the machine identity the incident reports needed and never had.
    throw toInfraError(err, checkout, NO_VERIFICATION_EVIDENCE);
  } finally {
    await checkout.close();
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

  let checkout: ReadOnlyCheckout;
  try {
    checkout = await createReadOnlyCheckout({
      repoUrl: buildRepoUrl(project.github_repo),
      githubToken,
    });
    if (checkout.defaultBranch) {
      await db.cacheProjectDefaultBranch(job.projectId, checkout.defaultBranch);
    }
  } catch (error: unknown) {
    if (error instanceof MachineUnavailableError || isRetriableCloneFailure(error)) {
      // Same classification as the error pipeline: transient clone faults
      // retry the durable job instead of terminalizing the incident.
      throw error;
    }
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
    const narrativeObservation = await db.getLatestNarrativeSignalForGroup(
      job.errorGroupId,
      job.projectId,
    );
    checkAbort(signal);
    const result = await investigateFriction(apiKey, {
      group,
      evidence,
      reader: checkout.reader,
      tree: checkout.tree,
      sessionContext,
      narrativeObservation,
      investigatedCommit: checkout.headSha,
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
        promptVersion: 'friction-diagnosis-v3',
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
      promptVersion: 'friction-diagnosis-v3',
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
      if (impactBar?.eligible && autonomyAllowsFix) {
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
      // Decision 2026-09-01: a diagnosis that needs human or product judgment
      // is a reviewable finding rather than a terminal FYI. awaiting_approval
      // without a candidate diff renders as "Review the investigation." and
      // enters the digest's actionable lane via the lifecycle trigger.
      await updateGroupInvestigation(job.errorGroupId, job.projectId, 'awaiting_approval', {
        rootCause: verdict.reason,
        confidence: verdict.confidence,
        decision,
      }, job);
      logger.info('Friction investigation: diagnosis awaiting review (no code cause)', {
        job_id: job.id,
        confidence: verdict.confidence,
      });
    }
    jobsProcessed++;
    lastJobAt = new Date().toISOString();
  } catch (err: unknown) {
    throw toInfraError(err, checkout, NO_VERIFICATION_EVIDENCE);
  } finally {
    await checkout.close();
  }
}

export async function processSessionNarrateJob(
  job: ClaimedJob & { sessionId: string },
  signal: AbortSignal,
): Promise<void> {
  const client = narrativeClientFromEnv();
  if (!client) {
    logger.warn('Narrative model key unset; leaving reservation pending', {
      job_id: job.id,
      session_id: job.sessionId,
    });
    return;
  }
  const project = await db.getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} not found`);
  await processNarration(job, {
    client,
    loadChunks: async (sessionId, projectId) => {
      const chunks = await db.getScrubbedChunksForSession(sessionId, projectId);
      return (await readChunksBounded(chunks, { skipUnreadable: true })).envelopes;
    },
    dailyCap: nonNegativeIntegerEnv(process.env['NARRATIVE_DAILY_CAP'], 2_000),
    wallClockBudgetMs: nonNegativeIntegerEnv(process.env['NARRATIVE_RENDER_BUDGET_MS'], 60_000),
    appContext: process.env['NARRATIVE_APP_CONTEXT'] ?? '',
    projectName: project.name,
  }, signal);
}

export async function processSessionVerifyFramesJob(
  job: ClaimedJob & { sessionId: string },
  signal: AbortSignal,
): Promise<void> {
  const client = narrativeClientFromEnv();
  const storage = getMinIOConfig();
  await processFrameVerification(job, {
    client: client as NonNullable<typeof client>,
    supported: client !== null && storage !== null,
    loadChunks: async (sessionId, projectId) => {
      const chunks = await db.getScrubbedChunksForSession(sessionId, projectId);
      return (await readChunksBounded(chunks, { skipUnreadable: true })).envelopes;
    },
    capture: captureFrames,
    uploadFrame: async (objectKey, png) => {
      if (!storage) throw new Error('Replay store not configured');
      await putFrameObject(objectKey, png, storage);
    },
    dailyCap: nonNegativeIntegerEnv(process.env['NARRATIVE_DAILY_CAP'], 2_000),
  }, signal);
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
    await db.assertJobLease(job);
    const facts = extractSessionFacts(read.envelopes);
    const coverage = deriveCoverage({
      totalChunkCount: session.chunk_count,
      envelopeCount: read.envelopes.length,
      truncated: read.truncated,
    });
    const activityClass = classifyActivity(facts, coverage);
    const client = await db.getPool().connect();
    let narrativeReserved = false;
    try {
      await client.query('BEGIN');
      await replaceSessionFacts(session.project_id, session.id, {
        ...facts,
        ruleVersion: RULE_VERSION,
      }, client);
      await db.upsertSessionAnalysis({
        sessionId: session.id,
        projectId: session.project_id,
        environmentId: session.environment_id,
        sessionStartedAt: session.started_at,
        coverage,
        activityClass,
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
      }, client);
      if (activityClass === 'active') {
        narrativeReserved = await db.reserveNarrative(client, {
          sessionId: session.id,
          projectId: session.project_id,
          environmentId: session.environment_id,
          promptVersion: NARRATIVE_PROMPT_VERSION,
        });
      }
      await client.query('COMMIT');
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (narrativeReserved) {
      await db.enqueueJob('session_narrate', session.project_id, session.id);
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
 * and creates a PR or records an actionable failure.
 */
export async function processFixJob(job: ClaimedJob & { errorGroupId: string }, signal: AbortSignal): Promise<void> {
  const jobStart = Date.now();
  checkAbort(signal);

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

  if (group.kind !== 'friction' && !job.episodeId) {
    throw new Error(`Error fix job ${job.id} missing episode_id`);
  }
  const frozenEvidence = group.kind === 'friction'
    ? null
    : await loadEvidence(job.projectId, job.episodeId!);
  const event = frozenEvidence
    ? await db.getErrorEvent(frozenEvidence.frames.sourceEventId, job.projectId)
    : await loadEvidenceEvent(job, group);
  const customerRuntime = parseRuntimeInfo(event?.context ?? '');
  const project = await db.getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} not found`);

  // Stop before clone, sandbox, or model spend when the org has exhausted its
  // merged-fix-PR allowance. Provider failures fail open inside checkQuota.
  if (billing.billingEnabled()) {
    const org = await billing.billingOrgForProject(db.getProjectOrg, job.projectId);
    if (org) {
      const quota = await billing.checkQuota(org.orgId, org.orgName, 'merged_prs');
      if (!quota.allowed) {
        const reason = buildReason(
          'billing_limit_reached',
          'The monthly included fix-PR allowance for this organization is used up.',
        );
        await updateGroupStatus(job.errorGroupId, job.projectId, 'needs_human', {
          reason,
          terminalFixJobId: job.id,
        }, job);
        emitUsageEvent('billing_limit_reached', {
          org_id: org.orgId,
          project_id: job.projectId,
          error_group_id: job.errorGroupId,
        });
        return;
      }
    }
  }

  // Load investigation context
  const investigation = await getGroupInvestigation(job.errorGroupId, job.projectId);

  // Parallel fetch for independent data
  const frozenReplayPointer = frozenEvidence?.replayPointers[0];
  const [replay, sessionPointer, environmentContext] = await Promise.all([
    frozenEvidence ? Promise.resolve(null) : db.getReplayForGroup(job.errorGroupId, job.projectId),
    frozenEvidence
      ? Promise.resolve(frozenReplayPointer ? {
          session_id: frozenReplayPointer.sessionId,
          error_at: new Date(frozenReplayPointer.anchorMs).toISOString(),
        } : null)
      : db.getSessionPointerForGroup(job.errorGroupId, job.projectId),
    db.getEnvironmentNamesForGroup(job.errorGroupId, job.projectId, group.kind),
  ]);
  let watchUrl: string | null = null;
  try {
    const watchable = frozenReplayPointer
      ? { sessionId: frozenReplayPointer.sessionId, anchorMs: frozenReplayPointer.anchorMs }
      : frozenEvidence ? null : await db.getWatchableSessionForGroup(job.projectId, job.errorGroupId);
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
      commitSha: frozenEvidence?.frames.commitSha,
    });
    repoDir = cloneResult.repoDir;
    defaultBranch = cloneResult.defaultBranch;
    cleanup = cloneResult.cleanup;
    await db.cacheProjectDefaultBranch(job.projectId, defaultBranch);
    const requestedCommit = frozenEvidence?.frames.commitSha ?? null;
    await db.recordInvestigatedCommit(job, cloneResult.headSha);
    logger.info('Fix checkout', {
      job_id: job.id,
      requested_commit: requestedCommit,
      investigated_commit: cloneResult.headSha,
      fell_back_to_default_head: requestedCommit !== null
        && requestedCommit.toLowerCase() !== cloneResult.headSha.toLowerCase(),
    });
  } catch (err: unknown) {
    if (isRetriableCloneFailure(err)) {
      // A network blip is not a fix verdict: fail the durable job so it
      // retries and, when exhausted, dead-letters into the operator's view
      // (docs/contracts/reliability.md).
      throw err;
    }
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
      resolvedStackTrace: frozenEvidence?.frames.envelope
        ?? await resolvedFramesForEvent(event, job.projectId),
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
        guidance: frozenEvidence
          ? `${job.guidance ?? ''}\nFrozen evidence: ${investigationEvidenceContext(frozenEvidence)}`.slice(0, 4000)
          : job.guidance ?? undefined,
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
        await db.recordFixTerminalDecision({
          lease: job,
          episodeId: job.episodeId ?? null,
          outcome: 'verified_fix',
          reason: `A deterministic verification run passed and produced ${result.pr_url}.`,
          confidence: result.confidence ?? 'high',
        });
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
        await db.recordFixTerminalDecision({
          lease: job,
          episodeId: job.episodeId ?? null,
          outcome: 'verified_fix',
          reason: `A deterministic verification run passed and produced ${result.pr_url}.`,
          confidence: result.confidence ?? (result.status === 'pr_draft' ? 'medium' : 'high'),
        });
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
      const terminalReason = result.reason ?? buildReason('worker_runtime_error', 'Fix pipeline failed without a reason');
      await db.recordFixTerminalDecision({
        lease: job,
        episodeId: job.episodeId ?? null,
        outcome: 'needs_human',
        reason: `${terminalReason.reason_message} Required action: ${terminalReason.remediation}`,
        confidence: result.confidence ?? 'low',
      });
      await updateGroupStatus(job.errorGroupId, job.projectId, 'needs_human', {
        reason: terminalReason,
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
  logger.info('usage events', {
    enabled: Boolean(process.env['USAGE_EVENTS_SLACK_WEBHOOK']),
  });

  // Clone checkouts orphaned by a crashed worker process. Age-gated inside:
  // a live long fix run's directory is never touched.
  const sweptClones = await sweepAbandonedClones();
  if (sweptClones > 0) {
    logger.info('Swept abandoned clone directories', { count: sweptClones });
  }

  const requiredEnv = ['DATABASE_URL'];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      logger.error('Missing required environment variable', { key });
      process.exit(1);
    }
  }

  // Warn about optional env vars that will cause job failures if missing
  const warnEnv = [
    'ANTHROPIC_API_KEY', 'E2B_API_KEY', 'OPSLANE_E2B_JAVASCRIPT_TEMPLATE', 'GITHUB_TOKEN',
  ];
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

  const narrativeSweepTimer = setInterval(() => {
    db.sweepNarratives()
      .then(({ reEnqueued, failed }) => {
        if (reEnqueued > 0 || failed > 0) {
          logger.info('Narrative sweeper completed', { re_enqueued: reEnqueued, failed });
        }
      })
      .catch((err: unknown) => {
        logger.error('Narrative sweeper error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, 5 * 60_000);

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
    clearInterval(narrativeSweepTimer);
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
