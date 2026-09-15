import { randomUUID } from 'node:crypto';
import { calculateCost } from '@opslane/agent-core';
import {
  RunLogger,
  RUN_LOG_SCHEMA_VERSION,
  runObjectPrefix,
  parseInputBundle,
  type FinishedRow,
  type StartedRow,
  type ImageRef,
  type LoggedEvent,
  type RepositoryRef,
  type RunStop,
  type RunUsage,
} from '@opslane/agent-runs';
import { pricingFor } from '../harness/agent-loop.js';
import { MachineUnavailableError } from '../harness/errors.js';
import { scrubRunLogText, scrubValue } from '../harness/redact.js';
import { logger, safeErrorMessage } from '../logger.js';
import type { RunContext } from './context.js';
import { countRunLogFailure, storageSink, type RunLogFailureKind, type RunLogSink } from './sink.js';

export const OBJECT_DEADLINE_MS = 5_000;
export const ROW_DEADLINE_MS = 3_000;
export const MIN_LEASE_MS = 60_000;

export function workerBuildSha(env: NodeJS.ProcessEnv = { OPSLANE_BUILD_SHA: process.env['OPSLANE_BUILD_SHA'] }): string {
  return env['OPSLANE_BUILD_SHA']?.trim() || 'unknown';
}

/** Parsed exactly like LEASE_DURATION_MS in index.ts. Logging adds up to ~16 s per run. */
export function runLogsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const lease = parseInt(env['LEASE_DURATION_MS'] ?? '300000', 10);
  return Number.isFinite(lease) && lease >= MIN_LEASE_MS;
}

export interface RunHandle {
  readonly runId: string | null;
  /** Count one provider call without logging its request (multi-turn gateways log what they append). */
  countRequest(): void;
  /** Count one provider call. The first request is in the bundle; later ones are logged as re-asks. */
  noteRequest(request: unknown): void;
  event(event: LoggedEvent): void;
  /** Replace summed response usage with authoritative per-model totals. */
  replaceUsage(totals: Record<string, RunUsage>): void;
}

export const NOOP_RUN: RunHandle = {
  runId: null,
  countRequest: () => undefined,
  noteRequest: () => undefined,
  event: () => undefined,
  replaceUsage: () => undefined,
};

export interface OpenRunOptions {
  context: RunContext | null;
  phase: string;
  entryPoint: string;
  models: string[];
  settings: Record<string, unknown>;
  structuredInput: unknown;
  request: unknown;
  images?: ImageRef[];
  repository?: RepositoryRef | null;
  commitSha?: string | null;
}

export interface RunLogDeps {
  sink: RunLogSink | null;
  enabled: boolean;
  now: () => Date;
  newRunId: () => string;
  buildSha: string;
}

let defaultDeps: RunLogDeps | null = null;

export function defaultRunLogDeps(): RunLogDeps {
  defaultDeps ??= {
    sink: storageSink(),
    enabled: runLogsEnabled(),
    now: () => new Date(),
    newRunId: randomUUID,
    buildSha: workerBuildSha(),
  };
  return defaultDeps;
}

/** Test-only override of the process-wide deps; pass null to restore. */
export function setRunLogDepsForTests(deps: RunLogDeps | null): void {
  defaultDeps = deps;
}

function stopForError(error: unknown): RunStop {
  try {
    if (error instanceof MachineUnavailableError) return 'machine_lost';
    if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  } catch { /* hostile thrown values still have a stop */ }
  return 'threw';
}

function errorClassOf(error: unknown): string {
  try {
    return scrubRunLogText(error instanceof Error ? String(error.name) : typeof error).slice(0, 200);
  } catch {
    return 'unknown';
  }
}

function quietly(fn: () => void): void {
  try { fn(); } catch { /* run logging must not affect the run */ }
}

async function attempt(kind: RunLogFailureKind, runId: string, write: () => Promise<void>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error: unknown) {
    countRunLogFailure(kind);
    quietly(() => logger.warn('run log write failed', { kind, run_id: runId, error: scrubRunLogText(safeErrorMessage(error)).slice(0, 500) }));
    return false;
  }
}

interface OpenRun {
  runId: string;
  objectPrefix: string;
  startedAt: Date;
  transcript: RunLogger;
  handle: RunHandle;
  requests: () => number;
}

/** Everything that can throw before the work starts. A failure here means the run is not logged. */
function openRun(options: OpenRunOptions, context: RunContext, deps: RunLogDeps): { open: OpenRun; bundleBody: string } {
  const runId = deps.newRunId();
  const startedAt = deps.now();
  const objectPrefix = runObjectPrefix(context.projectId, runId, startedAt);
  const transcript = new RunLogger({ now: deps.now, scrub: scrubValue });
  let requests = 0;
  const handle: RunHandle = {
    runId,
    countRequest: () => quietly(() => { requests++; }),
    noteRequest: (request) => quietly(() => {
      requests++;
      if (requests > 1) transcript.add({ type: 'request', request });
    }),
    event: (event) => quietly(() => transcript.add(event)),
    replaceUsage: (totals) => quietly(() => transcript.replaceUsage(totals)),
  };
  const bundleBody = JSON.stringify(parseInputBundle(scrubValue({
    schemaVersion: RUN_LOG_SCHEMA_VERSION,
    runId,
    phase: options.phase,
    entryPoint: options.entryPoint,
    workerBuildSha: deps.buildSha,
    repository: options.repository ?? null,
    settings: options.settings,
    structuredInput: options.structuredInput,
    request: options.request,
    images: options.images ?? [],
  })));
  return { open: { runId, objectPrefix, startedAt, transcript, handle, requests: () => requests }, bundleBody };
}

