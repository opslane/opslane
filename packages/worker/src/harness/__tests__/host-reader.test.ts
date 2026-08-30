import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostReader } from '../host-reader.js';

describe('createHostReader', () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'host-reader-'));
    await mkdir(join(repo, 'src', 'nested'), { recursive: true });
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), 'const marker = 1;\n');
    await writeFile(join(repo, 'src', 'nested', 'b.ts'), 'const other = 2;\n');
    await writeFile(join(repo, 'node_modules', 'c.ts'), 'const marker = 3;\n');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('reads a file as raw text, without formatting it', async () => {
    expect(await createHostReader(repo).readFile('src/a.ts')).toBe('const marker = 1;\n');
  });

  it('refuses a path outside the repository', async () => {
    await expect(createHostReader(repo).readFile('../../etc/passwd'))
      .rejects.toThrow('path traversal blocked');
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
