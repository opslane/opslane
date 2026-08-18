import type { ClaimedJob } from '../db.js';
import { getErrorEvent, getPool, getSourceMapRows } from '../db.js';
import { fetchObject, getMinIOConfig } from '../minio-client.js';
import { resolveEventStack } from '../resolve-stack.js';
import { buildEnvelope, RESOLVER_VERSION, type EnvelopeV2 } from './envelope.js';
import { lookupPosition, storePosition } from './position-cache.js';

type ResolutionStatus = 'resolved' | 'no_map' | 'failed' | 'pending';

async function recordResolution(
  projectId: string,
  eventId: string,
  status: ResolutionStatus,
  envelope: EnvelopeV2 | null,
): Promise<void> {
  await getPool().query(
    `INSERT INTO error_event_resolutions
       (project_id, event_id, status, envelope, resolver_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, event_id) DO UPDATE
       SET status = CASE
             WHEN error_event_resolutions.status = 'resolved'
              AND error_event_resolutions.resolver_version >= EXCLUDED.resolver_version
               THEN error_event_resolutions.status
             ELSE EXCLUDED.status
           END,
           envelope = CASE
             WHEN error_event_resolutions.status = 'resolved'
              AND error_event_resolutions.resolver_version >= EXCLUDED.resolver_version
               THEN error_event_resolutions.envelope
             ELSE EXCLUDED.envelope
           END,
           resolver_version = CASE
             WHEN error_event_resolutions.status = 'resolved'
              AND error_event_resolutions.resolver_version >= EXCLUDED.resolver_version
               THEN error_event_resolutions.resolver_version
             ELSE EXCLUDED.resolver_version
           END,
           resolved_at = CASE
             WHEN error_event_resolutions.status = 'resolved'
              AND error_event_resolutions.resolver_version >= EXCLUDED.resolver_version
               THEN error_event_resolutions.resolved_at
             ELSE now()
           END`,
    [projectId, eventId, status, envelope, RESOLVER_VERSION],
  );
}

export async function runStackResolve(job: ClaimedJob): Promise<void> {
  if (!job.eventId) throw new Error(`Job ${job.id} missing event_id`);

  const event = await getErrorEvent(job.eventId, job.projectId);
  if (!event) {
    throw new Error(`Event ${job.eventId} not found in project ${job.projectId}`);
  }

  // Publish the wait state before reading the artifact catalog. If a map lands
  // after this point, the upload path can enqueue a fresh resolution even when
  // this job already observed the catalog as empty.
  await recordResolution(job.projectId, job.eventId, 'pending', null);

  const minioConfig = getMinIOConfig();
  const result = await resolveEventStack(
    {
      stackTraceRaw: event.stack_trace_raw,
      debugMeta: event.debug_meta,
      projectId: job.projectId,
    },
    {
      getMapRows: getSourceMapRows,
      fetchMap: async (objectKey) => {
        if (!minioConfig) return null;
        return (await fetchObject(objectKey, minioConfig)).toString('utf8');
      },
      lookupPosition,
      storePosition,
    },
  );

  if (result.status === 'no_debug_ids') {
    await recordResolution(job.projectId, job.eventId, 'no_map', null);
    return;
  }
  if (result.status === 'map_not_found') {
    await recordResolution(job.projectId, job.eventId, 'pending', null);
    return;
  }
  if (result.identityFrames?.length) {
    await recordResolution(
      job.projectId,
      job.eventId,
      'resolved',
      buildEnvelope(result.identityFrames),
    );
    return;
  }

  // A mid-retry failure stays 'failed' so the next attempt can still resolve.
  // The final attempt settles the explicit raw fallback instead: identity must
  // never wait on a resolution that will not come. The throw still dead-letters
  // the job so the operator sees the exhaustion.
  const finalAttempt = job.maxAttempts != null && job.attempts + 1 >= job.maxAttempts;
  await recordResolution(
    job.projectId,
    job.eventId,
    finalAttempt ? 'no_map' : 'failed',
    null,
  );
  throw new Error(`Stack resolution failed for event ${job.eventId}: ${result.status}`);
}
