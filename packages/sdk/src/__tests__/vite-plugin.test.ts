import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('vite', () => ({ loadEnv: vi.fn(() => ({})) }));
import {
  opslane,
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
      // Explicitly asked for by the project, so not ours to delete.
      retained: true,
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

  // esbuild emits `"use strict";const a=1,b=2,...` as a single line for a
  // minified CJS build, so the prologue has no trailing newline to match on.
  // Inserting ahead of it demotes the directive to an ordinary string
  // expression and the whole chunk silently runs in sloppy mode.
  it('keeps a minified directive prologue as the first statement', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle('"use strict";var x=1');
    await stamp(plugin, bundle, 'cjs');

    const code = bundle['assets/index.js'].code as string;
    expect(code).toMatch(/^"use strict";/);
    expect(code.indexOf('use strict')).toBeLessThan(code.indexOf(REGISTRY_GLOBAL));
  });

  // Prelude placement has two independent dimensions: whether a shebang is
  // present, and how the directive prologue terminates. Testing them one at a
  // time is what let `#!` + a minified directive through, where the shebang was
  // duplicated into the middle of the file and the output stopped parsing.
  // Cover the grid, not the bugs that happen to be known.
  describe.each([
    ['no prologue', '', 'var x=1'],
    ['newline-terminated', '', '"use strict";\nvar x=1'],
    ['minified, no newline', '', '"use strict";var x=1'],
    ['semicolonless', '', '"use strict"\nvar x=1'],
    ['shebang only', '#!/usr/bin/env node\n', 'var x=1'],
    ['shebang + newline-terminated', '#!/usr/bin/env node\n', '"use strict";\nvar x=1'],
    ['shebang + minified', '#!/usr/bin/env node\n', '"use strict";var x=1'],
    ['shebang + semicolonless', '#!/usr/bin/env node\n', '"use strict"\nvar x=1'],
  ])('prelude placement: %s', (_name, shebang, body) => {
    const source = shebang + body;

    it('keeps the file valid and the mapping shift honest', async () => {
      const plugin = opslaneVitePlugin({
        sourcemaps: 'keep',
        logLevel: 'silent',
      });
      const bundle = makeBundle(source);
      await stamp(plugin, bundle, 'cjs');
      const code = bundle['assets/index.js'].code as string;

      // A shebang is only a shebang at byte zero. A second one anywhere is a
      // syntax error, and dropping it breaks the executable bit's whole point.
      expect((code.match(/^#!/gm) ?? []).length).toBe(shebang ? 1 : 0);
      if (shebang) expect(code.startsWith(shebang)).toBe(true);

      // The directive has to stay ahead of the prelude or the chunk silently
      // runs in sloppy mode.
      if (body.includes('use strict')) {
        expect(code.indexOf('use strict')).toBeLessThan(code.indexOf(REGISTRY_GLOBAL));
      }

      // The original body's last line must survive verbatim as a whole line.
      // Nothing may be prepended to it, or its columns stop matching the map.
      const lastOriginalLine = source.split('\n').at(-1) as string;
      expect(code.split('\n')).toContain(lastOriginalLine);

      // The map only shifts whole lines, so the segments it gained must equal
      // the lines the prelude actually added. If these drift, every frame in
      // the chunk resolves to the wrong original line.
      const map = JSON.parse(bundle['assets/index.js.map'].source as string);
      const segmentsGained = map.mappings.split(';').length - 1; // fixture has one
      const trailerLine = 1; // the appended `//# debugId=` line
      const linesGained =
        code.split('\n').length - source.split('\n').length - trailerLine;
      expect(segmentsGained).toBe(linesGained);
    });
  });

  // A newline only ends a statement when the next line cannot continue it.
  // `"x"\n(foo)` is a call and `"x"\n[0]` is a member access, so neither
  // string is a directive; treating them as one and inserting between splits
  // a single expression into two statements and changes what the code does.
  it.each([
    ['call continuation', '"x"\n(foo)'],
    ['member continuation', '"x"\n[0]'],
    ['operator continuation', '"x"\n+foo'],
  ])('does not treat a %s as a directive prologue', async (_name, source) => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle(source);
    await stamp(plugin, bundle, 'cjs');

    const code = bundle['assets/index.js'].code as string;
    // The expression must survive intact: nothing inserted between its parts.
    expect(code).toContain(source);
  });

  it('shifts mappings past every line the prelude adds', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle('"use strict";var x=1');
    await stamp(plugin, bundle, 'cjs');

    const code = bundle['assets/index.js'].code as string;
    const map = JSON.parse(bundle['assets/index.js.map'].source as string);
    // The original code is emitted verbatim, so the mapping for its first
    // segment has to name the generated line it actually landed on.
    const originalLine = code.split('\n').findIndex((line) => line.includes('var x=1'));
    const blankLeadingLines = map.mappings.split(';').findIndex((seg: string) => seg !== '');
    expect(blankLeadingLines).toBe(originalLine);
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

  it('uploads exactly the final stamped maps when private build env is set', async () => {
    const previousKey = process.env['OPSLANE_SOURCEMAP_KEY'];
    const previousEndpoint = process.env['OPSLANE_ENDPOINT'];
    process.env['OPSLANE_SOURCEMAP_KEY'] = 'opslane_sk_test';
    process.env['OPSLANE_ENDPOINT'] = 'https://ingestion.example';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const plugin = opslaneVitePlugin({ logLevel: 'silent' });
      (plugin.config as Function).call(plugin, {});
      const bundle = makeBundle();
      await stamp(plugin, bundle);
      await (plugin.closeBundle as Function).call(plugin);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, request] = fetchMock.mock.calls[0] ?? [];
      expect(String(url)).toMatch(/\/api\/v1\/sourcemaps\/[0-9a-f-]+$/);
      expect(request?.body).toContain('"debugId"');
      expect(bundle['assets/index.js.map']).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      if (previousKey === undefined) delete process.env['OPSLANE_SOURCEMAP_KEY'];
      else process.env['OPSLANE_SOURCEMAP_KEY'] = previousKey;
      if (previousEndpoint === undefined) delete process.env['OPSLANE_ENDPOINT'];
      else process.env['OPSLANE_ENDPOINT'] = previousEndpoint;
    }
  });

  it('does not upload without a source-map key', async () => {
    const previousKey = process.env['OPSLANE_SOURCEMAP_KEY'];
    delete process.env['OPSLANE_SOURCEMAP_KEY'];
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const plugin = opslaneVitePlugin({ logLevel: 'silent' });
      (plugin.config as Function).call(plugin, {});
      const bundle = makeBundle();
      await stamp(plugin, bundle);
      await (plugin.closeBundle as Function).call(plugin);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (previousKey === undefined) delete process.env['OPSLANE_SOURCEMAP_KEY'];
      else process.env['OPSLANE_SOURCEMAP_KEY'] = previousKey;
    }
  });

  it('reports a rejected upload without failing the build', async () => {
    const previousKey = process.env['OPSLANE_SOURCEMAP_KEY'];
    const previousEndpoint = process.env['OPSLANE_ENDPOINT'];
    process.env['OPSLANE_SOURCEMAP_KEY'] = 'opslane_sk_test';
    process.env['OPSLANE_ENDPOINT'] = 'https://ingestion.example';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', { status: 500 }),
    ));
    try {
      const plugin = opslaneVitePlugin({ logLevel: 'silent' });
      (plugin.config as Function).call(plugin, {});
      const bundle = makeBundle();
      await stamp(plugin, bundle);
      await expect(
        (plugin.closeBundle as Function).call(plugin),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      if (previousKey === undefined) delete process.env['OPSLANE_SOURCEMAP_KEY'];
      else process.env['OPSLANE_SOURCEMAP_KEY'] = previousKey;
      if (previousEndpoint === undefined) delete process.env['OPSLANE_ENDPOINT'];
      else process.env['OPSLANE_ENDPOINT'] = previousEndpoint;
    }
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

  it('removes standalone sourceMappingURL directives with private maps', async () => {
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    (plugin.config as Function).call(plugin, {});
    const bundle = makeBundle([
      'const parser = /\\/\\*# sourceMappingURL=/;',
      '/*# sourceMappingURL=vendor.js.map */',
      'console.log("hello");',
      '//# sourceMappingURL=index.js.map',
    ].join('\n'));

    await stamp(plugin, bundle);

    const code = bundle['assets/index.js'].code as string;
    expect(code).toContain('const parser = /\\/\\*# sourceMappingURL=/;');
    expect(code.split(/\r?\n/).some(
      (line) => /^(?:\/\/[@#]|\/\*[@#])\s*sourceMappingURL\s*=/.test(line.trim()),
    )).toBe(false);
  });

  // Vite runs a worker build as a nested build and copies its output into the
  // parent bundle as plain assets. Unless the plugin is also listed under
  // `worker.plugins`, that JavaScript arrives unstamped, and every path that
  // gives up on stamping used to leave the map in the bundle. The summary still
  // said the maps had been removed, so a default install published the original
  // source without ever saying so.
  it('removes an unstamped sibling map instead of publishing its sources', async () => {
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    (plugin.config as Function).call(plugin, {});
    const bundle = makeBundle();
    bundle['assets/worker.js'] = {
      type: 'asset',
      fileName: 'assets/worker.js',
      source: 'self.onmessage=function(){};',
    };
    bundle['assets/worker.js.map'] = {
      type: 'asset',
      fileName: 'assets/worker.js.map',
      source: JSON.stringify({
        version: 3,
        file: 'assets/worker.js',
        sources: ['src/worker.ts'],
        sourcesContent: ['// the customer\'s private source'],
        names: [],
        mappings: 'AAAA',
      }),
    };
    await stamp(plugin, bundle);

    expect(bundle['assets/worker.js.map']).toBeUndefined();
  });

  it('names an asset that no pass stamped rather than failing quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = opslaneVitePlugin({ sourcemaps: 'keep' });
    const bundle = makeBundle();
    bundle['assets/worker.js'] = {
      type: 'asset',
      fileName: 'assets/worker.js',
      source: 'self.onmessage=function(){};',
    };
    bundle['assets/worker.js.map'] = {
      type: 'asset',
      fileName: 'assets/worker.js.map',
      source: '{"version":3,"sources":[],"names":[],"mappings":""}',
    };

    await stamp(plugin, bundle);
    (plugin.closeBundle as Function).call(plugin);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('OPSLANE_VITE_ASSET_UNSTAMPED'),
    );
    // The unstamped file has to reach the denominator, or the summary reports
    // a clean build while a whole worker cannot be symbolicated.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 skipped: 1 emitted without a debug ID'),
    );
    warn.mockRestore();
  });

  it('keeps an unstamped sibling map when maps are retained', async () => {
    const plugin = opslaneVitePlugin({
      sourcemaps: 'keep',
      logLevel: 'silent',
    });
    const bundle = makeBundle();
    bundle['assets/worker.js'] = {
      type: 'asset',
      fileName: 'assets/worker.js',
      source: 'self.onmessage=function(){};',
    };
    bundle['assets/worker.js.map'] = {
      type: 'asset',
      fileName: 'assets/worker.js.map',
      source: '{"version":3,"sources":[],"names":[],"mappings":""}',
    };
    await stamp(plugin, bundle);

    expect(bundle['assets/worker.js.map']).toBeDefined();
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

  // The plugin switches maps on in `config`, then SRI detection switches
  // stamping off in `configResolved`, which runs later. Gating cleanup on
  // stamping therefore abandoned maps that only this plugin caused, while the
  // summary still reported them as removed.
  it('still removes the maps it caused when SRI disables stamping', async () => {
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    (plugin.config as Function).call(plugin, {});
    (plugin.configResolved as Function).call(plugin, {
      root: process.cwd(),
      build: { outDir: 'dist' },
      plugins: [{ name: 'opslane-debug-ids' }, { name: 'vite-plugin-sri' }],
    });
    const bundle = makeBundle();

    await stamp(plugin, bundle);

    expect(bundle['assets/index.js'].code).toBe('console.log("hello");');
    expect(bundle['assets/index.js.map']).toBeUndefined();
  });

  it('leaves the project\'s own maps alone even when SRI disables stamping', async () => {
    const plugin = opslaneVitePlugin({ logLevel: 'silent' });
    (plugin.config as Function).call(plugin, {
      build: { sourcemap: 'hidden' },
    });
    (plugin.configResolved as Function).call(plugin, {
      root: process.cwd(),
      build: { outDir: 'dist' },
      plugins: [{ name: 'opslane-debug-ids' }, { name: 'vite-plugin-sri' }],
    });
    const bundle = makeBundle();

    await stamp(plugin, bundle);

    expect(bundle['assets/index.js.map']).toBeDefined();
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

// The legacy opslaneSourceMapPlugin was removed in 3.0.0; old imports fail at
// build time with a missing-export error.
describe('legacy opslaneSourceMapPlugin removal', () => {
  it('is no longer exported', async () => {
    const mod = await import('../../vite-plugin/index') as Record<string, unknown>;
    expect(mod['opslaneSourceMapPlugin']).toBeUndefined();
    expect(mod['LEGACY_VITE_PLUGIN_NAME']).toBeUndefined();
  });
});