/**
 * Log one run. The bundle and started row are written before `work`; the
 * transcript and finished row are always written after it. The returned
 * promise settles exactly as `work` settles: no logging failure reaches the caller.
 */
export async function withRunLog<T>(
  options: OpenRunOptions,
  work: (run: RunHandle) => Promise<T>,
  classify: (result: T) => RunStop,
  providedDeps?: RunLogDeps,
): Promise<T> {
  const prepared = (() => {
    try {
      const deps = providedDeps ?? defaultRunLogDeps();
      const context = options.context;
      const sink = deps.sink;
      if (!context || !deps.enabled || !sink) return null;
      return { deps, context, sink, ...openRun(options, context, deps) };
    } catch (error: unknown) {
      countRunLogFailure('setup');
      quietly(() => logger.warn('run log setup failed', { phase: scrubRunLogText(options.phase), error: scrubRunLogText(safeErrorMessage(error)).slice(0, 500) }));
      return null;
    }
  })();
  // Invoke work outside the setup catch: even a synchronous throw must run once.
  if (!prepared) return work(NOOP_RUN);
  const { deps, context, sink, open, bundleBody } = prepared;

  const bundleWritten = await attempt('bundle', open.runId, () =>
    sink.putObject(`${open.objectPrefix}input.json`, bundleBody, 'application/json', OBJECT_DEADLINE_MS));
  await attempt('started_row', open.runId, async () => sink.insertStarted(scrubValue({
    runId: open.runId,
    jobId: context.jobId,
    jobType: context.jobType,
    projectId: context.projectId,
    phase: options.phase,
    entryPoint: options.entryPoint,
    attempts: context.attempts,
    leaseGeneration: context.leaseGeneration,
    errorGroupId: context.errorGroupId,
    ticketId: context.ticketId,
    episodeId: context.episodeId,
    batchId: context.batchId,
    sessionId: context.sessionId,
    commitSha: options.commitSha ?? options.repository?.commitSha ?? null,
    objectPrefix: open.objectPrefix,
    models: options.models,
    workerBuildSha: deps.buildSha,
    bundleWritten,
    bundleBytes: bundleWritten ? Buffer.byteLength(bundleBody, 'utf8') : 0,
    recordedAt: open.startedAt,
  }) as StartedRow, ROW_DEADLINE_MS));

  let stop: RunStop = 'threw';
  let failure: { value: unknown } | null = null;
  let result: T | undefined;
  try {
    result = await work(open.handle);
  } catch (error: unknown) {
    failure = { value: error };
  }

  try {
    if (failure) {
      stop = stopForError(failure.value);
      const value = failure.value;
      quietly(() => open.transcript.add({
        type: 'error',
        errorClass: errorClassOf(value),
        message: scrubRunLogText(safeErrorMessage(value)).slice(0, 2_000),
        stack: value instanceof Error ? String(value.stack ?? '').split('\n').slice(1, 11).map((line) => line.trim()) : [],
      }));
    } else {
      try {
        stop = classify(result as T);
      } catch {
        stop = 'completed';
      }
    }
    let transcriptBytes = 0;
    const transcriptWritten = await attempt('transcript', open.runId, async () => {
      const serialized = open.transcript.serialize(stop);
      if (serialized.bytes === 0) throw new Error('run log transcript could not be serialized');
      await sink.putObject(`${open.objectPrefix}transcript.jsonl`, serialized.jsonl, 'application/x-ndjson', OBJECT_DEADLINE_MS);
      transcriptBytes = serialized.bytes;
    });
    await attempt('finished_row', open.runId, async () => {
      const usage = open.transcript.usage();
      const costUsd = Object.entries(usage).reduce((total, [model, value]) => total + calculateCost(value, pricingFor(model)), 0);
      const row = scrubValue({
        runId: open.runId,
        stop,
        errorClass: failure ? errorClassOf(failure.value) : null,
        errorDetail: failure ? safeErrorMessage(failure.value) : null,
        modelRequests: Math.max(open.requests(), open.transcript.responseCount()),
        turns: open.transcript.responseCount(),
        usage,
        costUsd,
        transcriptWritten,
        transcriptBytes,
        finishedAt: deps.now(),
      }) as FinishedRow;
      // Cut after the scrub: scrubbing a half-cut redaction again would grow it past the column's 500 limit.
      await sink.insertFinished({ ...row, errorDetail: row.errorDetail?.slice(0, 500) ?? null }, ROW_DEADLINE_MS);
    });
  } catch {
    countRunLogFailure('transcript');
  }

  if (failure) throw failure.value;
  return result as T;
}
