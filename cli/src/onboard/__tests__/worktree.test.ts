import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { uncommittedFiles } from '../worktree.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'opslane-worktree-'));
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'test@opslane.invalid');
  git(root, 'config', 'user.name', 'Opslane Test');
  writeFileSync(join(root, 'tracked.txt'), 'original\n');
  writeFileSync(join(root, 'old-name.txt'), 'rename me\n');
  writeFileSync(join(root, 'with space.txt'), 'spaced\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
}

describe('uncommittedFiles', () => {
  it('returns an empty list for a clean worktree', () => {
    expect(uncommittedFiles(repository())).toEqual([]);
  });

  it('returns modified and untracked paths', () => {
    const root = repository();
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'new.ts'), '');

    expect(uncommittedFiles(root)?.sort()).toEqual(['new.ts', 'tracked.txt']);
  });

  it('returns both sides of a rename', () => {
    const root = repository();
    git(root, 'mv', 'old-name.txt', 'new-name.txt');

    expect(uncommittedFiles(root)?.sort()).toEqual(['new-name.txt', 'old-name.txt']);
  });

  it('preserves a path containing a space', () => {
    const root = repository();
    writeFileSync(join(root, 'with space.txt'), 'changed\n');

    expect(uncommittedFiles(root)).toEqual(['with space.txt']);
  });

  it('returns null outside a git repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'opslane-not-git-'));
    expect(uncommittedFiles(root)).toBeNull();
  });
});
