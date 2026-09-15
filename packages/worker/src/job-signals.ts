/**
 * Handlers throw these after durably completing or rescheduling their own job,
 * to stop further work. The poller treats them as completed; traces and the
 * failed-job counter must agree. Matched by name so this module imports
 * nothing and tracing.ts never loads db.ts.
 */
const COMPLETION_SIGNALS: ReadonlySet<string> = new Set([
  'JobCompletedInTransaction',
  'JobRescheduledError',
]);

export function isJobCompletionSignal(err: unknown): err is Error {
  return err instanceof Error && COMPLETION_SIGNALS.has(err.name);
}
