import { Sandbox, SandboxNotFoundError } from 'e2b';
import type { SandboxNetworkOpts } from 'e2b';
import type { Platform } from '../platform.js';

/** Must match the template name in packages/worker/e2b-python/e2b.toml. */
const DEFAULT_PYTHON_TEMPLATE = 'opslane-python';

/**
 * Measured worst-case run is ~606s (Langfuse agent-loop p100 x4 attempts plus
 * gates, opslane-oss#255). The floor guards against gross misconfiguration; it
 * is not a proof of sufficiency, because the phase timeout caps are not all
 * simultaneously reachable and their sum exceeds this. The default matches the
 * Python path, which already runs 1_800_000 in production and therefore proves
 * this account's tier accepts it.
 */
const SANDBOX_LIFETIME_FLOOR_MS = 900_000;
const SANDBOX_LIFETIME_DEFAULT_MS = 1_800_000;
/**
 * E2B enforces account-tier maximums and rejects creation above them. 1_800_000
 * is the only value proven acceptable on this account (the Python path has run
 * it in production). Anything higher is clamped rather than risking a creation
 * failure that would look like an unrelated outage.
 */
const SANDBOX_LIFETIME_CEILING_MS = 1_800_000;

function resolveSandboxLifetimeMs(): number {
  const raw = parseInt(process.env['SANDBOX_LIFETIME_MS'] ?? String(SANDBOX_LIFETIME_DEFAULT_MS), 10);
  if (!Number.isInteger(raw)) return SANDBOX_LIFETIME_DEFAULT_MS;
  if (raw < SANDBOX_LIFETIME_FLOOR_MS) return SANDBOX_LIFETIME_DEFAULT_MS;
  if (raw > SANDBOX_LIFETIME_CEILING_MS) return SANDBOX_LIFETIME_CEILING_MS;
  return raw;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The verification machine is gone — expired, evicted, or never existed.
 * Distinct from a command that ran and failed: no verdict about the patch is
 * possible once this is raised. Callers must classify it as infra_error.
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

/** The small portion of the E2B API used by the agent and verification harness. */
export interface SandboxRuntime {
  /** Provider's sandbox identifier, for correlating an incident to the machine. */
  readonly id: string;
  /** Epoch ms at creation. Required: id and lifetimeMs alone cannot yield age-at-error. */
  readonly createdAt: number;
  /** Wall-clock ceiling this sandbox was provisioned with. */
  readonly lifetimeMs: number;
  /**
   * Latched once the provider reports the machine is gone. Never resets.
   * Exists because agent-core/tool-loop.ts converts every tool exception into
   * model-visible text, so no exception can escape runAgentLoop. State can.
   */
  readonly unavailable: boolean;
  /**
   * Ask the backend whether the machine is still up.
   *
   * `classifyFailure` needs this to tell a dead machine from a command that
   * merely failed, so every backend must answer from its own state. Never
   * throws for a machine that is gone: it answers `false`, because the probe
   * runs inside a catch that is already handling one failure.
   */
  isRunning(options?: { requestTimeoutMs?: number }): Promise<boolean>;
  commands: {
    run(command: string, options?: { timeoutMs?: number }): Promise<SandboxCommandResult>;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<unknown>;
  };
  kill(): Promise<unknown>;
}

/** The E2B object shape this adapter needs. Avoids importing SDK types wholesale. */
interface E2BSandboxLike {
  sandboxId: string;
  isRunning(options?: { requestTimeoutMs?: number }): Promise<boolean>;
  commands: { run(command: string, options?: { timeoutMs?: number }): Promise<SandboxCommandResult> };
  files: { read(path: string): Promise<string>; write(path: string, data: string): Promise<unknown> };
  kill(): Promise<unknown>;
}

/**
 * Wrap the provider so a vanished sandbox becomes a typed, latched signal.
 * Only SandboxNotFoundError is mapped: E2B's TimeoutError also covers ordinary
 * per-command deadlines, and mapping it would turn an agent command timeout
 * into a whole-job retry.
 */
function adaptE2BSandbox(sbx: E2BSandboxLike, lifetimeMs: number, createdAt: number): SandboxRuntime {
  let unavailable = false;

  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (err: unknown) {
      if (err instanceof SandboxNotFoundError) {
        unavailable = true;
        throw new SandboxUnavailableError(err.message);
      }
      throw err;
    }
  };

  return {
    id: sbx.sandboxId,
    createdAt,
    lifetimeMs,
    get unavailable() { return unavailable; },
    // Deliberately outside `guard`. This is the probe `classifyFailure` runs
    // while handling another failure; latching `unavailable` and re-throwing
    // from it would turn the question into a second error.
    isRunning: (options) => sbx.isRunning(options),
    commands: {
      run: (command, options) => guard(() => sbx.commands.run(command, options)),
    },
    files: {
      read: (path) => guard(() => sbx.files.read(path)),
      write: (path, data) => guard(() => sbx.files.write(path, data)),
    },
    kill: () => sbx.kill(),
  };
}

