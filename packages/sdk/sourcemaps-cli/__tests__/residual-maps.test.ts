// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSourcemapsCli, type CliOptions } from '../index';
import { main } from '../main';
import { makeSourceMapKey } from './helpers';

const remove = vi.hoisted(() => ({ failPath: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === remove.failPath) throw new Error('EACCES: permission denied');
      return actual.rm(...args);
    },
  };
});

const KEY = makeSourceMapKey('https://app.example.test');
const MAP = JSON.stringify({ version: 3, sources: ['app.ts'], sourcesContent: ['source code'], names: [], mappings: 'AAAA' });
let root: string;
let dir: string;
let options: CliOptions;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opslane-residual-'));
  dir = join(root, 'dist');
  await mkdir(join(dir, 'chunks'), { recursive: true });
  await writeFile(join(dir, 'chunks/app.js'), 'run(); //# sourceMappingURL=app.js.map');
  await writeFile(join(dir, 'chunks/app.js.map'), MAP);
  // Turbopack emits maps whose hashes differ from the final polyfill/CSS filenames.
  await writeFile(join(dir, 'chunks/final-polyfill.js'), 'var polyfill = true;');
  await writeFile(join(dir, 'chunks/final.css'), 'body {} /*# sourceMappingURL=old-hash.css.map */');
  for (const ext of ['js', 'mjs', 'cjs', 'css']) {
    await writeFile(join(dir, `chunks/old-hash.${ext}.map`), MAP);
  }
  await writeFile(join(dir, 'chunks/game.map'), 'application map asset');
  await writeFile(join(dir, 'chunks/types.d.ts.map'), MAP);
  options = { dir, key: KEY, format: 'iife', keepMaps: false, dryRun: false, requireKey: false, projectRoot: root, logger: () => undefined, fetchImpl: async () => new Response('{}', { status: 201 }) };
});

afterEach(async () => {
  remove.failPath = '';
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function expectResidualMapsPresent(): Promise<void> {
  const files = await readdir(join(dir, 'chunks'));
  for (const ext of ['js', 'mjs', 'cjs', 'css']) expect(files).toContain(`old-hash.${ext}.map`);
}

describe('residual build maps', () => {
  it('removes unpaired Next.js polyfill and CSS maps after success without touching other assets', async () => {
    const lines: string[] = [];
    const summary = await runSourcemapsCli({ ...options, logger: line => lines.push(line) });
    expect(summary).toMatchObject({ uploaded: 1, removed: 5, failed: [] });
    const files = await readdir(join(dir, 'chunks'));
    expect(files.filter(file => /\.(?:[mc]?js|css)\.map$/.test(file))).toEqual([]);
    expect(files).toContain('game.map');
    expect(files).toContain('types.d.ts.map');
    expect(await readFile(join(dir, 'chunks/final-polyfill.js'), 'utf8')).toBe('var polyfill = true;');
    expect(await readFile(join(dir, 'chunks/final.css'), 'utf8')).toBe('body {} /*# sourceMappingURL=old-hash.css.map */');
    expect(lines).toContain('removed residual map chunks/old-hash.css.map');
  });

  it.each([{ dryRun: true }, { keepMaps: true }])('preserves every residual map with %j', async overrides => {
    const summary = await runSourcemapsCli({ ...options, ...overrides });
    expect(summary.removed).toBe(0);
    await expectResidualMapsPresent();
  });

  it('preserves residual maps and the failed upload, then cleans them on a successful retry', async () => {
    const first = await runSourcemapsCli({ ...options, fetchImpl: async () => new Response('failed', { status: 500 }) });
    expect(first).toMatchObject({ uploaded: 0, removed: 0, failed: [{ fileName: 'chunks/app.js.map', reason: 'HTTP 500' }] });
    await expectResidualMapsPresent();
    expect(await readFile(join(dir, 'chunks/app.js'), 'utf8')).toContain('sourceMappingURL');
    expect(await runSourcemapsCli(options)).toMatchObject({ stamped: 0, uploaded: 1, removed: 5, failed: [] });
  });

  it('preserves residual maps after any artifact validation failure', async () => {
    await writeFile(join(dir, 'chunks/app.js.map'), '{');
    const result = await runSourcemapsCli(options);
    expect(result.failed).toHaveLength(1);
    expect(result.removed).toBe(0);
    await expectResidualMapsPresent();
  });

  it('reports a residual cleanup failure through main as exit 1', async () => {
    remove.failPath = join(dir, 'chunks/old-hash.css.map');
    vi.stubEnv('OPSLANE_SOURCEMAP_KEY', KEY);
    vi.stubGlobal('fetch', options.fetchImpl);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main([dir])).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('chunks/old-hash.css.map: residual map cleanup failed: EACCES');
    expect(await readFile(remove.failPath, 'utf8')).toBe(MAP);
  });

  it('resolves a symlink root but never follows symlinked directories or map files', async () => {
    const external = join(root, 'outside');
    await mkdir(external);
    await writeFile(join(external, 'private.js.map'), MAP);
    await symlink(external, join(dir, 'external-directory'));
    await symlink(join(external, 'private.js.map'), join(dir, 'external.js.map'));
    const rootLink = join(root, 'build-link');
    await symlink(dir, rootLink);
    expect(await runSourcemapsCli({ ...options, dir: rootLink })).toMatchObject({ removed: 5, failed: [] });
    expect(await readFile(join(external, 'private.js.map'), 'utf8')).toBe(MAP);
    expect(await readFile(join(dir, 'external.js.map'), 'utf8')).toBe(MAP);
  });

  it('refuses a residual map replaced with an external symlink during upload', async () => {
    const outside = join(root, 'outside.js.map');
    await writeFile(outside, MAP);
    const swapped = join(dir, 'chunks/old-hash.js.map');
    const result = await runSourcemapsCli({ ...options, fetchImpl: async () => {
      await rm(swapped);
      await symlink(outside, swapped);
      return new Response('{}', { status: 201 });
    } });
    expect(result.failed.find(failure => failure.fileName === 'chunks/old-hash.js.map')?.reason).toMatch(/regular file|outside/);
    expect(await readFile(outside, 'utf8')).toBe(MAP);
  });
});
