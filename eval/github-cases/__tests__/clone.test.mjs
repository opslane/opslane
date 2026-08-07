import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloneAtBase } from '../clone.mjs';

let origin, baseSha, fixSha, cacheRoot;

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

beforeAll(() => {
  origin = mkdtempSync(join(tmpdir(), 'clone-origin-'));
  cacheRoot = mkdtempSync(join(tmpdir(), 'clone-cache-'));
  git(origin, 'init', '-q');
  git(origin, 'config', 'user.email', 't@example.com');
  git(origin, 'config', 'user.name', 'T');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  writeFileSync(join(origin, 'app.ts'), 'export const bug = true;\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'base');
  baseSha = git(origin, 'rev-parse', 'HEAD');
  writeFileSync(join(origin, 'app.ts'), 'export const bug = false;\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'fix: the thing');
  fixSha = git(origin, 'rev-parse', 'HEAD');
});

afterAll(() => {
  for (const dir of [origin, cacheRoot]) rmSync(dir, { recursive: true, force: true });
});

describe('cloneAtBase', () => {
  it('produces a clone from which the fix commit cannot be resolved', () => {
    const dir = cloneAtBase(origin, baseSha, fixSha, cacheRoot);

    expect(git(dir, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(git(dir, 'rev-list', '--all', '--count')).toBe('1');
    expect(() => git(dir, 'cat-file', '-e', `${fixSha}^{commit}`)).toThrow();
  });

  it('rebuilds rather than reusing a clone whose HEAD is wrong', () => {
    const dir = cloneAtBase(origin, baseSha, fixSha, cacheRoot);
    writeFileSync(join(dir, 'app.ts'), 'mutated by a previous run\n');

    const again = cloneAtBase(origin, baseSha, fixSha, cacheRoot);

    // A reused worktree must be clean, or one arm contaminates the next.
    expect(git(again, 'status', '--porcelain')).toBe('');
  });

  it('does not add files to the checked-out tree', () => {
    const dir = cloneAtBase(origin, baseSha, fixSha, cacheRoot);

    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  // Last, deliberately: this one contaminates the shared cache on purpose, and
  // the refusal it asserts is permanent until the cache is wiped. That is the
  // safe direction for a ground-truth leak, but it does poison later cases.
  it('throws if the fix commit is somehow reachable', () => {
    const dir = cloneAtBase(origin, baseSha, fixSha, cacheRoot);
    execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', origin, fixSha]);

    expect(() => cloneAtBase(origin, baseSha, fixSha, cacheRoot)).toThrow(/leak/i);
  });
});
