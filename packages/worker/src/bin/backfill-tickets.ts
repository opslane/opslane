import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { closePool, enqueueJobTx, getPool } from '../db.js';
import { deriveNarrativeId } from '../narrative/emit.js';

export interface BackfillOptions {
  projectId: string;
  environmentId: string;
  since: Date;
  rate: number;
}

export function parseBackfillArgs(args: string[], now = new Date()): BackfillOptions {
  const { values } = parseArgs({ args, options: {
    project: { type: 'string' }, environment: { type: 'string' },
    since: { type: 'string' }, rate: { type: 'string' },
  } });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const days = /^(\d+)d$/.exec(values.since ?? '');
  const rate = Number(values.rate);
  if (!values.project || !uuid.test(values.project) ||
      !values.environment || !uuid.test(values.environment) ||
      !days || Number(days[1]) <= 0 || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Usage: backfill-tickets --project UUID --environment UUID --since 14d --rate 60');
  }
  const since = new Date(now.getTime() - Number(days[1]) * 86_400_000);
  if (!Number.isFinite(since.getTime())) throw new Error('Invalid lookback duration');
  return { projectId: values.project, environmentId: values.environment, since, rate };
}

/** Schedule work durably, then exit. The ordinary match handler converts old narratives. */
export async function backfillTickets(pool: pg.Pool, options: BackfillOptions): Promise<number> {
  if (!Number.isFinite(options.rate) || options.rate <= 0) throw new Error('Rate must be positive');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scope = await client.query('SELECT id FROM environments WHERE id=$1 AND project_id=$2', [options.environmentId, options.projectId]);
    if (!scope.rowCount) throw new Error('Environment does not belong to project');
    const narratives = await client.query<{ session_id: string; created_at: string; prompt_version: number }>(
      `SELECT n.session_id,n.created_at::text,n.prompt_version FROM session_narratives n
       JOIN sessions s ON s.id=n.session_id AND s.project_id=n.project_id AND s.environment_id=n.environment_id
       WHERE n.project_id=$1 AND n.environment_id=$2 AND n.status='ok' AND n.created_at >= $3
       ORDER BY n.created_at,n.session_id`, [options.projectId, options.environmentId, options.since]);
    const startedAt = Date.now();
    let enqueued = 0;
    for (const narrative of narratives.rows) {
      const narrativeId = deriveNarrativeId(narrative.session_id, narrative.created_at, narrative.prompt_version);
      const pending = await client.query(
        `WITH atomic AS (
           SELECT f.id FROM friction_signals f WHERE f.project_id=$1 AND f.environment_id=$2
             AND f.session_id=$3 AND f.narrative_id=$4 AND f.observation_id IS NOT NULL
         ) SELECT 1 WHERE EXISTS (
           SELECT 1 FROM atomic a WHERE NOT EXISTS (
             SELECT 1 FROM friction_observation_decisions d WHERE d.signal_id=a.id
               AND d.project_id=$1 AND d.environment_id=$2 AND d.session_id=$3 AND d.decision<>'reserved'
           )
         ) OR (NOT EXISTS (SELECT 1 FROM atomic) AND NOT EXISTS (
           SELECT 1 FROM friction_session_processed WHERE project_id=$1 AND session_id=$3 AND narrative_id=$4
         ))`, [options.projectId, options.environmentId, narrative.session_id, narrativeId]);
      if (!pending.rowCount) continue;
      const id = await enqueueJobTx(client, 'friction_match', options.projectId, {
        sessionId: narrative.session_id, payload: { backfill: true },
        availableAt: new Date(startedAt + enqueued * 60_000 / options.rate),
      });
      if (id) enqueued++;
    }
    await client.query('COMMIT');
    return enqueued;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseBackfillArgs(process.argv.slice(2));
    if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
    console.log(`Enqueued ${await backfillTickets(getPool(), options)} friction_match jobs`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally { await closePool(); }
}
