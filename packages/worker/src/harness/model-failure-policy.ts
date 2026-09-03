import { NonRetryableJobError } from './errors.js';
/** Why a read-only agent job failed, and therefore how it is retried. */
export type DeadLetterClass = 'limit' | 'agent' | 'config' | 'transient';
export type ModelFailureClass = 'deterministic' | 'oversized' | 'transient';

const OVERSIZED = /prompt is too long|too many tokens|exceeds? .*(context|token)/i;

export function classifyModelFailure(input: { status?: number; detail: string }): ModelFailureClass {
  const { status, detail } = input;
  if (status === 400 && OVERSIZED.test(detail)) return 'oversized';
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return 'deterministic';
  }
  return 'transient';
}

/**
 * The one mapping from a failed model call to the error a job handler throws.
 * Transient failures are ordinary errors the queue retries with backoff;
 * everything else is an operator problem that runs once and re-runs after the
 * next deploy. Written here so the four read-only lanes cannot drift.
 */
export function modelFailureError(input: {
  status?: number;
  detail: string;
  costUsd: number;
  message: string;
  stop?: string;
}): Error {
  const failureClass = classifyModelFailure({
    ...(input.status === undefined ? {} : { status: input.status }),
    detail: input.detail,
  });
  if (failureClass === 'transient') return new Error(input.message);
  return new NonRetryableJobError(input.message, 'config', {
    stop: input.stop ?? 'api_error',
    costUsd: input.costUsd,
  });
}

export function deadLetterClassForStop(stop: string): DeadLetterClass {
  switch (stop) {
    case 'turns_exhausted':
    case 'budget':
    case 'truncated':
      return 'limit';
    default:
      return 'agent';
  }
}
