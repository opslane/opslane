import { scrubSecrets } from './harness/redact.js';
import { emitUsageEvent } from './usage-events.js';
import type { ReadOnlyNetwork } from './harness/sandbox-network.js';

/** Where in a fix run the failure happened. Install failures are the only ones
 * the classifier already explains; the rest arrive with no hint that the
 * network was the cause, which is why every phase alerts. */
export type FixPhase = 'clone' | 'setup' | 'install' | 'test' | 'build';

/** Slack is a chat window, not a log sink. */
const MAX_DETAIL = 800;

/**
 * Tell the operator when a fix run failed on a machine whose network we
 * restricted.
 *
 * This is the learning half of shipping the egress policy on by default. A
 * blocked host during clone, setup, test or build surfaces as an ordinary
 * failure with nothing pointing at the allowlist, and fix jobs are rare enough
 * that the connection would not otherwise be made for weeks.
 *
 * Silent when the machine had no policy: nothing could have been blocked, so an
 * alert would be noise that trains the reader to ignore the real ones.
 */
export function alertRestrictedMachineFailure(input: {
  network: ReadOnlyNetwork | undefined;
  phase: FixPhase;
  jobId: string;
  projectId: string;
  detail: string;
}): void {
  if (!input.network) return;
  emitUsageEvent('fix_restricted_machine_failed', {
    job_id: input.jobId,
    project_id: input.projectId,
    phase: input.phase,
    allow_out: input.network.allowOut.join(','),
    // Raw command output. It can carry a token or a private registry URL, and
    // the host it names is usually the whole point of reading this.
    detail: scrubSecrets(input.detail).slice(0, MAX_DETAIL),
  });
}
