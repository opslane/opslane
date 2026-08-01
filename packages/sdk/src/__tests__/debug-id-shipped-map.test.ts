// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TraceMap,
  originalPositionFor,
  decodedMappings,
} from '@jridgewell/trace-mapping';
import { computeDebugId } from '../build/debug-id.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../../../../test-fixtures/vue-app');
let assets: string;

describe('every shipped chunk recomputes to its embedded debug ID', () => {
  beforeAll(async () => {
    const { build } = await import('vite');
    const vue = (await import('@vitejs/plugin-vue')).default;
    const { opslaneVitePlugin } = await import('../../vite-plugin/index.js');
    const out = mkdtempSync(join(tmpdir(), 'shipped-map-'));
    await build({
      root: FIXTURE,
      configFile: false,
      logLevel: 'error',
      // Exercise the worker pass too: it is one of the paths that drops the write.
      worker: { format: 'es', plugins: () => [opslaneVitePlugin({ sourcemaps: 'keep' })] },
      plugins: [vue(), opslaneVitePlugin({ sourcemaps: 'keep' })],
      build: { outDir: out, emptyOutDir: true, sourcemap: 'hidden' },
    });
    assets = join(out, 'assets');
  }, 120_000);

  it('ships a map whose fingerprint equals the ID stamped in the JS', async () => {
    const chunks = readdirSync(assets).filter((f) => f.endsWith('.js'));
    expect(chunks.length).toBeGreaterThan(1);

    const failures: string[] = [];
    let checked = 0;

    for (const name of chunks) {
      const code = readFileSync(join(assets, name), 'utf8');
      const embedded = /\/\/# debugId=([0-9a-f-]{36})/.exec(code)?.[1];
      let mapBytes: Buffer;
      try {
        mapBytes = readFileSync(join(assets, `${name}.map`));
      } catch {
        continue; // no sibling map: nothing to verify for this chunk
      }
      if (!embedded) {
        failures.push(`${name}: has a map but no //# debugId= comment`);
        continue;
      }
      checked++;

      // The map on disk must carry the root debugId the plugin stamps.
      const parsed = JSON.parse(mapBytes.toString('utf8')) as { debugId?: string };
      if (parsed.debugId !== embedded) {
        failures.push(`${name}: shipped map debugId=${parsed.debugId ?? '<absent>'} but JS says ${embedded}`);
      }

      // And it must recompute, which is exactly what the server does on upload.
      const { debugId } = await computeDebugId(new Uint8Array(mapBytes));
      if (debugId !== embedded) {
        failures.push(`${name}: recomputed ${debugId} but JS says ${embedded}`);
      }
    }

    expect(checked).toBeGreaterThan(1);
    expect(failures).toEqual([]);
  }, 120_000);

  it('still resolves generated positions to the right original line', () => {
    const name = readdirSync(assets).find(
      (file) => file.startsWith('debug-id-lazy') && file.endsWith('.js'),
    );
    expect(name).toBeDefined();

    const code = readFileSync(join(assets, name!), 'utf8');
    const tracer = new TraceMap(
      JSON.parse(readFileSync(join(assets, `${name!}.map`), 'utf8')) as never,
    );

    // Use a deliberately mapped segment: the first one the map itself declares
    // for a source position, rather than an arbitrary offset that is often
    // unmapped and makes the assertion flaky.
    const decoded = decodedMappings(tracer);
    let mapped: { line: number; column: number; segment: readonly number[] } | undefined;
    for (let line = 0; line < decoded.length && !mapped; line++) {
      for (const segment of decoded[line]) {
        if (segment.length >= 4) {
          mapped = { line: line + 1, column: segment[0], segment };
          break;
        }
      }
    }
    expect(mapped).toBeDefined();

    const position = originalPositionFor(tracer, {
      line: mapped!.line,
      column: mapped!.column,
    });
    expect(position.source).toBe(tracer.resolvedSources[mapped!.segment[1]!]);
    expect(position.line).toBe(mapped!.segment[2]! + 1);
    expect(position.column).toBe(mapped!.segment[3]!);

    // And end to end: the module's only statement must still resolve to line 1
    // of its own source. A wrong prelude line shift moves this.
    const marker = code.indexOf('debug-id lazy module init');
    expect(marker).toBeGreaterThan(-1);
    const before = code.slice(0, marker);
    const markerLine = before.split('\n').length;
    const markerColumn = marker - (before.lastIndexOf('\n') + 1);
    const resolved = originalPositionFor(tracer, {
      line: markerLine,
      column: markerColumn,
    });
    expect(resolved.source).toBe('src/debug-id-lazy.ts');
    expect(resolved.line).toBe(1);
  }, 120_000);
});

describe('the plugin verifies the map it shipped against the bytes on disk', () => {
  it('reports a stable error code when a later plugin overwrites the map', async () => {
    const { build } = await import('vite');
    const vue = (await import('@vitejs/plugin-vue')).default;
    const { opslaneVitePlugin } = await import('../../vite-plugin/index.js');
    const out = mkdtempSync(join(tmpdir(), 'shipped-map-broken-'));

    const overwritten = new Map<string, string>();
    const saboteur = {
      name: 'overwrite-the-map',
      apply: 'build' as const,
      // Same enforce and hook order as ours, listed after it, so Rollup runs
      // this handler immediately after the plugin has stamped.
      enforce: 'post' as const,
      generateBundle: {
        order: 'post' as const,
        handler(_options: unknown, bundle: Record<string, any>) {
          for (const [key, value] of Object.entries(bundle)) {
            if (!key.endsWith('.js.map') || value.type !== 'asset') continue;
            const parsed = JSON.parse(String(value.source)) as {
              mappings: string;
            };
            // A real but different map: same shape, one mapping segment gone.
            value.source = JSON.stringify({
              ...parsed,
              mappings: parsed.mappings.replace(/^;*/, ''),
            });
            overwritten.set(key, value.source as string);
          }
        },
      },
    };

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await build({
        root: FIXTURE,
        configFile: false,
        logLevel: 'error',
        worker: { format: 'es' },
        plugins: [vue(), opslaneVitePlugin({ sourcemaps: 'keep' }), saboteur],
        build: { outDir: out, emptyOutDir: true, sourcemap: 'hidden' },
      });

      // The overwrite has to have reached disk, or the test proves nothing.
      expect(overwritten.size).toBeGreaterThan(0);
      for (const [key, source] of overwritten) {
        expect(readFileSync(join(out, key), 'utf8')).toBe(source);
      }

      const message = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes('OPSLANE_VITE_MAP_VERIFY_FAILED'));
      expect(message).toBeDefined();
      expect(message).toContain('rejected on upload');

      const reported = [...overwritten.keys()].filter((key) =>
        message!.includes(key),
      );
      expect(reported.length).toBeGreaterThan(1);
      // Every name in the report is a map this build really did corrupt.
      const affected = /Affected: (.*)/.exec(message!)?.[1] ?? '';
      for (const name of affected.split(', ')) {
        expect(overwritten.has(name)).toBe(true);
      }
    } finally {
      errorSpy.mockRestore();
    }
  }, 120_000);
});
