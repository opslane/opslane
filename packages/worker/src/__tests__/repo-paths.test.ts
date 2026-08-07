import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWritable,
  assertWritableSandboxPath,
  diffTargets,
  resolveInsideRepo,
  WriteOutsideRepoError
} from '../repo-paths.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'repo-paths-'));
  await mkdir(join(repo, 'client/src'), { recursive: true });
  await mkdir(join(repo, 'server/app'), { recursive: true });
  await writeFile(join(repo, 'client/src/AssetList.tsx'), 'export const x = 1;\n');
  await writeFile(join(repo, 'server/app/asset.py'), 'def get(): pass\n');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/**
 * Repository containment is an authorization boundary: it decides whether the
 * worker may write to a path in a customer's clone. A lexical check is
 * bypassable, so these drive the real filesystem rather than a stub.
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

  it('resolves a symlink to its real path rather than the cited string', async () => {
    await symlink(join(repo, 'server'), join(repo, 'client/vendor'));

    expect(resolveInsideRepo(repo, 'client/vendor/app/asset.py')).toBe('server/app/asset.py');
  });

  it('refuses a symlink that points outside the repository entirely', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await writeFile(join(outside, 'secret.ts'), 'export const secret = 1;\n');
    await symlink(join(outside, 'secret.ts'), join(repo, 'client/src/secret.ts'));

    expect(resolveInsideRepo(repo, 'client/src/secret.ts')).toBeNull();

    await rm(outside, { recursive: true, force: true });
  });
});

describe('diffTargets covers git extended headers', () => {
  // A patch pairing one authorized file with a rename section moved a second,
  // never-gated file: GNU patch honours `rename to`, this parser did not read it.
  it('reports a rename target that appears in no hunk header', () => {
    const diff = [
      '--- a/ok.ts',
      '+++ b/ok.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/x b/hooks_evil',
      'rename from x',
      'rename to hooks_evil',
    ].join('\n');

    expect(diffTargets(diff)).toEqual(expect.arrayContaining(['ok.ts', 'hooks_evil']));
  });

  it('reports a copy target', () => {
    const diff = ['diff --git a/x b/y', 'copy from x', 'copy to y'].join('\n');
    expect(diffTargets(diff)).toEqual(expect.arrayContaining(['y']));
  });

  it('refuses a mode change it cannot place', () => {
    expect(diffTargets(['--- a/ok.ts', '+++ b/ok.ts', 'old mode 100644', 'new mode 100755'].join('\n')))
      .toEqual([]);
  });
});

describe('assertWritable refuses an occupied name it could not resolve', () => {
  // Verified escape before this guard: resolveInsideRepo rejected the symlink
  // (its target is outside the repo), assertWritable then re-authorised the
  // same name as a *create* through its parent, and a write through the
  // returned path landed on the link's target outside the clone.
  it('refuses a final-component symlink pointing outside the repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await writeFile(join(outside, 'secret.txt'), 'ORIGINAL\n');
    await symlink(join(outside, 'secret.txt'), join(repo, 'escape'));

    expect(() => assertWritable(repo, 'escape')).toThrow(WriteOutsideRepoError);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('ORIGINAL\n');

    await rm(outside, { recursive: true, force: true });
  });

  it('refuses a name occupied by a directory', () => {
    expect(() => assertWritable(repo, 'client/src')).toThrow(WriteOutsideRepoError);
  });

  it.each(['client/src/.', 'client/src/..', 'client/src/'])(
    'refuses the degenerate basename %j',
    (cited) => {
      expect(() => assertWritable(repo, cited)).toThrow(WriteOutsideRepoError);
    },
  );
});

describe('assertWritable', () => {
  it('returns the resolved path for an existing file in the clone', () => {
    expect(assertWritable(repo, 'client/src/AssetList.tsx')).toBe('client/src/AssetList.tsx');
  });

  // Fixes create files. Gating only existing files would reject every new test
  // file the fix agent writes, so a create resolves through its parent.
  it('allows creating a new file whose parent directory is in the clone', () => {
    expect(assertWritable(repo, 'client/src/NewPanel.tsx')).toBe('client/src/NewPanel.tsx');
  });

  it('refuses a create whose parent directory does not exist', () => {
    expect(() => assertWritable(repo, 'client/nope/deep/New.tsx')).toThrow(WriteOutsideRepoError);
  });

  it('refuses a path escaping the repository', () => {
    expect(() => assertWritable(repo, '../../etc/passwd')).toThrow(WriteOutsideRepoError);
  });

  it('refuses a create through a symlink that leaves the repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await symlink(outside, join(repo, 'client/escape'));

    expect(() => assertWritable(repo, 'client/escape/new.ts')).toThrow(WriteOutsideRepoError);

    await rm(outside, { recursive: true, force: true });
  });
});

/**
 * These targets are fed straight into the write gate, and the patch they came
 * from is applied with `patch -p1`. So the contract under test is not "what do
 * the headers say" but "what will patch actually write" — the two diverged, and
 * the divergence authorised a write outside the clone.
 */