/**
 * Create the configured sandbox runtime. Production remains on E2B unless the
 * local backend is selected explicitly by the deterministic reliability harness.
 * The local backend is a transport test double, not a security boundary, and
 * must only execute trusted fixture repositories and scripted model commands.
 *
 * `network` is the egress policy the machine is provisioned with. Only the E2B
 * backend can apply it; the local backend runs commands on this host and has no
 * network concept to model, so it ignores the argument rather than pretending
 * to enforce it. `scripts/verify-isolation.ts` is what proves the policy is
 * really enforced, against real E2B.
 */
export async function createSandboxRuntime(
  platform: Platform = 'javascript',
  network?: SandboxNetworkOpts,
): Promise<SandboxRuntime> {
  const backend = process.env['OPSLANE_SANDBOX_BACKEND']?.trim().toLowerCase() || 'e2b';
  if (backend === 'e2b') {
    // The lifetime is a ceiling, not a reservation: agent-fix.ts kills the
    // sandbox in a finally and E2B bills actual uptime, so a job finishing in
    // 60s costs 60s regardless. The accepted cost is crash exposure — if the
    // worker process dies, finally never runs and the orphan leaks for up to
    // the ceiling rather than 5 minutes. The Python path already carries this.
    const lifetimeMs = resolveSandboxLifetimeMs();
    // Captured BEFORE the await: creation takes real time, and age-at-error must
    // measure from when provisioning started, not when the promise resolved.
    const createdAt = Date.now();
    // Spread rather than `network: undefined`: a machine with no policy must be
    // created exactly as it was before this parameter existed.
    const createOpts = { timeoutMs: lifetimeMs, ...(network ? { network } : {}) };
    if (platform !== 'python') {
      return adaptE2BSandbox(await Sandbox.create(createOpts), lifetimeMs, createdAt);
    }
    const template = process.env['OPSLANE_E2B_PYTHON_TEMPLATE']?.trim() || DEFAULT_PYTHON_TEMPLATE;
    return adaptE2BSandbox(await Sandbox.create(template, createOpts), lifetimeMs, createdAt);
  }
  if (backend === 'local') {
    if (process.env['OPSLANE_RELIABILITY_HARNESS'] !== '1') {
      throw new Error('Local sandbox backend requires OPSLANE_RELIABILITY_HARNESS=1');
    }
    // Imported here, after the gate, and never at module scope: the double runs
    // commands on this host, and a static import would put `node:child_process`
    // in the import graph of every read-only job. Behind the gate, a production
    // process never even evaluates the module.
    const { createLocalSandboxRuntime } = await import('./local-sandbox.js');
    return createLocalSandboxRuntime();
  }
  throw new Error(`Unsupported OPSLANE_SANDBOX_BACKEND: ${backend}`);
}
