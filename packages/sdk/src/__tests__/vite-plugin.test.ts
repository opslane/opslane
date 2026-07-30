import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  opslane,
  opslaneSourceMapPlugin,
  opslaneVitePlugin,
} from '../../vite-plugin/index';
import { computeDebugId } from '../build/debug-id';
import {
  COMMIT_SHA_GLOBAL,
  DEBUG_ID_PLACEHOLDER,
  REGISTRY_GLOBAL,
} from '../build/registry-contract';

/** Both plugins declare generateBundle as an ordered hook descriptor. */
function callGenerateBundle(
  plugin: { generateBundle?: unknown },
  outputOptions: unknown,
  bundle: unknown,
): unknown {
  const hook = plugin.generateBundle as {
    handler: (options: unknown, bundle: unknown) => unknown;
  };
  return hook.handler.call(plugin, outputOptions, bundle);
}

const opts = { apiKey: 'unused', endpoint: 'https://api.test' };

describe('vite plugin', () => {
  it('fails the build instead of silently dropping source maps', () => {
    const plugin = opslaneSourceMapPlugin(opts) as { configResolved: (config: unknown) => void };

    expect(() => plugin.configResolved({})).toThrow(/source-map upload is unavailable/);
  });

  it('no longer removes map assets from the bundle', () => {
    const plugin = opslaneSourceMapPlugin(opts) as Record<string, unknown>;

  it('should return a valid Vite plugin object', () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    expect(plugin.name).toBe('opslane-source-map');
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('post');
    expect(typeof (plugin.generateBundle as any).handler).toBe('function');
    expect((plugin.generateBundle as any).order).toBe('post');
    expect(typeof plugin.closeBundle).toBe('function');
  });

  it('should enable source maps in config', () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    const config = (plugin as any).config();
    expect(config.build.sourcemap).toBe('hidden');
  });

  it('should collect .map files in generateBundle and remove them from output', () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    const bundle: Record<string, any> = {
      'assets/index-abc123.js': {
        type: 'chunk',
        code: 'console.log("hello")',
        fileName: 'assets/index-abc123.js',
      },
      'assets/index-abc123.js.map': {
        type: 'asset',
        source: '{"mappings":"AAAA"}',
        fileName: 'assets/index-abc123.js.map',
      },
      'assets/vendor-def456.js': {
        type: 'chunk',
        code: 'var x = 1;',
        fileName: 'assets/vendor-def456.js',
      },
      'assets/vendor-def456.js.map': {
        type: 'asset',
        source: '{"mappings":"BBBB"}',
        fileName: 'assets/vendor-def456.js.map',
      },
    };

    // Call generateBundle
    callGenerateBundle(plugin, {}, bundle);

    // .map files should be removed from the bundle
    expect(bundle['assets/index-abc123.js.map']).toBeUndefined();
    expect(bundle['assets/vendor-def456.js.map']).toBeUndefined();
    // JS files should remain
    expect(bundle['assets/index-abc123.js']).toBeDefined();
    expect(bundle['assets/vendor-def456.js']).toBeDefined();
  });

  it('should upload each source map individually via multipart FormData on closeBundle', async () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
      release: 'v1.0.0',
    });

    const bundle: Record<string, any> = {
      'assets/index-abc123.js.map': {
        type: 'asset',
        source: '{"mappings":"AAAA"}',
        fileName: 'assets/index-abc123.js.map',
      },
      'assets/vendor-def456.js.map': {
        type: 'asset',
        source: '{"mappings":"BBBB"}',
        fileName: 'assets/vendor-def456.js.map',
      },
    };

    callGenerateBundle(plugin, {}, bundle);
    await (plugin.closeBundle as Function).call(plugin);

    // One request per source map file
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe('https://ingest.example.com/api/v1/sourcemaps');
      expect(options.method).toBe('POST');
      expect(options.headers['X-API-Key']).toBe('key-sm');
      // Body should be FormData (no Content-Type header set manually — browser sets it with boundary)
      expect(options.body).toBeInstanceOf(FormData);
    }
  });

  it('should not upload if no source maps were collected', async () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    await (plugin.closeBundle as Function).call(plugin);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses VITE_OPSLANE_RELEASE when no release option is given', async () => {
    const prev = process.env.VITE_OPSLANE_RELEASE;
    process.env.VITE_OPSLANE_RELEASE = 'sha-abc123';
    const plugin = opslaneSourceMapPlugin({ endpoint: 'https://i.com', apiKey: 'k' });
    const bundle: Record<string, any> = {
      'a.js.map': { type: 'asset', source: '{}', fileName: 'a.js.map' },
    };
    callGenerateBundle(plugin, {}, bundle);
    await (plugin.closeBundle as Function).call(plugin);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('release')).toBe('sha-abc123');
    process.env.VITE_OPSLANE_RELEASE = prev;
  });

  it('warns loudly and does NOT upload when no release is set', async () => {
    const prev = process.env.VITE_OPSLANE_RELEASE;
    delete process.env.VITE_OPSLANE_RELEASE;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = opslaneSourceMapPlugin({ endpoint: 'https://i.com', apiKey: 'k' });
    const bundle: Record<string, any> = {
      'a.js.map': { type: 'asset', source: '{}', fileName: 'a.js.map' },
    };
    callGenerateBundle(plugin, {}, bundle);
    await (plugin.closeBundle as Function).call(plugin);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('VITE_OPSLANE_RELEASE'));
    warn.mockRestore();
    process.env.VITE_OPSLANE_RELEASE = prev;
  });

  it('should log a warning on upload failure but not throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('upload failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    const bundle: Record<string, any> = {
      'assets/index.js.map': {
        type: 'asset',
        source: '{}',
        fileName: 'assets/index.js.map',
      },
    };

    callGenerateBundle(plugin, {}, bundle);

    // Should not throw
    await expect(
      (plugin.closeBundle as Function).call(plugin)
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[opslane]')
    );

    warnSpy.mockRestore();
  });
});

