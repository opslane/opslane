import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CommandExitError, TimeoutError } from 'e2b';
import { SandboxUnavailableError, type SandboxRuntime } from './sandbox-runtime.js';

/**
 * The deterministic reliability harness's sandbox transport double.
 *
 * It runs commands on THIS host, so it is a test double and not a security
 * boundary: it may only execute trusted fixture repositories and scripted model
 * commands. It lives in its own module, reached by a dynamic import that
 * `createSandboxRuntime` performs only after proving
 * `OPSLANE_RELIABILITY_HARNESS=1`, so a production process never evaluates it.
 * `src/__tests__/readonly-isolation.test.ts` asserts both halves of that.
 */

const execFile = promisify(execFileCallback);
const VIRTUAL_HOME = '/home/user';
const VIRTUAL_TMP = '/tmp';

interface CommandFailure extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

/**
 * Raise a failed local command as the class the provider would have raised.
 *
 * Callers classify command failures by type, not by duck-typing: the read-only
 * reader reads `grep`'s "no matches" 1 and the containment guard's 3 and 4 off a
 * `CommandExitError`, `machine-state.ts` treats that class as proof the machine
 * is alive, and a `TimeoutError` is a bad tool call the model can narrow rather
 * than a dead machine. A double that threw its own class sent every one of those
 * down the machine-death path instead.
 */
function localCommandFailure(failure: CommandFailure, timeoutMs: number | undefined): Error {
  const detail = String(failure.stderr ?? failure.stdout ?? failure.message ?? '').trim();
  if (failure.killed === true || failure.signal === 'SIGTERM') {
    return new TimeoutError(`Command timed out after ${timeoutMs ?? 0}ms${detail ? `: ${detail}` : ''}`);
  }
  return new CommandExitError({
    // `execFile` reports a signal death with a null code. E2B reports the
    // shell's 128+n, and 137 is the value `classifyInstallFailure` already
    // reads as our machine's fault rather than the customer's dependency list.
    exitCode: typeof failure.code === 'number' ? failure.code : 137,
    error: `Command exited with code ${String(failure.code ?? 'unknown')}${detail ? `: ${detail}` : ''}`,
    stdout: String(failure.stdout ?? ''),
    stderr: String(failure.stderr ?? ''),
  });
}

export async function createLocalSandboxRuntime(): Promise<SandboxRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'opslane-local-sandbox-'));
  const home = join(root, 'home', 'user');
  const localTmp = join(root, 'tmp');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(localTmp, { recursive: true }),
  ]);

  // The double's whole notion of machine liveness: true from creation, false
  // once killed. `isRunning` answers from it, so a probe after teardown reports
  // `gone` exactly as the provider would.
  let alive = true;

  const ensureRunning = (): void => {
    if (!alive) throw new SandboxUnavailableError('Sandbox has been killed');
  };

  const mapPath = (path: string): string => {
    ensureRunning();
    let mapped: string;
    if (path === VIRTUAL_HOME || path.startsWith(`${VIRTUAL_HOME}/`)) {
      mapped = join(root, path.slice(1));
    } else if (path === VIRTUAL_TMP || path.startsWith(`${VIRTUAL_TMP}/`)) {
      mapped = join(localTmp, path.slice(VIRTUAL_TMP.length + 1));
    } else if (!isAbsolute(path)) {
      mapped = resolve(root, path);
    } else {
      throw new Error(`Local sandbox path is outside the virtual filesystem: ${path}`);
    }

    const fromRoot = relative(root, mapped);
    if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Local sandbox path escapes the virtual filesystem: ${path}`);
    }
    return mapped;
  };

  const rewriteCommand = (command: string): string => {
    // Fixture repositories are passed as host file:// URLs. Preserve those URLs
    // while translating virtual sandbox paths; on Linux both live under /tmp,
    // so a blind replacement redirects git to a nonexistent path inside root.
    const hostFileUrls: string[] = [];
    const protectedCommand = command.replace(/file:\/\/[^\s'"]+/g, (url) => {
      const placeholder = `__OPSLANE_HOST_FILE_URL_${hostFileUrls.length}__`;
      hostFileUrls.push(url);
      return placeholder;
    });

    let rewritten = protectedCommand
      .replaceAll(VIRTUAL_TMP, localTmp)
      .replaceAll(VIRTUAL_HOME, home);
    for (const [index, url] of hostFileUrls.entries()) {
      rewritten = rewritten.replaceAll(`__OPSLANE_HOST_FILE_URL_${index}__`, url);
    }
    return rewritten;
  };

  const commandEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'CI']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env['HOME'] = home;
    env['TMPDIR'] = localTmp;
    return env;
  };

  const createdAt = Date.now();

  return {
    id: `local-${createdAt}`,
    createdAt,
    // 0 means "no provider-imposed ceiling" — it lives until killed. Do NOT use
    // Number.POSITIVE_INFINITY: OpenTelemetry attributes must be finite and JSON
    // logging serializes it as null.
    lifetimeMs: 0,
    get unavailable() { return !alive; },
    isRunning: async () => alive,
    commands: {
      async run(command, options) {
        ensureRunning();
        const timeoutMs = options?.timeoutMs;
        try {
          const result = await execFile('/bin/sh', ['-c', rewriteCommand(command)], {
            cwd: root,
            env: commandEnv(),
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
          });
          return {
            exitCode: 0,
            stdout: String(result.stdout ?? ''),
            stderr: String(result.stderr ?? ''),
          };
        } catch (error: unknown) {
          throw localCommandFailure(error as CommandFailure, timeoutMs);
        }
      },
    },
    files: {
      async read(path) {
        return readFile(mapPath(path), 'utf8');
      },
      async write(path, data) {
        const mapped = mapPath(path);
        await mkdir(dirname(mapped), { recursive: true });
        await writeFile(mapped, data, 'utf8');
      },
    },
    // Idempotent: `close`/`finally` teardown can reach this twice, and the
    // second call must not fail or resurrect the machine.
    async kill() {
      if (!alive) return;
      alive = false;
      await rm(root, { recursive: true, force: true });
    },
  };
}