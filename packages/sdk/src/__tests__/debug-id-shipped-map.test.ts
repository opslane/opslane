// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
});
