import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../../db.js';
import { backfillTickets } from '../backfill-tickets.js';
import { parseResetArgs, resetFrictionTickets } from '../reset-friction-tickets.js';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;
const projectId = randomUUID();
const environmentId = randomUUID();
const otherEnvironment = randomUUID();
const replayEnvironment = randomUUID();
const orgId = randomUUID();
const since = new Date(Date.now() - 86_400_000);

describe('reset arguments', () => {
  it('requires a scope, a lookback and explicit confirmation', () => {
    const now = new Date('2026-09-15T00:00:00Z');
    expect(parseResetArgs(['--project', projectId, '--environment', environmentId, '--since', '14d', '--confirm'], now))
      .toEqual({ projectId, environmentId, since: new Date('2026-09-01T00:00:00Z') });
    expect(() => parseResetArgs(['--project', projectId, '--environment', environmentId, '--since', '14d'])).toThrow(/--confirm/);
    expect(() => parseResetArgs(['--project', projectId, '--environment', environmentId, '--confirm'])).toThrow(/Usage/);
    expect(() => parseResetArgs(['--project', 'bad', '--environment', environmentId, '--since', '14d', '--confirm'])).toThrow(/Usage/);
    expect(() => parseResetArgs(['--project', projectId, '--since', '14d', '--confirm'])).toThrow(/Usage/);
  });
});

