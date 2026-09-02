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
