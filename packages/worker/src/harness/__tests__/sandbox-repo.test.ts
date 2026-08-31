import { describe, it, expect } from 'vitest';
import { CommandExitError } from 'e2b';
import { SandboxUnavailableError, type SandboxRuntime } from '../sandbox-runtime.js';
import { classifyInstallFailure, parseAffectedFiles, runBuildGate, selectBuildCommand } from '../sandbox-repo.js';

function buildSandbox(opts: {
  files?: Record<string, string>;
  run?: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): SandboxRuntime {
  return {
    id: 'fake-sandbox',
    createdAt: 0,
    lifetimeMs: 1_800_000,
    unavailable: false,
    isRunning: async () => true,
    files: {
      read: async (path) => {
        const content = opts.files?.[path];
        if (content === undefined) throw new Error('not found');
        return content;
      },
      write: async () => undefined,
    },
    commands: {
      run: opts.run ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    },
    kill: async () => undefined,
  };
}

describe('selectBuildCommand', () => {
  it('prefers the build script', () => {
    expect(selectBuildCommand({ scripts: { build: 'vite build' } }, true)).toBe('npm run build');
  });

  it('uses pnpm when pnpm-lock present', () => {
    expect(selectBuildCommand({ scripts: { build: 'x' } }, false, 'pnpm')).toBe('pnpm run build');
  });

  it('falls back to tsc --noEmit when a build script is absent but tsconfig exists', () => {
    expect(selectBuildCommand({}, true)).toBe('npx tsc --noEmit');
  });

  it('returns null when nothing to run', () => {
    expect(selectBuildCommand({}, false)).toBeNull();
  });
});

describe('parseAffectedFiles', () => {
  it('extracts +++ b/ paths', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+1\n';
    expect(parseAffectedFiles(diff)).toEqual(['x']);
  });
});

describe('runBuildGate taxonomy', () => {
  const files = {
    '/home/user/repo/package.json': '{"scripts":{"build":"tsc"}}',
  };

  it('reports the real exit code for a build failure', async () => {
    const error = Object.assign(new Error('Command exited with code 2'), {
      exitCode: 2,
      stderr: 'error TS2345',
    });
    const sandbox = buildSandbox({
      files,
      run: async () => { throw error; },
    });

    await expect(runBuildGate(sandbox)).resolves.toEqual({
      outcome: 'failed',
      exitCode: 2,
      output: 'error TS2345',
    });
  });

  it('classifies a timeout as infrastructure failure', async () => {
    const sandbox = buildSandbox({
      files,
      run: async () => { throw new Error('Command timed out after 240000ms'); },
    });

    await expect(runBuildGate(sandbox)).resolves.toMatchObject({
      outcome: 'infra_error',
      output: expect.stringContaining('timed out'),
    });
  });

  it('skips cleanly when there is no build or typecheck command', async () => {
    const sandbox = buildSandbox({
      files: { '/home/user/repo/package.json': '{}' },
    });

    await expect(runBuildGate(sandbox)).resolves.toEqual({
      outcome: 'skipped_no_runner',
      output: 'no build script or tsconfig',
    });
  });
});

describe('runBuildGate against an unavailable sandbox', () => {
  const deadSandbox: SandboxRuntime = {
    id: 'dead', createdAt: 0, lifetimeMs: 1_800_000, unavailable: true,
    isRunning: async () => false,
    commands: {
      run: async () => { throw new SandboxUnavailableError('Sandbox is probably not running anymore'); },
    },
    files: {
      read: async () => { throw new SandboxUnavailableError('Sandbox is probably not running anymore'); },
      write: async () => undefined,
    },
    kill: async () => undefined,
  };

  it('reports infra_error, never skipped_no_runner', async () => {
    const result = await runBuildGate(deadSandbox, 'javascript');
    // skipped_no_runner is the dangerous answer: computeTier accepts it as
    // buildOk, so a vanished machine would satisfy the build gate.
    expect(result.outcome).not.toBe('skipped_no_runner');
    expect(result.outcome).toBe('infra_error');
  });

  it('reports infra_error when the sandbox dies AFTER package.json is read', async () => {
    // Without this case the suite passes even if fileExists still swallows
    // sandbox death: the package.json read throws first and short-circuits.
    let reads = 0;
    const diesLater: SandboxRuntime = {
      ...deadSandbox,
      files: {
        read: async (path: string) => {
          reads++;
          if (path.endsWith('package.json')) return JSON.stringify({ scripts: {} });
          throw new SandboxUnavailableError('Sandbox is probably not running anymore');
        },
        write: async () => undefined,
      },
    };

    const result = await runBuildGate(diesLater, 'javascript');
    expect(reads).toBeGreaterThan(1);
    expect(result.outcome).toBe('infra_error');
  });

  it('reports infra_error for the python syntax gate too', async () => {
    const result = await runBuildGate(deadSandbox, 'python');
    expect(result.outcome).toBe('infra_error');
  });
});

describe('classifyInstallFailure', () => {
  const exit = (exitCode: number, stderr = '') =>
    new CommandExitError({ exitCode, stdout: '', stderr, error: undefined } as never);

  it('calls a clean package-manager exit a dependency problem', () => {
    expect(classifyInstallFailure(exit(1))).toBe('dependencies');
  });

  it('calls a kill signal infrastructure', () => {
    expect(classifyInstallFailure(exit(137))).toBe('infrastructure');
    expect(classifyInstallFailure(exit(143))).toBe('infrastructure');
  });

  it('calls a dropped connection infrastructure', () => {
    expect(classifyInstallFailure(new Error('2: [unknown] terminated'))).toBe('infrastructure');
  });

  it("calls a blocked host infrastructure, not the customer's fault", () => {
    const err = exit(1, 'request to https://cdn.example.com failed, reason: getaddrinfo ENOTFOUND');
    expect(classifyInstallFailure(err)).toBe('infrastructure');
  });
});
