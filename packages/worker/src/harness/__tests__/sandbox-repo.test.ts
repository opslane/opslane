import { describe, it, expect } from 'vitest';
import type { SandboxRuntime } from '../sandbox-runtime.js';
import { parseAffectedFiles, runBuildGate, selectBuildCommand } from '../sandbox-repo.js';

function buildSandbox(opts: {
  files?: Record<string, string>;
  run?: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): SandboxRuntime {
  return {
    id: 'fake-sandbox',
    createdAt: 0,
    lifetimeMs: 1_800_000,
    unavailable: false,
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
