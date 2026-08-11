import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cloneRepo,
  execFileGitRunner,
  resolveClonedBranch,
} from '../repo-clone.js';

const execFile = promisify(execFileCb);
const cleanupPaths: string[] = [];

async function fixtureRepository(): Promise<{ repo: string; headSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clone-sha-'));
  cleanupPaths.push(root);
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  await execFile('git', ['init', '--bare', '--initial-branch=main', remote]);
  await execFile('git', ['clone', remote, work]);
  await writeFile(join(work, 'a.txt'), 'x');
  await execFile('git', ['add', '.'], { cwd: work });
  await execFile('git', [
    '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-m', 'one',
  ], { cwd: work });
  await execFile('git', ['push', 'origin', 'main'], { cwd: work });
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: work });
  return { repo: remote, headSha: stdout.trim() };
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('clone head sha', () => {
  it('resolveClonedBranch returns the checked-out HEAD sha', async () => {
    const fixture = await fixtureRepository();
    const checkout = join(await mkdtemp(join(tmpdir(), 'clone-sha-checkout-')), 'repo');
    cleanupPaths.push(join(checkout, '..'));
    await execFile('git', ['clone', fixture.repo, checkout]);

    const resolved = await resolveClonedBranch(execFileGitRunner(checkout), fixture.repo);

    expect(resolved).toEqual({ branch: 'main', headSha: fixture.headSha });
  });

  it('cloneRepo exposes the checked-out HEAD sha', async () => {
    const fixture = await fixtureRepository();
    const clone = await cloneRepo({
      githubRepo: 'owner/repo',
      jobId: `head-sha-${Date.now()}`,
      repoUrl: fixture.repo,
    });

    try {
      expect(clone.headSha).toBe(fixture.headSha);
      expect(clone.defaultBranch).toBe('main');
    } finally {
      await clone.cleanup();
    }
  });
});
