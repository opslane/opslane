import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertWritable, FixSurfaceViolation, isInsideFixSurface, parseCauseLocation, resolveInsideRepo } from '../fix-surface.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'fix-surface-'));
  await mkdir(join(repo, 'client/src'), { recursive: true });
  await mkdir(join(repo, 'server/app'), { recursive: true });
  await writeFile(join(repo, 'client/src/AssetList.tsx'), 'export const x = 1;\n');
  await writeFile(join(repo, 'server/app/asset.py'), 'def get(): pass\n');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/**
 * The fix surface is an authorization boundary: it decides whether the worker
 * may write to a path in a customer's repository. Verification found the
 * lexical glob check was bypassable, so these drive the real filesystem rather
 * than a stub.
 */
describe('resolveInsideRepo', () => {
  it('resolves an ordinary file to its repository-relative path', () => {
    expect(resolveInsideRepo(repo, 'client/src/AssetList.tsx')).toBe('client/src/AssetList.tsx');
  });

  it('refuses a path that does not exist', () => {
    expect(resolveInsideRepo(repo, 'client/src/Ghost.tsx')).toBeNull();
  });

  it('refuses a directory cited as if it were a file', () => {
    expect(resolveInsideRepo(repo, 'client/src')).toBeNull();
  });

  it('refuses traversal above the repository root', () => {
    expect(resolveInsideRepo(repo, '../../etc/passwd')).toBeNull();
  });

  // The escape verification found: statSync follows the link and the glob
  // matched the literal string, so client/** authorised a write to server/.
  it('resolves a symlink to its real path so the surface check sees the truth', async () => {
    await symlink(join(repo, 'server'), join(repo, 'client/vendor'));

    const resolved = resolveInsideRepo(repo, 'client/vendor/app/asset.py');

    expect(resolved).toBe('server/app/asset.py');
    expect(isInsideFixSurface(resolved!, { globs: ['client/**'] })).toBe(false);
  });

  it('refuses a symlink that points outside the repository entirely', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await writeFile(join(outside, 'secret.ts'), 'export const secret = 1;\n');
    await symlink(join(outside, 'secret.ts'), join(repo, 'client/src/secret.ts'));

    expect(resolveInsideRepo(repo, 'client/src/secret.ts')).toBeNull();

    await rm(outside, { recursive: true, force: true });
  });
});

describe('isInsideFixSurface boundaries', () => {
  it('does not match a sibling directory with a shared prefix', () => {
    expect(isInsideFixSurface('client/App.tsx', { globs: ['client/**'] })).toBe(true);
    expect(isInsideFixSurface('clientele/secret.ts', { globs: ['client/**'] })).toBe(false);
  });

  it('is anchored, so a nested match does not count', () => {
    expect(isInsideFixSurface('vendor/client/secret.ts', { globs: ['client/**'] })).toBe(false);
  });

  it('does not let ** swallow a path separator', () => {
    const surface = { globs: ['client/**/App.tsx'] };
    expect(isInsideFixSurface('client/App.tsx', surface)).toBe(true);
    expect(isInsideFixSurface('client/deep/App.tsx', surface)).toBe(true);
    expect(isInsideFixSurface('client/EvilApp.tsx', surface)).toBe(false);
  });

  it('escapes regex metacharacters in a literal pattern', () => {
    expect(isInsideFixSurface('app.v1/x.ts', { globs: ['app.v1/**'] })).toBe(true);
    expect(isInsideFixSurface('appXv1/x.ts', { globs: ['app.v1/**'] })).toBe(false);
  });

  it('treats an empty surface as nothing writable, and null as the whole repository', () => {
    expect(isInsideFixSurface('client/App.tsx', { globs: [] })).toBe(false);
    expect(isInsideFixSurface('server/app.py', { globs: null })).toBe(true);
  });
});

describe('citation forms models actually produce', () => {
  it.each([
    ['src/App.tsx', 'src/App.tsx', undefined],
    ['src/App.tsx:42', 'src/App.tsx', 42],
    ['src/App.tsx:36-39', 'src/App.tsx', 36],
    ['src/App.tsx:42:9', 'src/App.tsx', 42],
    ['./src/App.tsx:7', 'src/App.tsx', 7],
  ])('parses %j as a repository path', (cited, path, line) => {
    const parsed = parseCauseLocation(cited);
    expect(parsed).toMatchObject(line === undefined ? { kind: 'repo_path', path } : { kind: 'repo_path', path, line });
  });
});

describe('assertWritable', () => {
  it('returns the resolved path for an existing file inside the surface', () => {
    expect(assertWritable(repo, 'client/src/AssetList.tsx', { globs: ['client/**'] }))
      .toBe('client/src/AssetList.tsx');
  });

  it('throws for an existing file outside the surface', () => {
    expect(() => assertWritable(repo, 'server/app/asset.py', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
  });

  // Fixes create files. Gating only existing files would reject every new test
  // file the fix agent writes, so a create resolves through its parent.
  it('allows creating a new file whose parent directory is inside the surface', () => {
    expect(assertWritable(repo, 'client/src/NewPanel.tsx', { globs: ['client/**'] }))
      .toBe('client/src/NewPanel.tsx');
  });

  it('refuses creating a new file whose parent is outside the surface', () => {
    expect(() => assertWritable(repo, 'server/app/new.py', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
  });

  it('refuses a create whose parent directory does not exist', () => {
    expect(() => assertWritable(repo, 'client/nope/deep/New.tsx', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
  });

  it('throws when a symlinked directory inside the surface resolves outside it', async () => {
    await symlink(join(repo, 'server'), join(repo, 'client/vendor'));

    expect(() => assertWritable(repo, 'client/vendor/app/asset.py', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
    // And the create path through the same symlink.
    expect(() => assertWritable(repo, 'client/vendor/app/new.py', { globs: ['client/**'] }))
      .toThrow(FixSurfaceViolation);
  });

  it('throws for a path escaping the repository', () => {
    expect(() => assertWritable(repo, '../../etc/passwd', { globs: null })).toThrow(FixSurfaceViolation);
  });
});
