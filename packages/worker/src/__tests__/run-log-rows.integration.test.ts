import crypto from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db.js';
import { insertFinishedRow, insertStartedRow } from '../run-logs/sink.js';

describe.skipIf(!process.env['DATABASE_URL'])('run log row writers', () => {
  const runIds: string[] = [];
  afterAll(async () => {
    await getPool().query('DELETE FROM agent_run_started WHERE run_id = ANY($1::uuid[])', [runIds]);
    await closePool();
  });

  it('inserts started and finished rows readable through the view', async () => {
    const runId = crypto.randomUUID();
    runIds.push(runId);
    const projectId = crypto.randomUUID();
    await insertStartedRow({
      runId, jobId: crypto.randomUUID(), jobType: 'friction_confirm', projectId, phase: 'friction_confirm:b',
      entryPoint: 'friction/confirm#confirmRead', attempts: 0, leaseGeneration: '3', errorGroupId: null, ticketId: null,
      episodeId: null, batchId: null, sessionId: 'sess_x', commitSha: null, objectPrefix: `agent-runs/${projectId}/2026-09-15/${runId}/`,
      models: ['claude-sonnet-5'], workerBuildSha: 'sha', bundleWritten: true, bundleBytes: 10, recordedAt: new Date(),
    }, 3_000);
    await insertFinishedRow({
      runId, stop: 'invalid_output', errorClass: null, errorDetail: null, modelRequests: 2, turns: 2,
      usage: { 'claude-sonnet-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, costUsd: 0.000012,
      transcriptWritten: true, transcriptBytes: 50, finishedAt: new Date(),
    }, 3_000);
    const { rows } = await getPool().query(`SELECT stop, phase, session_id FROM agent_runs_v WHERE run_id = $1`, [runId]);
    expect(rows[0]).toEqual({ stop: 'invalid_output', phase: 'friction_confirm:b', session_id: 'sess_x' });
  });

  it('bounds a stalled INSERT after connecting', async () => {
    const blocker = await getPool().connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE agent_run_finished IN ACCESS EXCLUSIVE MODE');
      const startedAt = Date.now();
      await expect(insertFinishedRow({
        runId: crypto.randomUUID(), stop: 'completed', errorClass: null, errorDetail: null,
        modelRequests: 0, turns: 0, usage: {}, costUsd: 0,
        transcriptWritten: false, transcriptBytes: 0, finishedAt: new Date(),
      }, 100)).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('gives up on an unreachable database within the deadline', async () => {
    const startedAt = Date.now();
    await expect(insertFinishedRow({
      runId: crypto.randomUUID(), stop: 'completed', errorClass: null, errorDetail: null, modelRequests: 0, turns: 0,
      usage: {}, costUsd: 0, transcriptWritten: false, transcriptBytes: 0, finishedAt: new Date(),
    }, 300, 'postgres://opslane:x@10.255.255.1:5432/opslane')).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});
