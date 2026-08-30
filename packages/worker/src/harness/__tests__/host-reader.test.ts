import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostReader } from '../host-reader.js';

describe('createHostReader', () => {
  let repo: string;
  let outside: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'host-reader-'));
    outside = await mkdtemp(join(tmpdir(), 'host-reader-outside-'));
    await mkdir(join(repo, 'src', 'nested'), { recursive: true });
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), 'const marker = 1;\n');
    await writeFile(join(repo, 'src', 'nested', 'b.ts'), 'const other = 2;\n');
    await writeFile(join(repo, 'node_modules', 'c.ts'), 'const marker = 3;\n');

    // A checkout is untrusted input: the repository being investigated can
    // contain links its author chose. These two point out of the checkout.
    await writeFile(join(outside, 'secret.txt'), 'HOST SECRET\n');
    await symlink(join(outside, 'secret.txt'), join(repo, 'escape.ts'));
    await symlink(outside, join(repo, 'escape-dir'));
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reads a file as raw text, without formatting it', async () => {
    expect(await createHostReader(repo).readFile('src/a.ts')).toBe('const marker = 1;\n');
  });

  it('refuses a path outside the repository', async () => {
    await expect(createHostReader(repo).readFile('../../etc/passwd'))
      .rejects.toThrow('path traversal blocked');
  });

  it('refuses a symlink inside the repository that points outside it', async () => {
    // A lexical resolve+startsWith check passes this: the requested path is
    // literally under the repository root. The read then follows the link off
    // the checkout and returns host bytes.
    await expect(createHostReader(repo).readFile('escape.ts'))
      .rejects.toThrow('path traversal blocked');
  });

  it('does not report an escaping symlink as an existing repository file', async () => {
    expect(await createHostReader(repo).exists(['src/a.ts', 'escape.ts'])).toEqual(['src/a.ts']);
  });

  it('refuses to list through a symlinked directory that points outside', async () => {
    await expect(createHostReader(repo).list('escape-dir', false))
      .rejects.toThrow('path traversal blocked');
  });

  it('still reports a missing path as not found, not as a traversal block', async () => {
    // `executeReadFile` keys "file not found" off ENOENT. The model guesses
    // paths constantly, so a wrong guess must not come back as a security
    // refusal — that reads as a blocked repository rather than a typo.
    await expect(createHostReader(repo).readFile('src/nope.ts')).rejects.toThrow('ENOENT');
  });

  it('accepts a child path when the repository root carries a trailing separator', async () => {
    // Regression: `resolve` strips the trailing separator, so comparing against
    // an unnormalised root compared against `repo//` and rejected every child.
    expect(await createHostReader(`${repo}/`).readFile('src/a.ts')).toBe('const marker = 1;\n');
  });

  it('returns raw grep stdout, and an empty string when nothing matches', async () => {
    const hostReader = createHostReader(repo);
    const hit = await hostReader.grep(['-r', '-n', '--include', '*.ts', '--exclude-dir=node_modules', '--', 'marker', '.']);
    expect(hit).toContain('./src/a.ts:1:const marker = 1;');
    expect(hit).not.toContain('node_modules');
    expect(await hostReader.grep(['-r', '-n', '--', 'nothing-matches-this', '.'])).toBe('');
  });

  it('lists one directory level and excludes vendored directories', async () => {
    const out = await createHostReader(repo).list('src', false);
    expect(out.split('\n')).toEqual(['src/a.ts', 'src/nested/']);
    expect(await createHostReader(repo).list('.', false)).not.toContain('node_modules');
  });

  it('descends one level when asked recursively', async () => {
    expect(await createHostReader(repo).list('src', true)).toContain('src/nested/b.ts');
  });
});
