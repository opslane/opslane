import { SandboxImageError } from './errors.js';
import { isCommandFailure } from './machine-state.js';
import type { SandboxRuntime } from './sandbox-runtime.js';

/** Assert that a JavaScript image supplies the supported Node major version. */
export async function assertModernNode(sandbox: SandboxRuntime): Promise<void> {
  try {
    await sandbox.commands.run(
      `node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"`,
      { timeoutMs: 15_000 },
    );
  } catch (err: unknown) {
    if (!isCommandFailure(err)) throw err;
    throw new SandboxImageError(
      'The sandbox image does not provide Node 22 or newer. Check OPSLANE_E2B_JAVASCRIPT_TEMPLATE.',
    );
  }
}
