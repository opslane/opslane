import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cloneRepo, gitCommitAndPush, validateDiffPaths, scrubbedEnv } from '../repo-clone.js';

const execFile = promisify(execFileCb);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
} as Record<string, string>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

describe('validateDiffPaths', () => {
  it('accepts a normal diff', () => {
    const diff = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b';
    expect(validateDiffPaths(diff)).toEqual({ valid: true });
  });

  it('rejects path traversal', () => {
    const diff = '--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-a\n+b';
    const result = validateDiffPaths(diff);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsafe diff path');
  });

  it('rejects absolute paths', () => {
    const diff = '--- a//etc/passwd\n+++ b//etc/passwd\n@@ -1 +1 @@\n-a\n+b';
    expect(validateDiffPaths(diff).valid).toBe(false);
  });

  it('rejects NUL bytes in paths', () => {
    const diff = '--- a/src/x\0y.ts\n+++ b/src/x\0y.ts\n@@ -1 +1 @@\n-a\n+b';
    expect(validateDiffPaths(diff).valid).toBe(false);
  });

  it('accepts an empty diff', () => {
    expect(validateDiffPaths('')).toEqual({ valid: true });
  });
});

describe('scrubbedEnv', () => {
  const SECRETS = [
    'GITHUB_TOKEN',
    'ANTHROPIC_API_KEY',
    'DATABASE_URL',
    'MINIO_SECRET_KEY',
    'REPLAY_STORE_SECRET_KEY',
    'ENCRYPTION_KEY',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_CLIENT_SECRET',
    'OPSLANE_SOURCEMAP_KEY',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SECRETS) {
      saved[key] = process.env[key];
      process.env[key] = `secret-${key}`;
    }
  });

  afterEach(() => {
    for (const key of SECRETS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('removes every secret key but keeps the rest of the environment', () => {
    const env = scrubbedEnv();
    for (const key of SECRETS) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env['PATH']).toBe(process.env['PATH']);
  });

  it('keeps the endpoint-bearing source-map key out of spawned processes', () => {
    // vectors.valid[0].raw from test-fixtures/sourcemap-key/vectors.json.
    const canary =
      'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA'
      + '_eyJ2IjoxLCJpYXQiOiIyMDI2LTA4LTA0VDAwOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vaW5nZXN0Lm9wc2xhbmUuY29tIn0';
    process.env['OPSLANE_SOURCEMAP_KEY'] = canary;
    const env = scrubbedEnv();
    expect(env['OPSLANE_SOURCEMAP_KEY']).toBeUndefined();
    expect(Object.values(env)).not.toContain(canary);
  });
});

