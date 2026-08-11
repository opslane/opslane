import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CloneResolutionError,
  cloneRepo,
  execFileGitRunner,
  resolveClonedBranch,
} from '../repo-clone.js';

const execFile = promisify(execFileCb);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
} as NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]) =>
  execFile('git', args, { cwd, env: GIT_ENV });

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dbr-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function masterRemote(name: string): Promise<string> {
  const work = join(root, `${name}-work`);
  await execFile('git', ['init', '-q', '--initial-branch=master', work], {
    env: GIT_ENV,
  });
  await writeFile(join(work, 'a.txt'), 'hi\n');
  await git(work, 'add', '-A');
  await git(work, 'commit', '-qm', 'init');
  const bare = join(root, `${name}-bare`);
  await execFile('git', ['clone', '-q', '--bare', work, bare], {
    env: GIT_ENV,
  });
  return `file://${bare}`;
}

async function brokenHeadRemote(name: string): Promise<string> {
  const url = await masterRemote(name);
  await git(url.replace('file://', ''), 'symbolic-ref', 'HEAD', 'refs/heads/nonexistent');
  return url;
}

async function emptyRemote(name: string): Promise<string> {
  const bare = join(root, `${name}-bare`);
  await execFile('git', [
    'init',
    '-q',
    '--bare',
    '--initial-branch=master',
    bare,
  ], { env: GIT_ENV });
  return `file://${bare}`;
}

async function cloneTo(url: string, name: string): Promise<string> {
  const dir = join(root, name);
  await execFile('git', ['clone', '--depth', '1', '--', url, dir], {
    env: GIT_ENV,
  });
  return dir;
}

describe('resolveClonedBranch', () => {
  it('returns the real default branch when it is not main', async () => {
    const dir = await cloneTo(await masterRemote('ok'), 'ok-clone');
    await expect(
      resolveClonedBranch(execFileGitRunner(dir), 'o/r'),
    ).resolves.toMatchObject({ branch: 'master', headSha: expect.any(String) });
  });

  it('classifies a repository with no commits', async () => {
    const dir = await cloneTo(await emptyRemote('empty'), 'empty-clone');
    const error = await resolveClonedBranch(
      execFileGitRunner(dir),
      'o/empty',
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CloneResolutionError);
    if (!(error instanceof CloneResolutionError)) throw error;
    expect(error.kind).toBe('empty_repository');
    expect(error.message).toContain('o/empty');
  });

  it('does not call a broken-HEAD repository empty', async () => {
    const dir = await cloneTo(await brokenHeadRemote('broken'), 'broken-clone');
    const error = await resolveClonedBranch(
      execFileGitRunner(dir),
      'o/broken',
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CloneResolutionError);
    if (!(error instanceof CloneResolutionError)) throw error;
    expect(error.kind).toBe('invalid_default_branch');
    expect(error.discoveredBranch).toBe('nonexistent');
    expect(error.message).toContain('o/broken');
    expect(error.message).toContain('nonexistent');
  });

  it('classifies detached HEAD as unresolvable', async () => {
    const dir = await cloneTo(await masterRemote('detached'), 'detached-clone');
    await git(dir, 'checkout', '--detach', '-q');
    const error = await resolveClonedBranch(
      execFileGitRunner(dir),
      'o/detached',
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CloneResolutionError);
    if (!(error instanceof CloneResolutionError)) throw error;
    expect(error.kind).toBe('unresolvable_head');
  });
});

describe('cloneRepo without a pinned branch', () => {
  it('clones a master-default repository and reports the branch', async () => {
    const result = await cloneRepo({
      githubRepo: 'o/r',
      jobId: `dbr-${Date.now()}`,
      repoUrl: await masterRemote('hostclone'),
    });
    expect(result.defaultBranch).toBe('master');
    await result.cleanup();
  });
});
