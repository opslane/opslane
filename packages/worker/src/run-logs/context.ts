import type { ClaimedJob } from '../db.js';

/** Job identity a run log carries. Never used for retention. */
export interface RunContext {
  jobId: string;
  jobType: string;
  projectId: string;
  attempts: number;
  leaseGeneration: string;
  errorGroupId: string | null;
  ticketId: string | null;
  episodeId: string | null;
  batchId: string | null;
  sessionId: string | null;
}

export function runContextFromJob(
  job: ClaimedJob,
  overrides: Partial<Pick<RunContext, 'sessionId' | 'batchId' | 'ticketId'>> = {},
): RunContext {
  return {
    jobId: job.id,
    jobType: job.jobType,
    projectId: job.projectId,
    attempts: job.attempts,
    leaseGeneration: job.leaseGeneration,
    errorGroupId: job.errorGroupId,
    ticketId: overrides.ticketId ?? job.ticketId ?? null,
    episodeId: job.episodeId ?? null,
    batchId: overrides.batchId ?? job.batchId ?? null,
    sessionId: overrides.sessionId ?? job.sessionId ?? null,
  };
}