describe('cloneRepo', () => {
  const savedToken = process.env['GITHUB_TOKEN'];
  const savedBase = process.env['OPSLANE_GITHUB_URL'];

  afterEach(() => {
    if (savedToken === undefined) delete process.env['GITHUB_TOKEN'];
    else process.env['GITHUB_TOKEN'] = savedToken;
    if (savedBase === undefined) delete process.env['OPSLANE_GITHUB_URL'];
    else process.env['OPSLANE_GITHUB_URL'] = savedBase;
  });

  it('throws when no token is available', async () => {
    delete process.env['GITHUB_TOKEN'];
    await expect(
      cloneRepo({ githubRepo: 'owner/repo', jobId: 'no-token' }),
    ).rejects.toThrow('GITHUB_TOKEN is not set');
  });

  it('scrubs the token from clone error messages', async () => {
    // Unreachable local port: clone fails fast without network access.
    process.env['OPSLANE_GITHUB_URL'] = 'http://127.0.0.1:1';
    const token = 'ghs_super_secret_token_value';
    let caught: Error | undefined;
    try {
      await cloneRepo({
        githubRepo: 'owner/repo',
        jobId: `scrub-${Date.now()}`,
        githubToken: token,
        timeoutMs: 15_000,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(token);
  });

  it('targets the alternate git host when OPSLANE_GITHUB_URL is set', async () => {
    // A successful clone through the seam is covered by the e2e fake-github suite;
    // here the failing clone's error message proves the alternate host was used.
    process.env['OPSLANE_GITHUB_URL'] = 'http://127.0.0.1:1/base';
    let caught: Error | undefined;
    try {
      await cloneRepo({
        githubRepo: 'owner/repo',
        jobId: `seam-${Date.now()}`,
        githubToken: 'tok',
        timeoutMs: 15_000,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('127.0.0.1');
  });
});

describe('gitCommitAndPush', () => {
  let baseDir: string;
  let remoteDir: string;
  let workDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'opslane-repo-clone-test-'));
    remoteDir = join(baseDir, 'remote.git');
    workDir = join(baseDir, 'work');

    await execFile('git', ['init', '--bare', '--initial-branch=main', remoteDir], { env: GIT_ENV });
    await execFile('git', ['clone', remoteDir, workDir], { env: GIT_ENV });
    await writeFile(join(workDir, 'app.txt'), 'hello world\n');
    await git(workDir, 'add', '-A');
    await git(workDir, 'commit', '-m', 'initial');
    await git(workDir, 'push', 'origin', 'main');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('applies the diff, commits on a new branch, and pushes it to origin', async () => {
    const diff = [
      '--- a/app.txt',
      '+++ b/app.txt',
      '@@ -1 +1 @@',
      '-hello world',
      '+hello fixed world',
      '',
    ].join('\n');

    const commitMessage = [
      'Guard missing names in greeting',
      '',
      'Opening the greeting without a name crashed the page.',
      '',
      'Guard the nullable name before rendering the greeting.',
      '',
      'Verified: no new test failures compared with the pre-fix baseline.',
    ].join('\n');
    await gitCommitAndPush(workDir, 'opslane/fix-123', commitMessage, diff);

    // Branch exists on the remote with the expected commit message.
    const remoteBranches = await git(remoteDir, 'branch', '--list');
    expect(remoteBranches).toContain('opslane/fix-123');
    const message = await git(remoteDir, 'log', '-1', '--format=%B', 'opslane/fix-123');
    expect(message).toBe(commitMessage);

    // The pushed commit contains the applied diff.
    const content = await git(remoteDir, 'show', 'opslane/fix-123:app.txt');
    expect(content).toBe('hello fixed world');
  });

  it('rejects when the diff does not apply', async () => {
    const badDiff = [
      '--- a/app.txt',
      '+++ b/app.txt',
      '@@ -1 +1 @@',
      '-this line does not exist',
      '+replacement',
      '',
    ].join('\n');

    await expect(
      gitCommitAndPush(workDir, 'opslane/fix-bad', 'fix: nope', badDiff),
    ).rejects.toThrow('git apply failed');
  });
});

// These inputs are rejected before any git process runs, so no network/git is needed.
describe('cloneRepo input validation (git argument-injection guard)', () => {
  const base = { githubRepo: 'owner/repo', jobId: 'j1', githubToken: 'tok' };

  it('rejects a repo that is not owner/name', async () => {
    await expect(cloneRepo({ ...base, githubRepo: '--foo' })).rejects.toThrow(/unsafe repository name/);
  });
});

describe('isRetriableCloneFailure', () => {
  it('classifies network faults and leftover paths as retriable', async () => {
    const { isRetriableCloneFailure } = await import('../repo-clone.js');
    for (const message of [
      'fatal: unable to access repo: Could not resolve host: github.com',
      'fatal: unable to access repo: Connection timed out',
      "fatal: destination path '/tmp/opslane-repo-x' already exists and is not an empty directory",
      'error: RPC failed; HTTP 503 curl 22',
      'connect ECONNRESET',
    ]) {
      expect(isRetriableCloneFailure(new Error(message)), message).toBe(true);
    }
  });

  it('classifies deterministic access and repo-state failures as terminal', async () => {
    const { isRetriableCloneFailure, CloneResolutionError } = await import('../repo-clone.js');
    expect(isRetriableCloneFailure(new Error('GITHUB_TOKEN is not set'))).toBe(false);
    expect(isRetriableCloneFailure(new Error('fatal: Authentication failed for repo'))).toBe(false);
    expect(isRetriableCloneFailure(new Error('remote: Repository not found.'))).toBe(false);
    expect(isRetriableCloneFailure(new CloneResolutionError('empty_repository', 'o/r'))).toBe(false);
  });
});

describe('sweepAbandonedClones', () => {
  it('removes only old opslane-repo directories, never fresh or foreign ones', async () => {
    const { sweepAbandonedClones } = await import('../repo-clone.js');
    const { mkdir, utimes, stat } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'sweep-test-'));
    try {
      const oldDir = join(root, 'opslane-repo-old-abc');
      const freshDir = join(root, 'opslane-repo-fresh-def');
      const foreignDir = join(root, 'someone-elses-dir');
      await mkdir(oldDir);
      await mkdir(freshDir);
      await mkdir(foreignDir);
      const past = new Date(Date.now() - 8 * 60 * 60 * 1000);
      await utimes(oldDir, past, past);
      await utimes(foreignDir, past, past);

      const swept = await sweepAbandonedClones(6 * 60 * 60 * 1000, root);

      expect(swept).toBe(1);
      await expect(stat(oldDir)).rejects.toThrow();
      await expect(stat(freshDir)).resolves.toBeTruthy();
      await expect(stat(foreignDir)).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
