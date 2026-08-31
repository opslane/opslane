import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntime } from '../sandbox-runtime.js';

const state = vi.hoisted(() => ({
  commands: [] as string[],
  failWhenIncludes: undefined as string | undefined,
  /** Repo-relative path -> contents. Anything absent reads as "not found". */
  files: {} as Record<string, string>,
  /** Command substring -> stdout, for probes like the python version check. */
  stdoutFor: {} as Record<string, string>,
  kill: vi.fn(async () => undefined),
}));

// Preserve the real exports: sandbox-repo.ts narrows on SandboxUnavailableError,
// and a factory that returns only createSandboxRuntime makes `instanceof` throw.
vi.mock('../sandbox-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox-runtime.js')>()),
  createSandboxRuntime: vi.fn(async (): Promise<SandboxRuntime> => ({
    id: 'fake-sandbox',
    createdAt: 0,
    lifetimeMs: 1_800_000,
    unavailable: false,
    isRunning: async () => true,
    commands: {
      run: async (command: string) => {
        state.commands.push(command);
        if (state.failWhenIncludes && command.includes(state.failWhenIncludes)) {
          throw new Error(`command failed: ${state.failWhenIncludes}`);
        }
        const stdout = Object.entries(state.stdoutFor)
          .find(([needle]) => command.includes(needle))?.[1] ?? '';
        return { exitCode: 0, stdout, stderr: '' };
      },
    },
    files: {
      read: async (path: string) => {
        const key = path.replace('/home/user/repo/', '');
        if (!(key in state.files)) throw new Error('not found');
        return state.files[key]!;
      },
      write: async () => undefined,
    },
    kill: state.kill,
  })),
}));

const { createRepoSandbox, extractDiff, runBuildGate } = await import('../sandbox-repo.js');

function recordingSandbox(exitCode = 0): SandboxRuntime {
  return {
    commands: {
      run: async (command: string) => {
        state.commands.push(command);
        return { exitCode, stdout: '', stderr: '' };
      },
    },
    files: { read: async () => { throw new Error('not found'); }, write: async () => undefined },
    kill: state.kill,
  } as unknown as SandboxRuntime;
}

beforeEach(() => {
  state.commands.length = 0;
  state.failWhenIncludes = undefined;
  state.files = {};
  state.stdoutFor = {
    'ls-remote': 'abc\trefs/heads/main\n',
    'symbolic-ref': 'main\n',
    'rev-parse': 'abc\n',
  };
  state.kill.mockClear();
});

describe('createRepoSandbox setupCommands', () => {
  it('runs setup commands after the baseline commit and commits them separately', async () => {
    await createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
      setupCommands: ['git apply bug.patch'],
    });

    const baselineIndex = state.commands.findIndex((command) => command.includes('baseline: setup'));
    const setupIndex = state.commands.findIndex((command) => command.includes('git apply bug.patch'));
    const evalCommitIndex = state.commands.findIndex((command) => command.includes('eval: setup'));
    expect(baselineIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeGreaterThan(baselineIndex);
    expect(evalCommitIndex).toBeGreaterThan(setupIndex);
  });

  it('runs no eval commit when setupCommands is absent', async () => {
    await createRepoSandbox({ repoUrl: 'https://github.com/o/r.git' });

    expect(state.commands.some((command) => command.includes('eval: setup'))).toBe(false);
  });

  it('kills the sandbox and propagates when a setup command fails', async () => {
    state.failWhenIncludes = 'git apply bug.patch';

    await expect(createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
      setupCommands: ['git apply bug.patch'],
    })).rejects.toThrow('command failed: git apply bug.patch');

    expect(state.kill).toHaveBeenCalledTimes(1);
  });

  it('kills the sandbox and propagates when the baseline commit fails', async () => {
    state.failWhenIncludes = 'baseline: setup';

    await expect(createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
    })).rejects.toThrow('command failed: baseline: setup');

    expect(state.kill).toHaveBeenCalledTimes(1);
  });
});

describe('createRepoSandbox python dependency install', () => {
  async function withFiles(files: Record<string, string>) {
    state.files = files;
    return createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
      platform: 'python',
    });
  }

  it('installs from requirements.txt when present', async () => {
    const result = await withFiles({ 'requirements.txt': 'flask\n' });

    expect(result.installOutcome).toBe('installed');
    expect(state.commands.some((c) => c.includes('pip install -r requirements.txt'))).toBe(true);
  });

  it.each([
    ['PEP 621', '[project]\nname = "x"\n'],
    ['Poetry', '[tool.poetry]\nname = "x"\n'],
    ['build-system only', '[build-system]\nrequires = ["setuptools"]\n'],
  ])('installs a %s pyproject as editable', async (_label, pyproject) => {
    const result = await withFiles({ 'pyproject.toml': pyproject });

    expect(result.installOutcome).toBe('installed');
    expect(state.commands.some((c) => c.includes('pip install -e .'))).toBe(true);
  });

  it('installs a bare setup.py project', async () => {
    const result = await withFiles({ 'setup.py': 'from setuptools import setup\n' });

    expect(result.installOutcome).toBe('installed');
    expect(state.commands.some((c) => c.includes('pip install -e .'))).toBe(true);
  });

  it('reports failed, not not_applicable, when no manifest exists', async () => {
    // not_applicable would let pytest run against an uninstalled tree and
    // surface import errors as ordinary test failures.
    expect((await withFiles({})).installOutcome).toBe('failed');
  });

  it('sanitizes the sandbox runtime probe before it reaches the PR body', async () => {
    state.files = { 'requirements.txt': '' };
    state.stdoutFor = {
      ...state.stdoutFor,
      'platform.python_implementation': 'CPython[x](http://evil) 3.12.13',
    };

    const result = await createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
      platform: 'python',
    });

    expect(result.sandboxRuntime).toEqual({ name: 'CPythonxhttpevil', version: '3.12.13' });
  });
});

describe('runBuildGate python syntax gate', () => {
  it('byte-compiles the repo instead of reporting skipped_no_runner', async () => {
    const result = await runBuildGate(recordingSandbox(0), 'python');

    expect(result.outcome).toBe('passed');
    expect(state.commands.at(-1)).toContain('python -m compileall');
  });

  it('fails the gate when compileall reports a SyntaxError', async () => {
    expect((await runBuildGate(recordingSandbox(1), 'python')).outcome).toBe('failed');
  });

  it('skips virtualenvs and caches so vendored code cannot fail the gate', async () => {
    await runBuildGate(recordingSandbox(0), 'python');

    const cmd = state.commands.at(-1)!;
    expect(cmd).toContain('.venv');
    expect(cmd).toContain('site-packages');
  });
});

describe('extractDiff python artifact reset', () => {
  it('unstages generated artifacts but never build/ or dist/', async () => {
    await extractDiff(recordingSandbox(0), 'python');

    const reset = state.commands.find((command) => command.includes('git reset'))!;
    expect(reset).toContain('__pycache__');
    expect(reset).toContain('.pytest_cache');
    // build/ and dist/ are legitimate package names; unstaging them would ship
    // a patch different from the one the test gate verified.
    expect(reset).not.toContain('build/');
    expect(reset).not.toContain('dist/');
  });

  it('runs no artifact reset on the javascript path', async () => {
    await extractDiff(recordingSandbox(0), 'javascript');

    expect(state.commands.some((command) => command.includes('git reset'))).toBe(false);
  });
});
