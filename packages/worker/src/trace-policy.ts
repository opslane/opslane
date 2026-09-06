import type { JobType } from '@opslane/shared';

/** Whether a job's work is worth a Langfuse trace. */
export type TracePolicy = { mode: 'off' } | { mode: 'full' };

const OFF: TracePolicy = { mode: 'off' };
const FULL: TracePolicy = { mode: 'full' };

/**
 * Exhaustive by construction: adding a JobType requires an explicit tracing
 * decision here instead of silently making the new job untraced.
 */
export const TRACE_POLICY = {
  session_analysis: OFF,
  stack_resolve: OFF,
  ci_watch: OFF,
  score_sync: OFF,
  error_fix: FULL,
  investigate: FULL,
  // score_sync loads a fix job's trace_url, so fix must remain fully traced.
  fix: FULL,
  session_narrate: FULL,
  session_verify_frames: FULL,
  issue_inquiry: FULL,
  product_context: FULL,
  route_map: FULL,
  digest_write: FULL,
} satisfies Record<JobType, TracePolicy>;

export function tracePolicyFor(jobType: JobType): TracePolicy {
  // Prefer excess quota over silently losing a trace during a skewed deploy.
  return TRACE_POLICY[jobType] ?? FULL;
}
