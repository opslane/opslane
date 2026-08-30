import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHostReader,
  executeListFiles,
  executeReadFile,
  executeSearch,
  type RepoReader,
} from '../investigate-tools.js';

function reader(over: Partial<RepoReader> = {}): RepoReader {
  return {
    readFile: async () => '',
    grep: async () => '',
    list: async () => '',
    ...over,
  };
}

describe('executeReadFile', () => {
  it('adds line numbers', async () => {
    const out = await executeReadFile(reader({ readFile: async () => 'const x = 1;' }), { path: 'a.ts' });
    expect(out).toBe('   1 | const x = 1;');
  });
  it('requires a path', async () => {
    expect(await executeReadFile(reader(), {})).toBe('Error: "path" parameter is required');
  });
  it('reports a missing file for any not-found shape', async () => {
    const r = reader({ readFile: async () => { throw new Error('cat: a.ts: No such file or directory'); } });
    expect(await executeReadFile(r, { path: 'a.ts' })).toBe('Error: file not found: a.ts');
  });
  it('rethrows a machine-unavailable error instead of stringifying it', async () => {
    const { MachineUnavailableError } = await import('../harness/errors.js');
    const boom = new MachineUnavailableError('machine gone', 'gone');
    const r = reader({ readFile: async () => { throw boom; } });
    await expect(executeReadFile(r, { path: 'a.ts' })).rejects.toBe(boom);
  });
});

describe('executeSearch', () => {
  it('keeps the no-match string', async () => {
    expect(await executeSearch(reader({ grep: async () => '' }), { pattern: 'x' })).toBe('No matches found.');
  });
  it('caps results at 50 and says how many more there were', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `a.ts:${i}:hit`).join('\n');
    const out = await executeSearch(reader({ grep: async () => lines }), { pattern: 'hit' });
    expect(out.split('\n')).toHaveLength(51);
    expect(out).toContain('[10 more results]');
  });
  it('passes default include flags when none is given', async () => {
    let seen: string[] = [];
    await executeSearch(reader({ grep: async (a) => { seen = a; return ''; } }), { pattern: 'x' });
    expect(seen).toContain('--include');
    expect(seen).toContain('*.ts');
    expect(seen.at(-2)).toBe('x');
    expect(seen.at(-1)).toBe('.');
  });
  it('rethrows a machine-unavailable error', async () => {
    const { MachineUnavailableError } = await import('../harness/errors.js');
    const boom = new MachineUnavailableError('gone', 'gone');
    await expect(executeSearch(reader({ grep: async () => { throw boom; } }), { pattern: 'x' })).rejects.toBe(boom);
  });
});

describe('executeListFiles', () => {
  it('returns the raw listing', async () => {
    expect(await executeListFiles(reader({ list: async () => 'a.ts\nb/' }), { path: '.' })).toBe('a.ts\nb/');
  });
  it('rethrows a machine-unavailable error', async () => {
    const { MachineUnavailableError } = await import('../harness/errors.js');
    const boom = new MachineUnavailableError('gone', 'gone');
    await expect(executeListFiles(reader({ list: async () => { throw boom; } }), { path: '.' })).rejects.toBe(boom);
  });
});

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
