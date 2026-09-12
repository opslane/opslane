// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSourcemapsCli, parseArgs, type CliOptions } from '../index';
import { makeSourceMapKey } from './helpers';

const KEY = makeSourceMapKey('https://app.example.test');
const MAP = (file: string, src: string) => JSON.stringify({ version: 3, file, sources: [src], names: [], mappings: 'AAAA' });

// Layout: <project>/src/{a,b}.ts and <project>/dist/chunks/{a,b}/main.js(.map).
// The maps reference sources as ../../../src/x.ts relative to their own
// directory, which is what bundlers emit; normalizeSources makes them
// project-root-relative ("src/a.ts").
let project: string;
let dir: string;
let outside: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'opslane-proj-'));
  dir = join(project, 'dist');
  outside = await mkdtemp(join(tmpdir(), 'opslane-outside-'));
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(project, 'src', 'b.ts'), 'export const b = 2;\n');
  await mkdir(join(dir, 'chunks', 'a'), { recursive: true });
  await mkdir(join(dir, 'chunks', 'b'), { recursive: true });
  await mkdir(join(dir, 'maps'), { recursive: true });
  await writeFile(join(dir, 'chunks', 'a', 'main.js'), 'console.log(1);\n//# sourceMappingURL=main.js.map\n');
  await writeFile(join(dir, 'chunks', 'a', 'main.js.map'), MAP('main.js', '../../../src/a.ts'));
  await writeFile(join(dir, 'chunks', 'b', 'main.js'), 'console.log(2);\n//# sourceMappingURL=../../maps/b.js.map\n'); // parent traversal that stays inside dist
  await writeFile(join(dir, 'maps', 'b.js.map'), MAP('main.js', '../../src/b.ts'));
  await writeFile(join(dir, 'chunks', 'nomap.js'), 'console.log(3);\n');
  await writeFile(join(outside, 'evil.map'), MAP('evil.js', 'x'));
  await writeFile(join(dir, 'chunks', 'escape.js'), `console.log(4);\n//# sourceMappingURL=${join(outside, 'evil.map')}\n`);
  await symlink(join(outside, 'evil.map'), join(dir, 'chunks', 'link.js.map'));
  await writeFile(join(dir, 'chunks', 'link.js'), 'console.log(5);\n//# sourceMappingURL=link.js.map\n');
});
afterEach(async () => { await rm(project, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
const run = (extra: Partial<CliOptions>) => runSourcemapsCli({ dir, key: KEY, format: 'iife', keepMaps: false, dryRun: false, requireKey: false, projectRoot: project, logger: () => undefined, ...extra });

function recorder(status: (fileName: string) => number) {
  const puts: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const id = url.slice(url.lastIndexOf('/') + 1);
    const hasKey = (init?.headers as Record<string, string>)['X-API-Key'] === KEY;
    puts.push(`${init?.method} ${url} key=${hasKey}`);
    const body = String(init?.body ?? '');
    const which = body.includes('a.ts') ? 'chunks/a/main.js.map' : body.includes('b.ts') ? 'maps/b.js.map' : id;
    return new Response(status(which) === 201 ? '{"status":"created"}' : 'nope', { status: status(which) });
  }) as typeof fetch;
  return { puts, fetchImpl };
}

describe('opslane-sourcemaps', () => {
  it('stamps nested chunks, follows in-tree parent traversal, uploads with relative names, strips directives, never logs the key, and refuses escapes', async () => {
    const { puts, fetchImpl } = recorder(() => 201);
    const lines: string[] = [];
    const summary = await run({ logger: (l) => lines.push(l), fetchImpl });
    expect(summary).toMatchObject({ stamped: 2, uploaded: 2, removed: 2, skipped: 1 });
    expect(summary.failed.map((f) => f.fileName).sort()).toEqual([expect.stringContaining('evil.map'), 'chunks/link.js.map']);
    expect(summary.failed.every((f) => /outside/.test(f.reason))).toBe(true);
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatch(/^PUT https:\/\/app\.example\.test\/api\/v1\/sourcemaps\/[0-9a-f-]{36} key=true$/);
    for (const p of ['a', 'b']) {
      const js = await readFile(join(dir, 'chunks', p, 'main.js'), 'utf8');
      expect(js).toMatch(/\/\/# debugId=[0-9a-f-]{36}$/);
      expect(js).not.toContain('sourceMappingURL');
    }
    expect(await readdir(join(dir, 'chunks', 'a'))).not.toContain('main.js.map');
    expect(await readdir(join(dir, 'maps'))).not.toContain('b.js.map');
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).toContain('chunks/a/main.js');
  });

  it('keeps the map on a failed upload and finishes the job on the next run without re-stamping', async () => {
    const first = recorder((f) => (f === 'maps/b.js.map' ? 500 : 201));
    const s1 = await run({ fetchImpl: first.fetchImpl });
    expect(s1.failed.map((f) => f.fileName)).toContain('maps/b.js.map');
    expect(await readdir(join(dir, 'maps'))).toContain('b.js.map');
    expect(await readdir(join(dir, 'chunks', 'a'))).not.toContain('main.js.map');
    const stampedB = await readFile(join(dir, 'chunks', 'b', 'main.js'), 'utf8');
    const second = recorder(() => 201);
    const s2 = await run({ fetchImpl: second.fetchImpl });
    expect(s2.stamped).toBe(0);
    expect(s2.uploaded).toBe(1);
    expect(s2.failed.map((f) => f.fileName).sort()).toEqual([expect.stringContaining('evil.map'), 'chunks/link.js.map']);
    expect(await readdir(join(dir, 'maps'))).not.toContain('b.js.map');
    const afterB = await readFile(join(dir, 'chunks', 'b', 'main.js'), 'utf8');
    expect(afterB.match(/__OPSLANE_DEBUG_IDS__/g)?.length).toBe(stampedB.match(/__OPSLANE_DEBUG_IDS__/g)?.length); // one prelude, not two
  });

  it('refuses a stale stamp (trailer and map disagree) without touching the files', async () => {
    const { fetchImpl } = recorder(() => 201);
    await run({ keepMaps: true, fetchImpl });
    const mapPath = join(dir, 'maps', 'b.js.map');
    const tampered = { ...JSON.parse(await readFile(mapPath, 'utf8')), names: ['x'] };
    await writeFile(mapPath, JSON.stringify(tampered));
    const before = await readFile(join(dir, 'chunks', 'b', 'main.js'), 'utf8');
    const s = await run({ keepMaps: true, fetchImpl });
    expect(s.failed.find((f) => f.fileName === 'maps/b.js.map')?.reason).toContain('stale');
    expect(await readFile(join(dir, 'chunks', 'b', 'main.js'), 'utf8')).toBe(before);
  });

  it('--keep-maps keeps the map file but still strips the directive after a successful upload', async () => {
    const { fetchImpl } = recorder(() => 201);
    await run({ keepMaps: true, fetchImpl });
    expect(await readdir(join(dir, 'chunks', 'a'))).toContain('main.js.map');
    expect(await readFile(join(dir, 'chunks', 'a', 'main.js'), 'utf8')).not.toContain('sourceMappingURL');
  });

  it('records a per-file failure for an invalid map and still processes the others', async () => {
    await writeFile(join(dir, 'chunks', 'a', 'main.js.map'), JSON.stringify({ version: 3, sources: ['x'], names: [], mappings: 'not-vlq-!!!' }));
    const { fetchImpl } = recorder(() => 201);
    const s = await run({ fetchImpl });
    expect(s.failed.some((f) => f.fileName === 'chunks/a/main.js.map')).toBe(true);
    expect(s.uploaded).toBe(1);
  });

  it('normalizes nested source paths to the project root', async () => {
    const { fetchImpl } = recorder(() => 201);
    const uploaded: string[] = [];
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => { uploaded.push(String(init?.body ?? '')); return fetchImpl(input, init); }) as typeof fetch;
    await run({ keepMaps: true, fetchImpl: spy });
    const all = uploaded.map((b) => (JSON.parse(b).sources as string[])[0]).sort();
    expect(all).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('parseArgs: missing key skips with exit 0 unless --require-key; bad format is a usage error', () => {
    expect(parseArgs(['.next/static'], {})).toMatchObject({ skip: expect.stringContaining('OPSLANE_SOURCEMAP_KEY') });
    expect(parseArgs(['.next/static', '--require-key'], {})).toMatchObject({ error: expect.stringContaining('OPSLANE_SOURCEMAP_KEY') });
    expect(parseArgs(['.next/static', '--format', 'nonsense'], { OPSLANE_SOURCEMAP_KEY: KEY })).toMatchObject({ error: expect.stringContaining('--format') });
    const ok = parseArgs(['.next/static', '--format', 'es', '--keep-maps', '--dry-run', '--project-root', '/p'], { OPSLANE_SOURCEMAP_KEY: KEY });
    expect(ok).toMatchObject({ dir: '.next/static', format: 'es', keepMaps: true, dryRun: true, projectRoot: '/p' });
    expect(parseArgs([], { OPSLANE_SOURCEMAP_KEY: KEY })).toMatchObject({ error: expect.stringContaining('usage') });
  });
});

describe('post-build safety and formats', () => {
  it('dry-run performs no writes or uploads', async () => {
    const beforeJs = await readFile(join(dir, 'chunks/a/main.js'));
    const beforeMap = await readFile(join(dir, 'maps/b.js.map'));
    const { puts, fetchImpl } = recorder(() => 201);
    const summary = await run({ dryRun: true, fetchImpl });
    expect(summary).toMatchObject({ stamped: 2, uploaded: 0, removed: 0 });
    expect(puts).toHaveLength(0);
    expect(await readFile(join(dir, 'chunks/a/main.js'))).toEqual(beforeJs);
    expect(await readFile(join(dir, 'maps/b.js.map'))).toEqual(beforeMap);
  });

  it('skips with no key before inspecting or modifying the build directory', async () => {
    const lines: string[] = [];
    expect(await run({ key: '', dir: '/nonexistent/build', logger: line => lines.push(line) })).toMatchObject({ stamped: 0, uploaded: 0, failed: [] });
    expect(lines).toEqual(['opslane-sourcemaps: OPSLANE_SOURCEMAP_KEY not set, skipping (maps left untouched)']);
  });

  it('flattens indexed maps for mjs and cjs chunks and preserves resolved frames', async () => {
    const { TraceMap, originalPositionFor } = await import('@jridgewell/trace-mapping');
    for (const ext of ['mjs', 'cjs']) {
      await writeFile(join(dir, `module.${ext}`), 'a();\nb();');
      await writeFile(join(dir, `module.${ext}.map`), JSON.stringify({ version: 3, sections: [
        { offset: { line: 0, column: 0 }, map: JSON.parse(MAP(`module.${ext}`, '../src/a.ts')) },
        { offset: { line: 1, column: 0 }, map: JSON.parse(MAP(`module.${ext}`, '../src/b.ts')) },
      ] }));
    }
    const { fetchImpl } = recorder(() => 200);
    const result = await run({ format: 'es', keepMaps: true, fetchImpl });
    expect(result.uploaded).toBe(4);
    const code = await readFile(join(dir, 'module.mjs'), 'utf8');
    expect(code).toContain('import.meta.url');
    expect(code).not.toContain('sourceMappingURL');
    const map = JSON.parse(await readFile(join(dir, 'module.mjs.map'), 'utf8'));
    expect(map.sections).toBeUndefined();
    expect(originalPositionFor(new TraceMap(map), { line: 3, column: 0 })).toMatchObject({ source: 'src/b.ts', line: 1 });
  });

  it.each([
    ['invalid JSON', '{'],
    ['duplicate JSON keys', '{"version":3,"sources":[],"names":[],"mappings":"","mappings":"AAAA"}'],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe])],
    ['oversized map', ' '.repeat((32 << 20) + 1)],
  ])('records %s under the map name and leaves the pair untouched', async (_label, bytes) => {
    const mapPath = join(dir, 'chunks/a/main.js.map');
    await writeFile(mapPath, bytes);
    const before = await readFile(join(dir, 'chunks/a/main.js'));
    const { fetchImpl } = recorder(() => 201);
    const result = await run({ fetchImpl });
    expect(result.uploaded).toBe(1);
    expect(result.failed.find(failure => failure.fileName === 'chunks/a/main.js.map')).toBeDefined();
    expect(await readFile(join(dir, 'chunks/a/main.js'))).toEqual(before);
    expect((await readFile(mapPath)).equals(Buffer.from(bytes))).toBe(true);
  });

  it.each(['https://evil.test/maps.js.map', '../../../outside.map', 'data:application/json;base64,e30='])('refuses map target %s', async target => {
    const path = join(dir, 'chunks/a/main.js');
    const code = `a();\n//# sourceMappingURL=${target}\n`;
    await writeFile(path, code);
    const { fetchImpl } = recorder(() => 201);
    const result = await run({ fetchImpl });
    expect(result.uploaded).toBe(1);
    expect(result.failed).toHaveLength(3);
    expect(await readFile(path, 'utf8')).toBe(code);
  });

  it('validates both the trailer and retained map debugId on repeated runs', async () => {
    const { fetchImpl } = recorder(() => 201);
    await run({ keepMaps: true, fetchImpl });
    const path = join(dir, 'chunks/a/main.js.map');
    const tampered = { ...JSON.parse(await readFile(path, 'utf8')), debugId: '00000000-0000-0000-0000-000000000000' };
    await writeFile(path, JSON.stringify(tampered));
    const result = await run({ keepMaps: true, fetchImpl });
    expect(result.failed.find(failure => failure.fileName === 'chunks/a/main.js.map')?.reason).toContain('stale stamp');
  });
});

