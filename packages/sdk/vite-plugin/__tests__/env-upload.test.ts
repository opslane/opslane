// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { opslaneVitePlugin } from '../index.js';

it('loads private upload credentials from the project .env.local', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opslane-vite-env-'));
  writeFileSync(
    join(root, '.env.local'),
    'OPSLANE_ENDPOINT=https://env.example\nOPSLANE_SOURCEMAP_KEY=opslane_sk_from_file\n',
  );
  const priorEndpoint = process.env['OPSLANE_ENDPOINT'];
  const priorKey = process.env['OPSLANE_SOURCEMAP_KEY'];
  delete process.env['OPSLANE_ENDPOINT'];
  delete process.env['OPSLANE_SOURCEMAP_KEY'];
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('', { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    (plugin.config as Function).call(plugin, {});
    await (plugin.configResolved as Function).call(plugin, {
      root,
      mode: 'production',
      build: { outDir: 'dist' },
      plugins: [{ name: 'opslane-debug-ids' }],
    });
    const bundle = {
      'assets/app.js': {
        type: 'chunk', fileName: 'assets/app.js', code: 'console.log("app")',
      },
      'assets/app.js.map': {
        type: 'asset', fileName: 'assets/app.js.map',
        source: JSON.stringify({
          version: 3,
          sources: ['src/app.ts'],
          sourcesContent: ['console.log("app")'],
          names: [],
          mappings: 'AAAA',
        }),
      },
    };
    const generate = plugin.generateBundle as {
      handler(options: unknown, output: unknown): Promise<void>;
    };
    await generate.handler.call(plugin, { format: 'es' }, bundle);
    await (plugin.closeBundle as Function).call(plugin);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/env\.example\/api\/v1\/sourcemaps\//,
    );
  } finally {
    vi.unstubAllGlobals();
    if (priorEndpoint === undefined) delete process.env['OPSLANE_ENDPOINT'];
    else process.env['OPSLANE_ENDPOINT'] = priorEndpoint;
    if (priorKey === undefined) delete process.env['OPSLANE_SOURCEMAP_KEY'];
    else process.env['OPSLANE_SOURCEMAP_KEY'] = priorKey;
    rmSync(root, { recursive: true, force: true });
  }
});
