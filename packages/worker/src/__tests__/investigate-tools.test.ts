import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHostReader } from '../harness/host-reader.js';
import { executeListFiles, executeReadFile, executeSearch, type RepoReader } from '../investigate-tools.js';

function reader(over: Partial<RepoReader> = {}): RepoReader {
  return {
    readFile: async () => '',
    grep: async () => '',
    list: async () => '',
    exists: async () => [],
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
  it('asks grep for fixed-string matching', async () => {
    let seen: string[] = [];
    await executeSearch(reader({ grep: async (a) => { seen = a; return ''; } }), { pattern: 'a.c' });
    expect(seen).toContain('-F');
    expect(seen.indexOf('-F')).toBeLessThan(seen.indexOf('--'));
    expect(seen.at(-2)).toBe('a.c');
  });

  it('rejects a multi-line pattern without searching', async () => {
    let called = false;
    const out = await executeSearch(
      reader({ grep: async () => { called = true; return ''; } }),
      { pattern: 'first\nsecond' },
    );
    expect(out).toBe('Error: "pattern" must be a single line of literal text');
    expect(called).toBe(false);
  });

  it('matches regular-expression characters literally against a real checkout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'literal-search-'));
    try {
      await writeFile(join(dir, 'a.ts'), "const abc = 1;\nconst dot = 'a.c';\nconst first = items[0;\n");
      const repo = createHostReader(dir);
      const dot = await executeSearch(repo, { pattern: 'a.c' });
      expect(dot).toContain(":2:const dot = 'a.c';");
      expect(dot).not.toContain('const abc');
      expect(await executeSearch(repo, { pattern: 'items[0' })).toContain(':3:const first = items[0;');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the no-match string', async () => {
    expect(await executeSearch(reader({ grep: async () => '' }), { pattern: 'x' }))
      .toBe('No matches found. The pattern is matched as literal text, not a regular expression.');
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
