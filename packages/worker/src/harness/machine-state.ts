import { CommandExitError, SandboxNotFoundError } from 'e2b';

/** What the provider says about the machine, as of the moment we asked. */
export type MachineState = 'gone' | 'alive' | 'unknown';

/**
 * True when the command executed and returned a failure code, so the machine works.
 * A type predicate, not a boolean: callers read `exitCode`/`stdout`/`stderr` off
 * the narrowed value, which `unknown` would not permit.
 */
export function isCommandFailure(err: unknown): err is CommandExitError {
  return err instanceof CommandExitError;
}

/**
 * Classify a failed sandbox operation.
 *
 * `alive` is reserved for the case we can prove: the command ran and returned a
 * code. A live probe after a transport failure only tells us the machine answers
 * now, not that the failed operation was the machine's fault, so that is
 * `unknown`. `unknown` and `gone` are both retriable; only `gone` may be reported
 * as death. A paused sandbox also reads as not-running here, which is why the
 * caller logs the state rather than asserting the machine was destroyed.
 */
export async function classifyFailure(
  err: unknown,
  probe: () => Promise<boolean>,
): Promise<MachineState> {
  if (isCommandFailure(err)) return 'alive';
  if (err instanceof SandboxNotFoundError) return 'gone';
  try {
    return (await probe()) ? 'unknown' : 'gone';
  } catch {
    return 'unknown';
  }
}
