import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { closePool, getPool } from '../db.js';
import { lockPublication } from '../friction/tickets-db.js';

export interface ResetOptions {
  projectId: string;
  environmentId: string;
  /** Same boundary the following backfill uses: decisions are deleted only for
   * narratives the backfill will schedule again. */
  since: Date;
}

export interface ResetResult {
  tickets: number;
  incidents: number;
  jobs: number;
  decisions: number;
  processed: number;
}

export function parseResetArgs(args: string[], now = new Date()): ResetOptions {
  const { values } = parseArgs({ args, options: {
    project: { type: 'string' }, environment: { type: 'string' }, since: { type: 'string' }, confirm: { type: 'boolean' },
  } });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const days = /^(\d+)d$/.exec(values.since ?? '');
  if (!values.project || !uuid.test(values.project) || !values.environment || !uuid.test(values.environment) || !days || Number(days[1]) <= 0) {
    throw new Error('Usage: reset-friction-tickets --project UUID --environment UUID --since 14d --confirm');
  }
  if (values.confirm !== true) {
    throw new Error('Refusing to reset without --confirm: this archives every known problem in the environment and deletes its matching decisions');
  }
  return { projectId: values.project, environmentId: values.environment, since: new Date(now.getTime() - Number(days[1]) * 86_400_000) };
}

/**
 * Starts an environment's known-problem list over. Every live ticket is
 * archived the way a person archiving its incident would (the Go
 * ArchiveErrorGroup path), open ticket work is failed, and the observation
 * decision ledger inside the lookback is deleted so a backfill with the same
 * --since decides those observations again. Evidence rows (signals, matches, checks) are kept for
 * audit; archived tickets never match or publish again.
 *
 * Refuses while any ticket has a fix attempt in flight or a PR open, so a
 * reset never strands a customer-visible PR.
 */
export async function resetFrictionTickets(pool: pg.Pool, options: ResetOptions): Promise<ResetResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scope = await client.query('SELECT id FROM environments WHERE id=$1 AND project_id=$2', [options.environmentId, options.projectId]);
    if (!scope.rowCount) throw new Error('Environment does not belong to project');
    // Same lock as matching, confirmation, purge and publication writers.
    await lockPublication(client, options.environmentId);
    const tickets = await client.query<{ id: string }>(
      `SELECT id FROM friction_tickets WHERE project_id=$1 AND environment_id=$2 AND status<>'archived' ORDER BY id FOR UPDATE`,
      [options.projectId, options.environmentId],
    );
    const ids = tickets.rows.map((row) => row.id);
    const delivering = await client.query<{ count: string }>(
      `SELECT count(*) FROM friction_fix_attempts WHERE ticket_id=ANY($1::uuid[]) AND status IN ('active','pr_open')`,
      [ids],
    );
    if (Number(delivering.rows[0]!.count) > 0) {
      throw new Error(`Refusing to reset: ${delivering.rows[0]!.count} fix attempt(s) are in flight or have an open PR`);
    }
    await client.query(
      `UPDATE friction_tickets SET status='archived',steps=NULL,reconcile_needed=false,reinvestigate_needed=false,updated_at=now() WHERE id=ANY($1::uuid[])`,
      [ids],
    );
    const incidents = await client.query<{ id: string }>(
      `UPDATE error_groups SET status_before_archive=status,status='archived',archived_at=now(),representative_signal_id=NULL,representative_session_id=NULL,updated_at=now()
       WHERE project_id=$1 AND ticket_id=ANY($2::uuid[]) AND status<>'archived' RETURNING id`,
      [options.projectId, ids],
    );
    const ticketJobs = await client.query(
      `UPDATE error_group_jobs SET status='failed',last_error='known problems reset',lease_expires_at=NULL,updated_at=now()
       WHERE project_id=$1 AND ticket_id=ANY($2::uuid[]) AND status IN ('pending','claimed')`,
      [options.projectId, ids],
    );
    const matchJobs = await client.query(
      `UPDATE error_group_jobs j SET status='failed',last_error='known problems reset',lease_expires_at=NULL,updated_at=now()
       FROM sessions s WHERE j.project_id=$1 AND j.job_type='friction_match' AND j.status IN ('pending','claimed')
         AND s.id=j.session_id AND s.project_id=$1 AND s.environment_id=$2`,
      [options.projectId, options.environmentId],
    );
    await client.query(
      `UPDATE friction_confirm_batches SET status='discarded' WHERE ticket_id=ANY($1::uuid[]) AND status='staging'`,
      [ids],
    );
    await client.query(
      `UPDATE digest_card_copy SET invalidated_at=now() WHERE error_group_id IN (SELECT id FROM error_groups WHERE ticket_id=ANY($1::uuid[])) AND invalidated_at IS NULL`,
      [ids],
    );
    // Sessions and legacy readers follow incident_id; recordings must not stay
    // attached to issues that no longer exist for the customer.
    await client.query(
      `UPDATE friction_signals SET incident_id=NULL
       WHERE project_id=$1 AND incident_id IN (SELECT id FROM error_groups WHERE project_id=$1 AND ticket_id=ANY($2::uuid[]))`,
      [options.projectId, ids],
    );
    // Only narratives the backfill schedules again (same lookback, same scope).
    const decisions = await client.query(
      `DELETE FROM friction_observation_decisions d USING friction_signals f, session_narratives n
       WHERE d.project_id=$1 AND d.environment_id=$2 AND f.id=d.signal_id
         AND n.session_id=f.session_id AND n.project_id=$1 AND n.environment_id=$2 AND n.created_at >= $3`,
      [options.projectId, options.environmentId, options.since],
    );
    const processed = await client.query(
      `DELETE FROM friction_session_processed p USING session_narratives n
       WHERE p.project_id=$1 AND n.session_id=p.session_id AND n.project_id=$1 AND n.environment_id=$2 AND n.created_at >= $3`,
      [options.projectId, options.environmentId, options.since],
    );
    await client.query('COMMIT');
    return {
      tickets: ids.length,
      incidents: incidents.rowCount ?? 0,
      jobs: (ticketJobs.rowCount ?? 0) + (matchJobs.rowCount ?? 0),
      decisions: decisions.rowCount ?? 0,
      processed: processed.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseResetArgs(process.argv.slice(2));
    if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
    console.log(JSON.stringify({ reset: await resetFrictionTickets(getPool(), options) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally { await closePool(); }
}
