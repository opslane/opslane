import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../db.js';
import { loadEvidence } from '../evidence/bundle.js';
import { replaceSessionFacts } from '../facts/persist.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('evidence bundle', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const orgIds: string[] = [];

  async function seedProject(): Promise<{ projectId: string; environmentId: string }> {
    const orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`evidence-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    orgIds.push(orgId);
    const projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo) VALUES ($1, 'evidence', '') RETURNING id`,
      [orgId],
    )).rows[0]!.id;
    const environmentId = (await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
      [projectId],
    )).rows[0]!.id;
    return { projectId, environmentId };
  }

  async function seedIssue(projectId: string): Promise<{ issueId: string; episodeId: string }> {
    const issueId = (await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id, fingerprint, title, first_seen, last_seen, status, page_url_normalized)
       VALUES ($1,$2,'Asset deletion failed',now(),now(),'candidate','/assets/:id/edit')
       RETURNING id`,
      [projectId, `fingerprint-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    const episodeId = (await pool.query<{ id: string }>(
      `INSERT INTO issue_episodes (project_id, canonical_issue_id, sequence)
       VALUES ($1,$2,1) RETURNING id`,
      [projectId, issueId],
    )).rows[0]!.id;
    return { issueId, episodeId };
  }

  async function seedEvent(args: {
    projectId: string;
    environmentId: string;
    issueId: string;
    episodeId: string;
    sessionId: string | null;
    endUserId?: string | null;
    anchorKind?: 'threshold' | 'first' | 'recent';
  }): Promise<string> {
    const eventId = (await pool.query<{ id: string }>(
      `INSERT INTO error_events
         (project_id, environment_id, error_group_id, timestamp, error_type,
          error_message, stack_trace_raw, context, session_id, end_user_id, commit_sha)
       VALUES ($1,$2,$3,now(),'TypeError','delete failed','at deleteAsset (app.js:1:2)',
               '{"url":"https://app.example.com/assets/42/edit"}'::jsonb,$4,$5,$6)
       RETURNING id`,
      [args.projectId, args.environmentId, args.issueId, args.sessionId,
        args.endUserId ?? null, 'a'.repeat(40)],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO error_event_identities
         (project_id,event_id,status,canonical_issue_id,raw_fingerprint,
          identity_version,episode_id,settled_at)
       VALUES ($1,$2,'settled',$3,'raw',2,$4,now())`,
      [args.projectId, eventId, args.issueId, args.episodeId],
    );
    if (args.anchorKind) {
      await pool.query(
        `INSERT INTO issue_evidence_anchors (project_id,episode_id,anchor_kind,event_id)
         VALUES ($1,$2,$3,$4)`,
        [args.projectId, args.episodeId, args.anchorKind, eventId],
      );
    }
    return eventId;
  }

  async function seedSession(projectId: string, environmentId: string): Promise<string> {
    const sessionId = `evidence-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO sessions
         (id,project_id,environment_id,started_at,last_chunk_at,chunk_count,status)
       VALUES ($1,$2,$3,now(),now(),1,'analyzed')`,
      [sessionId, projectId, environmentId],
    );
    await pool.query(
      `INSERT INTO session_analysis
         (session_id,project_id,environment_id,session_started_at,coverage,
          activity_class,rule_version)
       VALUES ($1,$2,$3,now(),'complete','active',4)`,
      [sessionId, projectId, environmentId],
    );
    return sessionId;
  }

  afterAll(async () => {
    for (const orgId of orgIds) {
      const projects = await pool.query<{ id: string }>(`SELECT id FROM projects WHERE org_id=$1`, [orgId]);
      for (const { id } of projects.rows) {
        await pool.query(`DELETE FROM sessions WHERE project_id=$1`, [id]);
        await pool.query(`DELETE FROM error_events WHERE project_id=$1`, [id]);
        await pool.query(`DELETE FROM error_groups WHERE project_id=$1`, [id]);
        await pool.query(`DELETE FROM environments WHERE project_id=$1`, [id]);
        await pool.query(`DELETE FROM projects WHERE id=$1`, [id]);
      }
      await pool.query(`DELETE FROM orgs WHERE id=$1`, [orgId]);
    }
    await pool.end();
    await closePool();
  });

  it('reads frozen anchors and never follows sample_event_id', async () => {
    const { projectId, environmentId } = await seedProject();
    const { issueId, episodeId } = await seedIssue(projectId);
    const anchorSessionId = await seedSession(projectId, environmentId);
    const anchorEventId = await seedEvent({
      projectId, environmentId, issueId, episodeId, sessionId: anchorSessionId,
      anchorKind: 'threshold',
    });
    await pool.query(
      `INSERT INTO error_event_resolutions
         (project_id,event_id,status,envelope,resolver_version)
       VALUES ($1,$2,'resolved',$3::jsonb,2)`,
      [projectId, anchorEventId, JSON.stringify({
        version: 2,
        frames: [{
          original_file: 'src/assets/delete.ts', original_function: 'deleteAsset',
          original_line: 42, generated: { line: 1, column: 2 },
        }],
      })],
    );
    await replaceSessionFacts(projectId, anchorSessionId, {
      entryPath: '/assets/:id/edit', clickCount: 1, inputEventCount: 0, pageEventCount: 1,
      failedRequest4xxCount: 1, failedRequest5xxCount: 0,
      unattributedFailedRequestCount: 0, successfulWriteCount: 0, failedWriteCount: 1,
      firstEventMs: null, lastEventMs: null, ruleVersion: 4,
      failures: [{
        requestIdHash: 'anchor-request', pageRoute: '/assets/:id/edit', method: 'DELETE',
        endpointPattern: '/api/assets/:id', status: 400, actionKind: 'click',
        actionSelector: '[data-testid="delete"]', actionLink: 'direct',
        occurredAt: '2026-08-18T00:00:00.000Z',
      }],
      successes: [{
        pageRoute: '/assets/:id/edit', method: 'POST', endpointPattern: '/api/audit',
        statusClass: 2, count: 3,
      }],
    });
    await pool.query(
      `INSERT INTO route_map
         (project_id,pattern,name,purpose,tier,source,actions,client_refs,
          server_refs,audience,confidence,commit_sha,prompt_version,model)
       VALUES ($1,'/assets/:id/edit','Asset editor','Edits an asset','standard','model',
               ARRAY['delete asset'],ARRAY['src/assets/edit.ts'],ARRAY['api/assets.ts'],
               'standard',0.9,$2,1,'test-model')`,
      [projectId, 'a'.repeat(40)],
    );
    const relatedIssueId = (await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id,fingerprint,title,first_seen,last_seen,status,page_url_normalized)
       VALUES ($1,$2,'Related asset failure',now(),now(),'candidate','/assets/:id/edit')
       RETURNING id`,
      [projectId, `related-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    const movingSessionId = await seedSession(projectId, environmentId);
    const movingEventId = await seedEvent({
      projectId, environmentId, issueId, episodeId, sessionId: movingSessionId,
    });
    await pool.query(`UPDATE error_groups SET sample_event_id=$1 WHERE id=$2`, [movingEventId, issueId]);

    const bundle = await loadEvidence(projectId, episodeId);

    expect(bundle.frames.sourceEventId).toBe(anchorEventId);
    expect(bundle.frames.envelope?.frames[0]?.original_file).toBe('src/assets/delete.ts');
    expect(bundle.failedRequests).toHaveLength(1);
    expect(bundle.failedRequests[0]?.sessionId).toBe(anchorSessionId);
    expect(bundle.writeRollups[0]).toMatchObject({
      sessionId: anchorSessionId, endpointPattern: '/api/audit', occurrenceCount: 3,
    });
    expect(bundle.productContext[0]).toMatchObject({
      route: '/assets/:id/edit', purpose: 'Edits an asset', clientRefs: ['src/assets/edit.ts'],
    });
    expect(bundle.affectedUnits).toBe(2);
    expect(bundle.relatedCandidates.map((candidate) => candidate.issueId)).toContain(relatedIssueId);
    expect(bundle.replayPointers.map((pointer) => pointer.eventId)).toEqual([anchorEventId]);
    expect(JSON.stringify(bundle)).not.toContain(movingEventId);
  });

  it('degrades to stated availability when the recording expired', async () => {
    const { projectId, environmentId } = await seedProject();
    const { issueId, episodeId } = await seedIssue(projectId);
    const eventId = await seedEvent({
      projectId, environmentId, issueId, episodeId,
      sessionId: `expired-${crypto.randomUUID()}`, anchorKind: 'threshold',
    });
    await pool.query(
      `INSERT INTO error_event_resolutions
         (project_id,event_id,status,envelope,resolver_version)
       VALUES ($1,$2,'no_map',NULL,2)`,
      [projectId, eventId],
    );

    const bundle = await loadEvidence(projectId, episodeId);

    expect(bundle.availability.recording).toBe('expired');
    expect(bundle.availability.sourceMap).toBe('no_map');
    expect(bundle.failedRequests).toEqual([]);
    expect(bundle.replayPointers).toEqual([]);
  });

  it('does not revive facts from an older analyzer rule', async () => {
    const { projectId, environmentId } = await seedProject();
    const { issueId, episodeId } = await seedIssue(projectId);
    const sessionId = await seedSession(projectId, environmentId);
    await seedEvent({
      projectId, environmentId, issueId, episodeId, sessionId, anchorKind: 'threshold',
    });
    await replaceSessionFacts(projectId, sessionId, {
      entryPath: '/assets', clickCount: 0, inputEventCount: 0, pageEventCount: 1,
      failedRequest4xxCount: 1, failedRequest5xxCount: 0,
      unattributedFailedRequestCount: 0, successfulWriteCount: 0, failedWriteCount: 1,
      firstEventMs: null, lastEventMs: null, ruleVersion: 3,
      failures: [{
        requestIdHash: 'old-rule', pageRoute: '/assets', method: 'POST',
        endpointPattern: '/api/assets', status: 400, actionKind: null,
        actionSelector: null, actionLink: 'none', occurredAt: '2026-08-18T00:00:00.000Z',
      }],
      successes: [],
    });

    const bundle = await loadEvidence(projectId, episodeId);

    expect(bundle.failedRequests).toEqual([]);
  });

  it('states when an anchored observation never had a recording', async () => {
    const { projectId, environmentId } = await seedProject();
    const { issueId, episodeId } = await seedIssue(projectId);
    await seedEvent({
      projectId, environmentId, issueId, episodeId,
      sessionId: null, anchorKind: 'threshold',
    });

    const bundle = await loadEvidence(projectId, episodeId);

    expect(bundle.availability.recording).toBe('missing');
    expect(bundle.availability.sourceMap).toBe('missing');
    expect(bundle.replayPointers).toEqual([]);
  });
});
