import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../usage-events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../usage-events.js')>();
  return { ...actual, emitUsageEvent: vi.fn() };
});

import {
  closePool,
  finalizeDelivery,
  saveExternalCIResult,
  updateGroupInvestigation,
  updateGroupStatus,
} from '../db.js';
import type { JobLease } from '../db.js';
import { emitUsageEvent } from '../usage-events.js';

const databaseURL = process.env['DATABASE_URL'];
const describeDb = databaseURL ? describe : describe.skip;

describeDb('issue.triaged emission', () => {
  let pool: pg.Pool;
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseURL });
    orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`triaged-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name) VALUES ($1, 'triaged-project') RETURNING id`,
      [orgId],
    )).rows[0]!.id;
  });

  beforeEach(async () => {
    vi.mocked(emitUsageEvent).mockClear();
    await pool.query(
      `DELETE FROM outbound_deliveries
       WHERE event_id IN (SELECT id FROM outbound_events WHERE project_id = $1)`,
      [projectId],
    );
    await pool.query(`DELETE FROM outbound_events WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM notification_destinations WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM error_groups WHERE project_id = $1`, [projectId]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await pool.end();
    await closePool();
  });

  async function seedDestination(policy: 'immediate' | 'post_triage'): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO notification_destinations
         (id, project_id, type, name, config_encrypted, config_fingerprint,
          event_types, delivery_policy, enabled)
       VALUES ($1, $2, 'slack', $3, $4, 'fixture', '{issue.created}', $5, true)`,
      [id, projectId, policy, Buffer.from('sealed'), policy],
    );
    return id;
  }

  async function seedGroupAndJob(status = 'queued'): Promise<{ groupId: string; jobId: string }> {
    const groupId = (await pool.query<{ id: string }>(
      `INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, status)
       VALUES ($1, $2, 'TypeError: checkout failed', '2026-08-13T00:00:00Z', now(), $3::error_group_status)
       RETURNING id`,
      [projectId, crypto.randomUUID(), status],
    )).rows[0]!.id;
    const jobId = (await pool.query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, available_at)
       VALUES ($1, $2, 'fix', now() + interval '1 day') RETURNING id`,
      [groupId, projectId],
    )).rows[0]!.id;
    return { groupId, jobId };
  }

  async function claim(jobId: string, groupId: string): Promise<JobLease> {
    await pool.query(
      `UPDATE error_group_jobs
       SET status = 'claimed', worker_id = 'triaged-worker', lease_generation = 1,
           lease_expires_at = now() + interval '5 minutes'
       WHERE id = $1`,
      [jobId],
    );
    return {
      id: jobId,
      workerId: 'triaged-worker',
      leaseGeneration: '1',
      projectId,
      errorGroupId: groupId,
      sessionId: null,
    };
  }

  async function countEvents(groupId: string): Promise<number> {
    return Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbound_events
       WHERE project_id = $1 AND event_type = 'issue.triaged'
         AND payload->'issue'->>'id' = $2`,
      [projectId, groupId],
    )).rows[0]!.count);
  }

  const reason = {
    reason_code: 'insufficient_context' as const,
    reason_message: 'SENTINEL_MODEL_PROSE',
    remediation: 'Review manually',
  };

  it('emits once for a needs_human transition and not for its retry', async () => {
    await seedDestination('post_triage');
    const { groupId, jobId } = await seedGroupAndJob();
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason, terminalFixJobId: jobId });
    await updateGroupStatus(groupId, projectId, 'needs_human', { reason, terminalFixJobId: jobId });
    expect(await countEvents(groupId)).toBe(1);
    expect(emitUsageEvent).toHaveBeenCalledTimes(1);
    expect(emitUsageEvent).toHaveBeenCalledWith('needs_human_created', expect.objectContaining({
      error_group_id: groupId,
      project_id: projectId,
      reason: 'SENTINEL_MODEL_PROSE',
    }));

    const payload = (await pool.query<{ payload: unknown }>(
      `SELECT payload FROM outbound_events WHERE project_id = $1 AND event_type = 'issue.triaged'`,
      [projectId],
    )).rows[0]!.payload;
    expect(JSON.stringify(payload)).not.toContain('SENTINEL_MODEL_PROSE');
  });

  it('emits again after reopen under a new terminal job', async () => {
    await seedDestination('post_triage');
    const first = await seedGroupAndJob();
    await updateGroupStatus(first.groupId, projectId, 'needs_human', {
      reason, terminalFixJobId: first.jobId,
    });
    await pool.query(`UPDATE error_groups SET status = 'queued' WHERE id = $1`, [first.groupId]);
    const secondJob = (await pool.query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, available_at)
       VALUES ($1, $2, 'fix', now() + interval '1 day') RETURNING id`,
      [first.groupId, projectId],
    )).rows[0]!.id;
    await updateGroupStatus(first.groupId, projectId, 'needs_human', {
      reason, terminalFixJobId: secondJob,
    });
    expect(await countEvents(first.groupId)).toBe(2);
  });

  it('does not emit for immediate policy, insight, or a lost lease', async () => {
    await seedDestination('immediate');
    const immediate = await seedGroupAndJob();
    await updateGroupStatus(immediate.groupId, projectId, 'needs_human', {
      reason, terminalFixJobId: immediate.jobId,
    });
    expect(await countEvents(immediate.groupId)).toBe(0);

    await pool.query(`DELETE FROM notification_destinations WHERE project_id = $1`, [projectId]);
    await seedDestination('post_triage');
    const insight = await seedGroupAndJob();
    await updateGroupInvestigation(insight.groupId, projectId, 'insight', {
      rootCause: 'Third-party failure',
    });
    expect(await countEvents(insight.groupId)).toBe(0);

    const lost = await seedGroupAndJob();
    const staleLease: JobLease = {
      id: lost.jobId, workerId: 'stale', leaseGeneration: '9', projectId,
      errorGroupId: lost.groupId, sessionId: null,
    };
    await expect(updateGroupStatus(lost.groupId, projectId, 'needs_human', { reason }, staleLease))
      .rejects.toThrow(/lease lost/i);
    expect(await countEvents(lost.groupId)).toBe(0);
  });

  it('rejects a terminal transition without a stable job id', async () => {
    const { groupId } = await seedGroupAndJob();
    await expect(updateGroupStatus(groupId, projectId, 'needs_human', { reason }))
      .rejects.toThrow(/terminal job id/i);
  });

  it('emits from investigation, direct fix failure, PR finalization, and CI promotion', async () => {
    await seedDestination('post_triage');

    const investigation = await seedGroupAndJob();
    await updateGroupInvestigation(investigation.groupId, projectId, 'needs_human', {
      reason,
      terminalJobId: investigation.jobId,
    });
    expect(await countEvents(investigation.groupId)).toBe(1);
    expect(emitUsageEvent).toHaveBeenCalledWith('needs_human_created', expect.objectContaining({
      error_group_id: investigation.groupId,
    }));

    const finalized = await seedGroupAndJob('fixing');
    const finalizeLease = await claim(finalized.jobId, finalized.groupId);
    await finalizeDelivery(finalized.groupId, projectId, {
      status: 'pr_created', prUrl: 'https://github.com/acme/repo/pull/1', prNumber: 1,
      headSha: 'abc', confidence: 'high', fixJobId: finalized.jobId,
    }, finalizeLease);
    expect(await countEvents(finalized.groupId)).toBe(1);

    const promoted = await seedGroupAndJob('pr_draft');
    const promoteLease = await claim(promoted.jobId, promoted.groupId);
    expect(await saveExternalCIResult(promoted.groupId, projectId, {
      promote: true,
      evidence: { version: 1, tier: 'E0', checks: [] },
    }, promoteLease)).toBe(true);
    expect(await countEvents(promoted.groupId)).toBe(1);
  });

  it('keeps the advisory status-writer inventory visible', () => {
    const source = readFileSync(new URL('../db.ts', import.meta.url), 'utf8');
    expect(source).toContain('triaged_outbox');
    expect(source).toContain('previous_status');
  });
});