describe('Vite debug-ID plugin', () => {
  function makeBundle(
    code = 'console.log("hello");',
  ): Record<string, any> {
    return {
      'assets/index.js': {
        type: 'chunk',
        code,
        fileName: 'assets/index.js',
      },
      'assets/index.js.map': {
        type: 'asset',
        source: JSON.stringify({
          version: 3,
          file: 'assets/index.js',
          sources: ['src/index.ts'],
          sourcesContent: ['console.log("hello");'],
          names: [],
          mappings: 'AAAA',
        }),
        fileName: 'assets/index.js.map',
      },
    };
  }

  async function stamp(
    plugin: ReturnType<typeof opslaneVitePlugin>,
    bundle: Record<string, any>,
    format = 'es',
  ): Promise<void> {
    await callGenerateBundle(plugin, { format }, bundle);
  }

  it('stamps the same fingerprint into an ES chunk and its map', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle();

    await stamp(plugin, bundle);

    expect(plugin.name).toBe('opslane-debug-ids');
    expect(opslane).toBe(opslaneVitePlugin);
    expect(bundle['assets/index.js'].code).toContain('import.meta.url');
    expect(bundle['assets/index.js'].code).not.toContain(DEBUG_ID_PLACEHOLDER);
    const mapSource = bundle['assets/index.js.map'].source as string;
    const map = JSON.parse(mapSource) as { debugId: string };
    const recomputed = await computeDebugId(
      new TextEncoder().encode(mapSource),
    );
    expect(map.debugId).toBe(recomputed.debugId);
    expect(bundle['assets/index.js'].code).toContain(
      `//# debugId=${map.debugId}`,
    );
  });

  it.each([
    {
      name: 'unset',
      config: {},
      requested: 'hidden',
      stamped: true,
      retained: false,
    },
    {
      name: 'hidden',
      config: { build: { sourcemap: 'hidden' } },
      requested: undefined,
      stamped: true,
      retained: false,
    },
    {
      name: 'true',
      config: { build: { sourcemap: true } },
      requested: undefined,
      stamped: true,
      retained: true,
    },
    {
      name: 'inline',
      config: { build: { sourcemap: 'inline' } },
      requested: undefined,
      stamped: false,
      retained: true,
    },
    {
      name: 'false',
      config: { build: { sourcemap: false } },
      requested: undefined,
      stamped: false,
      retained: true,
    },
  ])(
    'honours build.sourcemap=$name',
    async ({ config, requested, stamped, retained }) => {
      const plugin = opslaneVitePlugin({ logLevel: 'silent' });
      const result = (plugin.config as Function).call(plugin, config);
      expect(result.build?.sourcemap).toBe(requested);
      const bundle = makeBundle();

      await stamp(plugin, bundle);

      expect(bundle['assets/index.js'].code.includes('//# debugId=')).toBe(
        stamped,
      );
      expect(Boolean(bundle['assets/index.js.map'])).toBe(retained);
    },
  );

  it.each(['iife', 'umd', 'cjs', 'system'])(
    'uses the script registry prelude for %s output',
    async (format) => {
      const plugin = opslaneVitePlugin({
        sourcemaps: 'keep',
        logLevel: 'silent',
      });
      const bundle = makeBundle();
      await stamp(plugin, bundle, format);

      expect(bundle['assets/index.js'].code).toContain(
        'document.currentScript',
      );
      expect(bundle['assets/index.js'].code).not.toContain('import.meta');
    },
  );

  it('skips unsupported output formats without failing the build', async () => {
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    const bundle = makeBundle();
    await expect(stamp(plugin, bundle, 'amd')).resolves.toBeUndefined();
    expect(bundle['assets/index.js'].code).toBe('console.log("hello");');
  });

  it('keeps a directive prologue as the first statement', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle(`'use strict';\nconsole.log("hello");`);
    await stamp(plugin, bundle, 'cjs');

    expect(bundle['assets/index.js'].code).toMatch(/^'use strict';/);
    expect(bundle['assets/index.js'].code.indexOf('use strict')).toBeLessThan(
      bundle['assets/index.js'].code.indexOf(REGISTRY_GLOBAL),
    );
  });

  it('keeps a shebang on line one', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle(
      '#!/usr/bin/env node\nconsole.log("hello");',
    );
    await stamp(plugin, bundle, 'cjs');

    expect(bundle['assets/index.js'].code.split('\n')[0]).toBe(
      '#!/usr/bin/env node',
    );
  });

  it('emits an ES5-compatible script prelude', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle();
    await stamp(plugin, bundle, 'iife');
    const prelude = bundle['assets/index.js'].code.split('\n')[0];

    expect(() => new Function(prelude)).not.toThrow();
    expect(prelude).not.toMatch(
      /(?:=>|\b(?:let|const|class)\b|\?\.|\?\?|&&=|\|\|=)/,
    );
  });

  it('skips a map over maxMapBytes and reports it in the summary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = opslaneVitePlugin({
      maxMapBytes: 10,
      logLevel: 'warn',
    });
    const bundle = makeBundle();

    await expect(stamp(plugin, bundle)).resolves.toBeUndefined();
    await (plugin.closeBundle as Function).call(plugin);

    expect(bundle['assets/index.js'].code).toBe('console.log("hello");');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 map over 10 B'),
    );
  });

  it('leaves a chunk unchanged when its map is invalid', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle();
    bundle['assets/index.js.map'].source = '{';

    await expect(stamp(plugin, bundle)).resolves.toBeUndefined();

    expect(bundle['assets/index.js'].code).toBe('console.log("hello");');
    expect(bundle['assets/index.js.map'].source).toBe('{');
  });

  it('removes generated map assets in the default configuration', async () => {
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    (plugin.config as Function).call(plugin, {});
    const bundle = makeBundle();
    await stamp(plugin, bundle);

    expect(bundle['assets/index.js.map']).toBeUndefined();
  });

  it('defines an explicit valid commit SHA before chunk hashing', () => {
    const commit = 'e60b4d1e113538d40f09e31717e949aaa08659f8';
    const plugin = opslaneVitePlugin({
      commitSha: commit,
      logLevel: 'silent',
    });

    const result = (plugin.config as Function).call(plugin, {});

    expect(result.define[COMMIT_SHA_GLOBAL]).toBe(JSON.stringify(commit));
  });

  it('honours stamp:false without forcing source-map generation', async () => {
    const plugin = opslaneVitePlugin({
      stamp: false,
      logLevel: 'silent',
    });
    expect((plugin.config as Function).call(plugin, {}).build).toBeUndefined();
    const bundle = makeBundle();

    await stamp(plugin, bundle);

    expect(bundle['assets/index.js'].code).toBe('console.log("hello");');
  });

  it('disables stamping when a known SRI plugin is present', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    (plugin.configResolved as Function).call(plugin, {
      root: process.cwd(),
      build: { outDir: 'dist' },
      plugins: [{ name: 'opslane-debug-ids' }, { name: 'vite-plugin-sri' }],
    });
    const bundle = makeBundle();

    await stamp(plugin, bundle);

    expect(bundle['assets/index.js'].code).toBe('console.log("hello");');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('OPSLANE_VITE_SRI_DETECTED'),
    );
  });

  it('keeps map assets when the legacy uploader is also configured', async () => {
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    (plugin.configResolved as Function).call(plugin, {
      root: process.cwd(),
      build: { outDir: 'dist' },
      plugins: [{ name: 'opslane-debug-ids' }, { name: 'opslane-source-map' }],
    });
    const bundle = makeBundle();

    await stamp(plugin, bundle);

    expect(bundle['assets/index.js'].code).toContain('//# debugId=');
    expect(bundle['assets/index.js.map']).toBeDefined();
  });

  it('replaces a hostile registry and does not register duplicate IDs', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle();
    await stamp(plugin, bundle, 'iife');
    const codeFile = 'https://h/assets/index.js';
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      value: { src: codeFile },
    });
    (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL] = 'hostile';

    const execute = new Function(bundle['assets/index.js'].code);
    execute();
    execute();

    const registry = (globalThis as Record<string, unknown>)[
      REGISTRY_GLOBAL
    ] as Record<string, string[]>;
    expect(Object.getPrototypeOf(registry)).toBeNull();
    expect(registry[codeFile]).toHaveLength(1);
    delete (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
  });
});