describe('inline source-map directives', () => {
  it.each([false, true])('uses the inline non-sibling map with an unrelated sibling present: %s', async (hasSibling) => {
    const path = join(dir, 'chunks/b/main.js');
    await writeFile(path, 'console.log(2); //# sourceMappingURL=../../maps/b.js.map\n');
    const unrelatedMap = join(dir, 'chunks/b/main.js.map');
    if (hasSibling) await writeFile(unrelatedMap, 'unrelated invalid map');
    const { fetchImpl } = recorder(() => 201);
    const result = await run({ fetchImpl });
    expect(result).toMatchObject({ stamped: 2, uploaded: 2, removed: 2 });
    const output = await readFile(path, 'utf8');
    expect(output).toContain('console.log(2);');
    expect(output).not.toContain('sourceMappingURL');
    expect(output).toMatch(/\/\/# debugId=[0-9a-f-]{36}$/);
    if (hasSibling) expect(await readFile(unrelatedMap, 'utf8')).toBe('unrelated invalid map');
  });

  it('preserves lookalikes while selecting and stripping the actual inline comment', async () => {
    const path = join(dir, 'chunks/b/main.js');
    const lookalikes = [
      'const a = "//# sourceMappingURL=string.map";',
      'const b = `template',
      '//# sourceMappingURL=template.map',
      '`;',
      String.raw`const c = /\/\/# sourceMappingURL=regex.map/;`,
    ].join('\n');
    await writeFile(path, `${lookalikes}\nconsole.log(2); /*# sourceMappingURL=../../maps/b.js.map */`);
    const { fetchImpl } = recorder(() => 201);
    expect(await run({ fetchImpl })).toMatchObject({ stamped: 2, uploaded: 2, removed: 2 });
    const output = await readFile(path, 'utf8');
    expect(output).toContain(lookalikes);
    expect(output).not.toContain('sourceMappingURL=../../maps/b.js.map');
  });
});

describe('output syntax compatibility', () => {
  it('stamps and strips sloppy IIFE and CJS output containing octal literals and escapes', async () => {
    const path = join(dir, 'chunks/b/main.js');
    const source = String.raw`var n = 010; var s = "\141";`;
    const { fetchImpl } = recorder(() => 201);
    for (const format of ['iife', 'cjs']) {
      await writeFile(path, `${source} //# sourceMappingURL=../../maps/b.js.map\n`);
      await writeFile(join(dir, 'maps/b.js.map'), MAP('main.js', '../../src/b.ts'));
      const result = await run({ format, fetchImpl });
      expect(result.failed.find(failure => failure.fileName === 'maps/b.js.map')).toBeUndefined();
      const output = await readFile(path, 'utf8');
      expect(output).toContain(source);
      expect(output).not.toContain('sourceMappingURL');
      expect(output).toMatch(/\/\/# debugId=[0-9a-f-]{36}$/);
    }
  });

  it('continues to tokenize ESM imports, exports, dynamic import, and import.meta', async () => {
    const path = join(dir, 'chunks/b/main.js');
    const source = 'import { x } from "./x.js"; export const url = import.meta.url; export const lazy = () => import("./lazy.js");';
    await writeFile(path, `${source} //# sourceMappingURL=../../maps/b.js.map\n`);
    const { fetchImpl } = recorder(() => 201);
    expect(await run({ format: 'es', fetchImpl })).toMatchObject({ stamped: 2, uploaded: 2, removed: 2 });
    const output = await readFile(path, 'utf8');
    expect(output).toContain(source);
    expect(output).not.toContain('sourceMappingURL');
    expect(output).toMatch(/\/\/# debugId=[0-9a-f-]{36}$/);
  });
});
