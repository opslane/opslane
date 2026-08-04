/**
 * Build-mode fixture harness. The SDK package must be built before this runs:
 * the fixture config resolves @opslane/sdk/vite-plugin through workspace dist.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SDK_SOURCE = resolve(__dirname, '../packages/sdk/src');

export interface BuiltFixture {
  url: string;
  outDir: string;
  close(): Promise<void>;
}

export async function startBuiltFixture(opts: {
  fixtureDir: string;
  apiKey: string;
  ingestionUrl: string;
  sourcemapKey?: string;
  release?: string;
}): Promise<BuiltFixture> {
  const { build, preview } = await import('vite');
  const outDir = mkdtempSync(join(tmpdir(), 'opslane-built-fixture-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'opslane-built-cache-'));
  const managed = [
    'VITE_OPSLANE_ENDPOINT',
    'VITE_OPSLANE_API_KEY',
    'VITE_OPSLANE_RELEASE',
    'OPSLANE_ENDPOINT',
    'OPSLANE_SOURCEMAP_KEY',
  ] as const;
  const saved = new Map(managed.map((key) => [key, process.env[key]]));
  const values: Record<(typeof managed)[number], string | undefined> = {
    VITE_OPSLANE_ENDPOINT: opts.ingestionUrl,
    VITE_OPSLANE_API_KEY: opts.apiKey,
    VITE_OPSLANE_RELEASE: opts.release ?? '',
    // Never set, always cleared: the source-map key carries its own upload
    // origin now, and an ambient value would only trigger the plugin's
    // removal notice.
    OPSLANE_ENDPOINT: undefined,
    OPSLANE_SOURCEMAP_KEY: opts.sourcemapKey,
  };

  for (const key of managed) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await build({
      root: opts.fixtureDir,
      logLevel: 'error',
      cacheDir,
      resolve: {
        alias: [
          { find: '@opslane/sdk/react', replacement: resolve(SDK_SOURCE, 'react.tsx') },
          { find: '@opslane/sdk/_replay', replacement: resolve(SDK_SOURCE, 'replay.ts') },
          { find: '@opslane/sdk', replacement: resolve(SDK_SOURCE, 'index.ts') },
        ],
      },
      build: { outDir, emptyOutDir: true },
    });
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true });
    throw error;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(cacheDir, { recursive: true, force: true });
  }

  const server = await preview({
    root: opts.fixtureDir,
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') {
    await server.close();
    rmSync(outDir, { recursive: true, force: true });
    throw new Error('Vite preview did not expose a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    outDir,
    close: async () => {
      await server.close();
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
