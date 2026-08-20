import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, persistInquiryDecision, type ClaimedJob } from '../db.js';
import type { EvidenceBundle } from '../evidence/bundle.js';
import { runInquiry } from '../inquiry/job.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('inquiry job write path integration', () => {
  let pool: pg.Pool;
  let orgId: string;
  let projectId: string;
  let issueId: string;
  let episodeId: string;
  let job: ClaimedJob;

  const evidence: EvidenceBundle = {
    frames: {
      sourceEventId: '80000000-0000-4000-8000-000000000001',
      status: 'resolved', resolverVersion: 2,
      envelope: { version: 2, frames: [] }, commitSha: 'abc123',
    },
    failedRequests: [], writeRollups: [], productContext: [], replayPointers: [],
    availability: { recording: 'missing', sourceMap: 'resolved' },
    affectedUnits: 3,
    relatedCandidates: [],
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`worker-inquiry-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id,name,github_repo) VALUES ($1,'inquiry','example/repo') RETURNING id`,
      [orgId],
    )).rows[0]!.id;
    issueId = (await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id,fingerprint,title,first_seen,last_seen,status)
       VALUES ($1,$2,'Inquiry issue',now(),now(),'candidate') RETURNING id`,
      [projectId, `inquiry-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    episodeId = (await pool.query<{ id: string }>(
      `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
       VALUES ($1,$2,1) RETURNING id`,
      [projectId, issueId],
    )).rows[0]!.id;
    const row = (await pool.query<{ id: string; lease_generation: string }>(
      `INSERT INTO error_group_jobs
         (error_group_id,project_id,episode_id,job_type,status,worker_id,
          claimed_at,lease_expires_at,lease_generation,input_version)
       VALUES ($1,$2,$3,'issue_inquiry','claimed','inquiry-test-worker',
               now()-interval '10 years',now()+interval '5 minutes',1,1)
       RETURNING id,lease_generation::text AS lease_generation`,
      [issueId, projectId, episodeId],
    )).rows[0]!;
    job = {
      id: row.id, workerId: 'inquiry-test-worker', leaseGeneration: row.lease_generation,
      errorGroupId: issueId, eventId: null, episodeId, sourceId: null, projectId,
      jobType: 'issue_inquiry', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: null,
    };
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM error_group_jobs WHERE project_id=$1`, [projectId]).catch(() => undefined);
    await pool.query(`DELETE FROM error_groups WHERE project_id=$1`, [projectId]).catch(() => undefined);
    await pool.query(`DELETE FROM projects WHERE id=$1`, [projectId]).catch(() => undefined);
    await pool.query(`DELETE FROM orgs WHERE id=$1`, [orgId]).catch(() => undefined);
    await pool.end();
    await closePool();
  });

  async function seedEpisodeWithClaimedJob(tag: string): Promise<{
    issueId: string; episodeId: string; jobId: string; leaseGeneration: string;
  }> {
    const newIssueId = (await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id,fingerprint,title,first_seen,last_seen,status)
       VALUES ($1,$2,$3,now(),now(),'candidate') RETURNING id`,
      [projectId, `inquiry-${tag}-${crypto.randomUUID()}`, `Inquiry ${tag} issue`],
    )).rows[0]!.id;
    const newEpisodeId = (await pool.query<{ id: string }>(
      `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
       VALUES ($1,$2,1) RETURNING id`,
      [projectId, newIssueId],
    )).rows[0]!.id;
    const row = (await pool.query<{ id: string; lease_generation: string }>(
      `INSERT INTO error_group_jobs
         (error_group_id,project_id,episode_id,job_type,status,worker_id,
          claimed_at,lease_expires_at,lease_generation,input_version)
       VALUES ($1,$2,$3,'issue_inquiry','claimed','inquiry-test-worker',
               now()-interval '10 years',now()+interval '5 minutes',1,1)
       RETURNING id,lease_generation::text AS lease_generation`,
      [newIssueId, projectId, newEpisodeId],
    )).rows[0]!;
    return { issueId: newIssueId, episodeId: newEpisodeId, jobId: row.id, leaseGeneration: row.lease_generation };
  }

  it('stores one decision and one investigation job across retries', async () => {
    const dependencies = {
      loadEvidence: async () => evidence,
      prepareRepository: async () => ({ repoPath: '/tmp/repo', cleanup: async () => undefined }),
      askModel: async () => ({
        raw: { decision: 'investigate', reason: 'real failed write', brief: 'check delete path' },
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.001,
      }),
      persist: persistInquiryDecision,
      recordUsage: async () => undefined,
    };
    await runInquiry(job, new AbortController().signal, dependencies);
    await runInquiry(job, new AbortController().signal, dependencies);

    const decisions = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM issue_inquiry_decisions
        WHERE project_id=$1 AND episode_id=$2`, [projectId, episodeId],
    );
    const investigations = await pool.query<{ count: number; input_version: number | null; error_group_id: string }>(
      `SELECT count(*)::int AS count, min(input_version)::int AS input_version,
              min(error_group_id::text) AS error_group_id
         FROM error_group_jobs
        WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'`, [projectId, episodeId],
    );
    expect(decisions.rows[0]!.count).toBe(1);
    expect(investigations.rows[0]!.count).toBe(1);
    expect(investigations.rows[0]!.input_version).toBe(1);
    expect(investigations.rows[0]!.error_group_id).toBe(issueId);
  });

  it('a conflicting later attempt defers to the stored decision and creates no job', async () => {
    // Same signature + prompt version as an existing wait decision, but this
    // attempt says investigate: the decision insert is suppressed, the stored
    // wait row is the effective decision, and no investigate job may appear.
    const waitEpisode = await seedEpisodeWithClaimedJob('conflict');
    const base = {
      projectId, episodeId: waitEpisode.episodeId, jobId: waitEpisode.jobId,
      workerId: 'inquiry-test-worker', leaseGeneration: waitEpisode.leaseGeneration,
      reason: 'r', brief: null, relatedIssues: [] as string[], affectedUnits: 3,
      evidenceSignature: 'sig-conflict-1', productUnderstandingVersion: null,
      model: 'test-model', promptVersion: 1,
    };
    expect(await persistInquiryDecision({ ...base, decision: 'wait_for_more_evidence' })).toBe(true);
    expect(await persistInquiryDecision({ ...base, decision: 'investigate' })).toBe(true);

    const stored = await pool.query<{ decision: string; count: number }>(
      `SELECT min(decision) AS decision, count(*)::int AS count FROM issue_inquiry_decisions
        WHERE project_id=$1 AND episode_id=$2`, [projectId, waitEpisode.episodeId],
    );
    const investigations = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM error_group_jobs
        WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'`, [projectId, waitEpisode.episodeId],
    );
    expect(stored.rows[0]!.count).toBe(1);
    expect(stored.rows[0]!.decision).toBe('wait_for_more_evidence');
    expect(investigations.rows[0]!.count).toBe(0);
  });

  it('creates no investigation job for a non-investigate decision and stores it', async () => {
    const waitEpisode = await seedEpisodeWithClaimedJob('refusal');
    const waitJob: ClaimedJob = {
      id: waitEpisode.jobId, workerId: 'inquiry-test-worker', leaseGeneration: waitEpisode.leaseGeneration,
      errorGroupId: waitEpisode.issueId, eventId: null, episodeId: waitEpisode.episodeId, sourceId: null,
      projectId, jobType: 'issue_inquiry', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: null,
    };
    await runInquiry(waitJob, new AbortController().signal, {
      loadEvidence: async () => evidence,
      prepareRepository: async () => ({ repoPath: '/tmp/repo', cleanup: async () => undefined }),
      askModel: async () => ({
        raw: { decision: 'wait_for_more_evidence', reason: 'single unit, no replay' },
        usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.001,
      }),
      persist: persistInquiryDecision,
      recordUsage: async () => undefined,
    });

    const stored = await pool.query<{ decision: string }>(
      `SELECT decision FROM issue_inquiry_decisions
        WHERE project_id=$1 AND episode_id=$2`, [projectId, waitEpisode.episodeId],
    );
    const investigations = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM error_group_jobs
        WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'`, [projectId, waitEpisode.episodeId],
    );
    expect(stored.rows[0]?.decision).toBe('wait_for_more_evidence');
    expect(investigations.rows[0]!.count).toBe(0);
  });

  it('a stale lease generation writes nothing at all', async () => {
    const staleEpisode = await seedEpisodeWithClaimedJob('stale');
    const wrote = await persistInquiryDecision({
      projectId, episodeId: staleEpisode.episodeId, jobId: staleEpisode.jobId,
      workerId: 'inquiry-test-worker', leaseGeneration: '999999',
      decision: 'investigate', reason: 'r', brief: 'b', relatedIssues: [], affectedUnits: 3,
      evidenceSignature: 'sig-stale-1', productUnderstandingVersion: null,
      model: 'test-model', promptVersion: 1,
    });
    expect(wrote).toBe(false);
    const decisions = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM issue_inquiry_decisions
        WHERE project_id=$1 AND episode_id=$2`, [projectId, staleEpisode.episodeId],
    );
    const investigations = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM error_group_jobs
        WHERE project_id=$1 AND episode_id=$2 AND job_type='investigate'`, [projectId, staleEpisode.episodeId],
    );
    expect(decisions.rows[0]!.count).toBe(0);
    expect(investigations.rows[0]!.count).toBe(0);
  });
});
