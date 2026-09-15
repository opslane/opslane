import pg from 'pg';
import type { FinishedRow, StartedRow } from '@opslane/agent-runs';
import { getMinIOConfig, putObject } from '../minio-client.js';

export type RunLogFailureKind = 'setup' | 'bundle' | 'transcript' | 'started_row' | 'finished_row';

const failures: Record<RunLogFailureKind, number> = { setup: 0, bundle: 0, transcript: 0, started_row: 0, finished_row: 0 };

export function countRunLogFailure(kind: RunLogFailureKind): void {
  failures[kind]++;
}

/** Per-process diagnostics for /health; they reset on restart. */
export function runLogFailureCounts(): Record<RunLogFailureKind, number> {
  return { ...failures };
}

export interface RunLogSink {
  putObject(key: string, body: string, contentType: string, deadlineMs: number): Promise<void>;
  insertStarted(row: StartedRow, deadlineMs: number): Promise<void>;
  insertFinished(row: FinishedRow, deadlineMs: number): Promise<void>;
}

/** Reject after `ms`, abort the work, call onTimeout; a value that arrives later goes to onLate. */
export function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  options: { onLate?: (value: T) => void; onTimeout?: () => void } = {},
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      try { options.onTimeout?.(); } catch { /* best effort */ }
      reject(new Error(`run log write exceeded ${ms} ms`));
    }, ms);
    let pending: Promise<T>;
    try {
      pending = work(controller.signal);
    } catch (error: unknown) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) {
          try { options.onLate?.(value); } catch { /* best effort */ }
        } else {
          resolve(value);
        }
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(error);
      },
    );
  });
}

/**
 * One autocommit INSERT on a dedicated connection, under one deadline that
 * covers connect and the statement. On timeout the client is ended, which
 * destroys the socket, so a stalled server cannot hold the caller. An INSERT
 * the server already executing may still commit; the row is then simply late.
 */
async function insertWithDeadline(sql: string, params: unknown[], deadlineMs: number, connectionString?: string): Promise<void> {
  const client = new pg.Client({
    connectionString: connectionString ?? process.env['DATABASE_URL'],
    connectionTimeoutMillis: deadlineMs,
    statement_timeout: deadlineMs,
    query_timeout: deadlineMs,
  });
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    client.end().catch(() => undefined);
  };
  client.on('error', () => undefined);
  try {
    await withDeadline(deadlineMs, async () => {
      await client.connect();
      await client.query(sql, params);
    }, { onTimeout: end });
  } finally {
    end();
  }
}

export async function insertStartedRow(row: StartedRow, deadlineMs: number, connectionString?: string): Promise<void> {
  await insertWithDeadline(
    `INSERT INTO agent_run_started (run_id, job_id, job_type, project_id, phase, entry_point, attempts, lease_generation,
       error_group_id, ticket_id, episode_id, batch_id, session_id, commit_sha, object_prefix, models, worker_build_sha,
       bundle_written, bundle_bytes, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [row.runId, row.jobId, row.jobType, row.projectId, row.phase, row.entryPoint, row.attempts, row.leaseGeneration,
      row.errorGroupId, row.ticketId, row.episodeId, row.batchId, row.sessionId, row.commitSha, row.objectPrefix,
      row.models, row.workerBuildSha, row.bundleWritten, row.bundleBytes, row.recordedAt],
    deadlineMs,
    connectionString,
  );
}

export async function insertFinishedRow(row: FinishedRow, deadlineMs: number, connectionString?: string): Promise<void> {
  await insertWithDeadline(
    `INSERT INTO agent_run_finished (run_id, stop, error_class, error_detail, model_requests, turns, usage, cost_usd,
       transcript_written, transcript_bytes, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [row.runId, row.stop, row.errorClass, row.errorDetail, row.modelRequests, row.turns, JSON.stringify(row.usage),
      row.costUsd.toFixed(6), row.transcriptWritten, row.transcriptBytes, row.finishedAt],
    deadlineMs,
    connectionString,
  );
}

/** Null when object storage is not configured: run logs are then off. */
export function storageSink(): RunLogSink | null {
  const config = getMinIOConfig();
  if (!config) return null;
  return {
    putObject: (key, body, contentType, deadlineMs) =>
      withDeadline(deadlineMs, (signal) => putObject(key, body, contentType, config, signal)),
    insertStarted: (row, deadlineMs) => insertStartedRow(row, deadlineMs),
    insertFinished: (row, deadlineMs) => insertFinishedRow(row, deadlineMs),
  };
}