describeDb('known problems reset', () => {
  const pool = db.getPool();
  beforeAll(async () => {
    await pool.query('INSERT INTO orgs(id,name) VALUES($1,$2)', [orgId, `reset-${orgId}`]);
    await pool.query("INSERT INTO projects(id,org_id,name) VALUES($1,$2,'reset')", [projectId, orgId]);
    await pool.query("INSERT INTO environments(id,project_id,name) VALUES($1,$4,'production'),($2,$4,'staging'),($3,$4,'replay')", [environmentId, otherEnvironment, replayEnvironment, projectId]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM friction_fix_attempts WHERE ticket_id IN (SELECT id FROM friction_tickets WHERE project_id=$1)', [projectId]);
    await pool.query('DELETE FROM error_group_jobs WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM friction_observation_decisions WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM friction_session_processed WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM session_narratives WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM digest_card_copy WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id=$1)', [projectId]);
    await pool.query('UPDATE error_groups SET ticket_id=NULL WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM friction_tickets WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM friction_signals WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM error_groups WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM sessions WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM environments WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
    await pool.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await db.closePool();
  });

  async function seedTicket(environment: string, status = 'published') {
    const ticket = (await pool.query<{ id: string }>(
      `INSERT INTO friction_tickets(project_id,environment_id,name,control,what_happened,kind,status,live_generation)
       VALUES($1,$2,'Save stalls','Save','Nothing happened','defect',$3,1) RETURNING id`, [projectId, environment, status])).rows[0]!.id;
    const group = (await pool.query<{ id: string }>(
      `INSERT INTO error_groups(project_id,fingerprint,title,first_seen,last_seen,kind,status,ticket_id,publication_generation,fix_substate,investigation_status)
       VALUES($1,$2,'Save stalls',now(),now(),'friction','awaiting_approval',$3,1,'none','done') RETURNING id`, [projectId, `ticket|${ticket}|1`, ticket])).rows[0]!.id;
    await pool.query(`INSERT INTO error_group_jobs(project_id,error_group_id,ticket_id,job_type,status,publication_generation)
      VALUES($1,$2,$3,'investigate','pending',1),($1,$2,$3,'investigate','completed',1)`, [projectId, group, ticket]);
    await pool.query(`INSERT INTO digest_card_copy(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
      VALUES($1,now(),'test','test','test','test','test',1)`, [group]);
    return { ticket, group };
  }
  async function seedDecided(environment: string, createdAt = new Date().toISOString()) {
    const sessionId = randomUUID();
    await pool.query('INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES($1,$2,$3,now())', [sessionId, projectId, environment]);
    const signal = (await pool.query<{ id: string }>(
      `INSERT INTO friction_signals(session_id,project_id,environment_id,signal_type,fingerprint,page_url_normalized,occurred_at,rule_version,observation_id,narrative_id)
       VALUES($1,$2,$3,'other',$4,'/save',now(),1,'o1','n1') RETURNING id`, [sessionId, projectId, environment, randomUUID()])).rows[0]!.id;
    await pool.query(`INSERT INTO friction_observation_decisions(signal_id,project_id,environment_id,session_id,decision,decided_by)
      VALUES($1,$2,$3,$4,'not_a_problem','strong')`, [signal, projectId, environment, sessionId]);
    await pool.query(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,prompt_version,created_at,narrative,timeline,verification_state)
      VALUES($1,$2,$3,'ok',2,$4,$5,$6,'none')`, [sessionId, projectId, environment, createdAt,
      JSON.stringify({ userGoal: 'save', narrative: 'save', notable: false, observations: [] }), JSON.stringify({ startTs: 0, lines: [] })]);
    await pool.query('INSERT INTO friction_session_processed(project_id,session_id,narrative_id) VALUES($1,$2,$3)', [projectId, sessionId, 'n-empty']);
    await pool.query(`INSERT INTO error_group_jobs(project_id,session_id,job_type,status) VALUES($1,$2,'friction_match','pending')`, [projectId, sessionId]);
    return { sessionId, signal };
  }

  it('refuses while a fix is in flight and changes nothing', async () => {
    const live = await seedTicket(environmentId);
    const attempt = (await pool.query<{ id: string }>(
      `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status) VALUES($1,$2,1,'pr_open') RETURNING id`, [live.ticket, live.group])).rows[0]!.id;
    await expect(resetFrictionTickets(pool, { projectId, environmentId, since })).rejects.toThrow(/open PR/);
    expect((await pool.query('SELECT status FROM friction_tickets WHERE id=$1', [live.ticket])).rows[0]).toEqual({ status: 'published' });
    await pool.query("UPDATE friction_fix_attempts SET status='closed' WHERE id=$1", [attempt]);
  });

  it('archives the environment list, clears its decisions and leaves other environments alone', async () => {
    const production = await seedTicket(environmentId, 'tracking');
    const decided = await seedDecided(environmentId);
    const older = await seedDecided(environmentId, '2026-01-01T00:00:00Z');
    const staging = await seedTicket(otherEnvironment);
    const stagingDecided = await seedDecided(otherEnvironment);
    await pool.query('UPDATE friction_signals SET incident_id=$1 WHERE id=$2', [production.group, decided.signal]);
    await pool.query('UPDATE friction_signals SET incident_id=$1 WHERE id=$2', [staging.group, stagingDecided.signal]);

    const result = await resetFrictionTickets(pool, { projectId, environmentId, since });
    expect(result.decisions).toBe(1);
    expect(result.processed).toBe(1);

    const tickets = (await pool.query<{ id: string; status: string }>('SELECT id,status FROM friction_tickets WHERE project_id=$1', [projectId])).rows;
    expect(tickets.find((t) => t.id === production.ticket)!.status).toBe('archived');
    expect(tickets.find((t) => t.id === staging.ticket)!.status).toBe('published');
    expect(tickets.filter((t) => t.status !== 'archived').map((t) => t.id)).toEqual([staging.ticket]);

    const groups = (await pool.query<{ id: string; status: string; status_before_archive: string | null }>(
      'SELECT id,status,status_before_archive FROM error_groups WHERE id=ANY($1::uuid[])', [[production.group, staging.group]])).rows;
    expect(groups.find((g) => g.id === production.group)).toMatchObject({ status: 'archived', status_before_archive: 'awaiting_approval' });
    expect(groups.find((g) => g.id === staging.group)).toMatchObject({ status: 'awaiting_approval' });

    const jobs = (await pool.query<{ error_group_id: string | null; session_id: string | null; status: string }>(
      `SELECT error_group_id,session_id,status FROM error_group_jobs WHERE project_id=$1 AND status IN ('pending','claimed')`, [projectId])).rows;
    // The out-of-window recording's matching is not rescheduled by the backfill, so it keeps running.
    expect(jobs.map((j) => j.error_group_id ?? j.session_id).sort()).toEqual([staging.group, stagingDecided.sessionId, older.sessionId].sort());

    expect((await pool.query('SELECT invalidated_at IS NOT NULL AS invalid FROM digest_card_copy WHERE error_group_id=$1', [production.group])).rows[0]).toEqual({ invalid: true });
    expect((await pool.query('SELECT invalidated_at IS NOT NULL AS invalid FROM digest_card_copy WHERE error_group_id=$1', [staging.group])).rows[0]).toEqual({ invalid: false });
    expect((await pool.query('SELECT 1 FROM friction_observation_decisions WHERE signal_id=$1', [decided.signal])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM friction_observation_decisions WHERE signal_id=$1', [stagingDecided.signal])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM friction_session_processed WHERE session_id=$1', [decided.sessionId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM friction_session_processed WHERE session_id=$1', [stagingDecided.sessionId])).rowCount).toBe(1);
    // Outside the lookback the ledger stays: the backfill will not schedule it again.
    expect((await pool.query('SELECT 1 FROM friction_observation_decisions WHERE signal_id=$1', [older.signal])).rowCount).toBe(1);
    expect((await pool.query('SELECT incident_id FROM friction_signals WHERE id=$1', [decided.signal])).rows[0]).toEqual({ incident_id: null });
    expect((await pool.query('SELECT incident_id FROM friction_signals WHERE id=$1', [stagingDecided.signal])).rows[0]).toEqual({ incident_id: staging.group });

    // A second run is a no-op.
    expect(await resetFrictionTickets(pool, { projectId, environmentId, since })).toEqual({ tickets: 0, incidents: 0, jobs: 0, decisions: 0, processed: 0 });
  });

  it('lets a backfill decide a reset recording again', async () => {
    const sessionId = randomUUID();
    await pool.query('INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES($1,$2,$3,now())', [sessionId, projectId, replayEnvironment]);
    const createdAt = new Date().toISOString();
    await pool.query(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,prompt_version,created_at,narrative,timeline,verification_state)
      VALUES($1,$2,$3,'ok',2,$4,$5,$6,'none')`, [sessionId, projectId, replayEnvironment, createdAt,
      JSON.stringify({ userGoal: 'save', narrative: 'save', notable: false, observations: [] }), JSON.stringify({ startTs: 0, lines: [] })]);
    const narrativeId = (await import('../../narrative/emit.js')).deriveNarrativeId(sessionId,
      (await pool.query<{ created_at: string }>('SELECT created_at::text FROM session_narratives WHERE session_id=$1', [sessionId])).rows[0]!.created_at, 2);
    await pool.query('INSERT INTO friction_session_processed(project_id,session_id,narrative_id) VALUES($1,$2,$3)', [projectId, sessionId, narrativeId]);
    const options = { projectId, environmentId: replayEnvironment, since, rate: 60, allowMissingEmbeddings: true };
    expect(await backfillTickets(pool, options)).toBe(0);
    await resetFrictionTickets(pool, { projectId, environmentId: replayEnvironment, since });
    expect(await backfillTickets(pool, options)).toBe(1);
  });
});