describe('diffTargets', () => {
  const header = (minus: string, plus: string) =>
    `diff --git ${minus} ${plus}\n--- ${minus}\n+++ ${plus}\n@@ -1 +1 @@\n-a\n+b\n`;

  it('strips the one component patch -p1 strips', () => {
    expect(diffTargets(header('a/src/foo.ts', 'b/src/foo.ts'))).toEqual(['src/foo.ts']);
  });

  it('collects every file a multi-file patch touches', () => {
    const diff = header('a/src/foo.ts', 'b/src/foo.ts') + header('a/src/bar.ts', 'b/src/bar.ts');
    expect(diffTargets(diff).sort()).toEqual(['src/bar.ts', 'src/foo.ts']);
  });

  it('reads the added side of a creation, ignoring /dev/null', () => {
    expect(diffTargets(header('/dev/null', 'b/src/new.ts'))).toEqual(['src/new.ts']);
  });

  it('refuses the whole patch when a header carries no a/ or b/ prefix', () => {
    // The bypass: gated as `src/foo.ts` while `patch -p1` strips `src/` and
    // writes `foo.ts` at the repository root.
    expect(diffTargets(header('src/foo.ts', 'src/foo.ts'))).toEqual([]);
  });

  it('refuses a patch that mixes a prefixed header with an unprefixed one', () => {
    const diff = header('a/src/foo.ts', 'b/src/foo.ts') + header('src/bar.ts', 'src/bar.ts');
    expect(diffTargets(diff)).toEqual([]);
  });

  it('refuses a bare prefix with nothing after it', () => {
    expect(diffTargets(header('a/', 'b/'))).toEqual([]);
  });

  it('returns nothing for a diff with no headers at all', () => {
    expect(diffTargets('not a diff\njust prose\n')).toEqual([]);
    expect(diffTargets('')).toEqual([]);
  });

  // Hunk bodies are content, not headers. Both of these were reproduced against
  // the parser: a removed SQL comment refused the whole patch, and a removed
  // header-shaped line added a file the patch never touches to the authorized set.
  it('does not read a removed comment line as a malformed header', () => {
    const diff = [
      'diff --git a/db/seed.sql b/db/seed.sql',
      '--- a/db/seed.sql',
      '+++ b/db/seed.sql',
      '@@ -1,2 +1,2 @@',
      ' CREATE TABLE t();',
      '--- seed data',          // the SQL comment `-- seed data`, removed
      '+INSERT INTO t VALUES (1);',
    ].join('\n');
    expect(diffTargets(diff)).toEqual(['db/seed.sql']);
  });

  it('does not authorize a file named only by a removed line inside a hunk', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' const x = 1;',
      '--- a/other.ts',
      '+const y = 2;',
    ].join('\n');
    expect(diffTargets(diff)).toEqual(['a.ts']);
  });

  it('reads the file after a hunk, so a body cannot swallow the next header', () => {
    const diff = [
      '--- a/first.ts',
      '+++ b/first.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/second.ts',
      '+++ b/second.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(diffTargets(diff).sort()).toEqual(['first.ts', 'second.ts']);
  });

  it('counts the shorthand @@ -1 +1 @@ form as one line per side', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '---', '+ok'].join('\n');
    expect(diffTargets(diff)).toEqual(['x.ts']);
  });

  it('refuses a hunk that promises more lines than it delivers', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,5 +1,5 @@', ' one'].join('\n');
    expect(diffTargets(diff)).toEqual([]);
  });

  it('accepts a git creation patch, whose new file mode is covered by /dev/null', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+export const x = 1;',
    ].join('\n');
    expect(diffTargets(diff)).toEqual(['src/new.ts']);
  });

  it('leaves traversal for the write gate to refuse, having stripped the prefix', () => {
    // diffTargets only places the path; assertWritableSandboxPath is what
    // refuses it. Checked together so neither can quietly stop doing its half.
    const targets = diffTargets(header('a/../../etc/passwd', 'b/../../etc/passwd'));
    expect(targets).toEqual(['../../etc/passwd']);
    for (const target of targets) {
      expect(() => assertWritableSandboxPath('/home/user/repo', target)).toThrow(WriteOutsideRepoError);
    }
  });
});

describe('assertWritableSandboxPath', () => {
  it('places a relative path under the sandbox repository root', () => {
    expect(assertWritableSandboxPath('/home/user/repo', 'src/App.tsx')).toBe('/home/user/repo/src/App.tsx');
  });

  it('accepts an absolute path already inside the root', () => {
    expect(assertWritableSandboxPath('/home/user/repo', '/home/user/repo/src/App.tsx'))
      .toBe('/home/user/repo/src/App.tsx');
  });

  it('refuses traversal out of the root', () => {
    expect(() => assertWritableSandboxPath('/home/user/repo', '../../etc/passwd'))
      .toThrow(WriteOutsideRepoError);
  });

  it('refuses an absolute path outside the root', () => {
    expect(() => assertWritableSandboxPath('/home/user/repo', '/etc/passwd')).toThrow(WriteOutsideRepoError);
  });

  // The guard that stops a degenerate root from authorizing the whole
  // filesystem: '/' normalises to '', and then every absolute path passes the
  // prefix test. Untested, this could be deleted and the suite stayed green.
  it.each(['/', '', '   ', 'repo', './repo', 'C:/repo'])(
    'refuses a repository root of %j rather than authorizing everything',
    (root) => {
      expect(() => assertWritableSandboxPath(root, '/etc/passwd')).toThrow(WriteOutsideRepoError);
      expect(() => assertWritableSandboxPath(root, 'src/App.tsx')).toThrow(WriteOutsideRepoError);
    },
  );

  it('refuses the root itself and an empty citation', () => {
    expect(() => assertWritableSandboxPath('/home/user/repo', '/home/user/repo')).toThrow(WriteOutsideRepoError);
    expect(() => assertWritableSandboxPath('/home/user/repo', '   ')).toThrow(WriteOutsideRepoError);
  });
});
