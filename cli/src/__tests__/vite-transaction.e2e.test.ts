/**
 * End-to-end cover for the Vite config edit.
 *
 * Every other test in this suite replaces Vite with a fake module and replaces
 * `resolve` with a canned answer, so nothing has ever proved that an edited
 * config still builds. This file runs the real thing: real Vite 6 out of
 * `test-fixtures/vue-app`, a real git repository, the real fork that resolves
 * the config, and a real `vite build` afterwards.
 *
 * The only substitution is the plugin contract. `@opslane/sdk` does not export
 * `opslane()` yet (#224), so the app gets a stand-in package under that exact
 * specifier. The inserted text is the production text from
 * `OPSLANE_VITE_PLUGIN`, not a fixture string.
 *
 * The stand-in writes a marker file from `generateBundle`, which only a real
 * build calls. Its absence after the transaction and presence after the build
 * is what separates "the config parses" from "the plugin actually runs".
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  OPSLANE_VITE_PLUGIN,
  type PluginContractDeps,
} from '../codemods/vite-contract.js';
import { resolveViteConfig } from '../codemods/vite-resolve.js';
import {
  runViteTransaction,
  type ViteTransactionDeps,
} from '../codemods/vite-transaction.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(here, '../../..');
const REAL_VITE = join(repoRoot, 'test-fixtures/vue-app/node_modules/vite');
const REAL_SDK = join(repoRoot, 'packages/sdk');

/**
 * The forked child is found next to the running module, which under vitest is
 * the TypeScript source with no compiled sibling. Production always runs from
 * dist, so pointing at dist here is closer to shipped behaviour, not further
 * from it. It does mean the package must be built before this file runs.
 */
const CHILD_ENTRY = resolvePath(here, '../../dist/codemods/vite-resolve-child.js');

/** Matches the stand-in package written by `createApp`. */
const contract: PluginContractDeps = {
  ...OPSLANE_VITE_PLUGIN,
  exportNames: ['opslane', 'opslaneVitePlugin'],
  viteMajors: { minimum: 6, maximum: 8 },
  minimumSdkVersion: '9.0.0',
};

/** Only the contract is substituted. Everything else is production code. */
const deps: ViteTransactionDeps = {
  contract,
  resolve: (options) => resolveViteConfig({ ...options, childEntry: CHILD_ENTRY }),
};

const HOOK_MARKER = '.opslane-hook-fired';
const SENTRY_MARKER = '.other-plugin-hook-fired';

/** A plugin that behaves. Records that a real build reached `generateBundle`. */
const WORKING_PLUGIN = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function opslane() {
  let root = process.cwd();
  return {
    name: '${OPSLANE_VITE_PLUGIN.pluginName}',
    configResolved(config) { root = config.root; },
    generateBundle() { writeFileSync(join(root, '${HOOK_MARKER}'), 'generateBundle'); },
  };
}
`;

/** A plugin that throws while the config is being built. */
const EXPLODING_PLUGIN = `
export function opslane() { throw new Error('plugin exploded at config time'); }
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Runs the app's own Vite the way its developer would. */
function viteBuild(app: string): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync(
        process.execPath,
        [join(app, 'node_modules/vite/bin/vite.js'), 'build'],
        { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    };
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${shell.stdout ?? ''}${shell.stderr ?? ''}${shell.message}` };
  }
}

interface AppOptions {
  config: string;
  plugin?: string;
  /** Extra packages listed in package.json, for conflict detection. */
  dependencies?: Record<string, string>;
  /** Extra installed packages, keyed by name, valued by module source. */
  extraPackages?: Record<string, string>;
  /** Link the real built @opslane/sdk instead of writing a stand-in. */
  realSdk?: boolean;
}

/**
 * A committed, buildable Vite app in a temp directory. Vite is symlinked
 * rather than copied; Node resolves esbuild and rollup through the real path,
 * so the app gets a genuine Vite install without a network fetch.
 */
const createdApps: string[] = [];

afterAll(async () => {
  // rm does not follow the node_modules/vite symlink, so the shared fixture
  // install is never touched.
  await Promise.all(
    createdApps.map((app) => rm(app, { recursive: true, force: true })),
  );
});

async function createApp(options: AppOptions): Promise<string> {
  const app = await mkdtemp(join(tmpdir(), 'opslane-vite-e2e-'));
  createdApps.push(app);
  mkdirSync(join(app, 'src'));
  mkdirSync(join(app, 'node_modules/@opslane'), { recursive: true });
  if (options.realSdk) {
    symlinkSync(REAL_SDK, join(app, 'node_modules/@opslane/sdk'), 'dir');
  } else {
    mkdirSync(join(app, 'node_modules/@opslane/sdk/dist'), { recursive: true });
  }
  symlinkSync(REAL_VITE, join(app, 'node_modules/vite'), 'dir');

  writeFileSync(join(app, 'package.json'), `${JSON.stringify({
    name: 'opslane-vite-e2e-app',
    private: true,
    type: 'module',
    version: '0.0.0',
    dependencies: { vite: '6.4.3', '@opslane/sdk': '9.9.9', ...options.dependencies },
  }, null, 2)}\n`);
  if (!options.realSdk) writeFileSync(
    join(app, 'node_modules/@opslane/sdk/package.json'),
    JSON.stringify({
      name: '@opslane/sdk',
      version: '9.9.9',
      type: 'module',
      exports: { './vite-plugin': { import: './dist/vite-plugin.js' } },
    }),
  );
  if (!options.realSdk) writeFileSync(
    join(app, 'node_modules/@opslane/sdk/dist/vite-plugin.js'),
    options.plugin ?? WORKING_PLUGIN,
  );
  for (const [name, source] of Object.entries(options.extraPackages ?? {})) {
    const dir = join(app, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
    }));
    writeFileSync(join(dir, 'index.js'), source);
  }

  writeFileSync(
    join(app, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>\n',
  );
  writeFileSync(join(app, 'src/main.js'), 'console.log("opslane e2e app")\n');
  writeFileSync(join(app, 'vite.config.ts'), options.config);
  writeFileSync(join(app, '.gitignore'), 'node_modules\ndist\n');

  git(app, 'init', '--quiet');
  git(app, 'config', 'user.email', 'e2e@opslane.test');
  git(app, 'config', 'user.name', 'Opslane E2E');
  git(app, 'config', 'commit.gpgsign', 'false');
  git(app, 'add', '-A');
  git(app, 'commit', '--quiet', '-m', 'initial');
  return app;
}

const MULTI_LINE = `import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
  ],
  build: {
    outDir: 'dist',
  },
});
`;

/** 41 of 70 real configs put the plugin list on one line. */
const SINGLE_LINE = `import { defineConfig } from 'vite';

export default defineConfig({ plugins: [] });
`;

describe('vite transaction, end to end against real Vite', () => {
  it('has a real Vite to test against', () => {
    expect(
      existsSync(join(REAL_VITE, 'package.json')),
      `Real Vite missing at ${REAL_VITE}. Run pnpm install --frozen-lockfile.`,
    ).toBe(true);
  });

  it('edits a real config, and the plugin runs in a real production build', async () => {
    const app = await createApp({ config: MULTI_LINE });
    const before = sha256(join(app, 'vite.config.ts'));

    const result = await runViteTransaction({ repoRoot: app, apply: true }, deps);
    expect(result.status).toBe('edited');

    const after = readFileSync(join(app, 'vite.config.ts'), 'utf8');
    expect(after).toContain(OPSLANE_VITE_PLUGIN.importLine);
    expect(after).toContain(OPSLANE_VITE_PLUGIN.callText);
    expect(sha256(join(app, 'vite.config.ts'))).not.toBe(before);

    // R7: exactly one tracked file changed, and no scratch file survived.
    expect(git(app, 'status', '--porcelain').split('\n')).toEqual(['M vite.config.ts']);

    // Resolving a config must not run build hooks. If this marker exists here,
    // verification is doing more than reading configuration.
    expect(existsSync(join(app, HOOK_MARKER))).toBe(false);

    const build = viteBuild(app);
    expect(build.ok, build.output).toBe(true);
    expect(
      existsSync(join(app, HOOK_MARKER)),
      'the plugin was registered but never ran during the build',
    ).toBe(true);
  }, 60_000);

  it('handles a plugin list written on a single line', async () => {
    const app = await createApp({ config: SINGLE_LINE });
    const result = await runViteTransaction({ repoRoot: app, apply: true }, deps);
    expect(result.status).toBe('edited');

    const build = viteBuild(app);
    expect(build.ok, build.output).toBe(true);
    expect(existsSync(join(app, HOOK_MARKER))).toBe(true);
  }, 60_000);

  it('changes nothing on a second run', async () => {
    const app = await createApp({ config: MULTI_LINE });
    await runViteTransaction({ repoRoot: app, apply: true }, deps);
    const afterFirst = sha256(join(app, 'vite.config.ts'));

    const second = await runViteTransaction({ repoRoot: app, apply: true }, deps);
    expect(second.status).toBe('already_wired');
    expect(sha256(join(app, 'vite.config.ts'))).toBe(afterFirst);
  }, 60_000);

  it('reports a wired config through the app own Vite when checking', async () => {
    const app = await createApp({ config: MULTI_LINE });
    await runViteTransaction({ repoRoot: app, apply: true }, deps);

    const checked = await runViteTransaction({ repoRoot: app, check: true }, deps);
    expect(checked.status).toBe('already_wired');
  }, 60_000);

  it('restores the file byte for byte when the plugin throws, and the app still builds', async () => {
    const app = await createApp({ config: MULTI_LINE, plugin: EXPLODING_PLUGIN });
    const before = sha256(join(app, 'vite.config.ts'));

    const result = await runViteTransaction({ repoRoot: app, apply: true }, deps);
    expect(result.status).toBe('vite_config_broken_after_edit');
    expect(sha256(join(app, 'vite.config.ts'))).toBe(before);
    expect(git(app, 'status', '--porcelain')).toBe('');

    const build = viteBuild(app);
    expect(build.ok, build.output).toBe(true);
  }, 60_000);

  it('does not blame us for a config that was already broken', async () => {
    const app = await createApp({
      config: `import { defineConfig } from 'vite';
if (!process.env.OPSLANE_E2E_REQUIRED) throw new Error('this config needs OPSLANE_E2E_REQUIRED');
export default defineConfig({ plugins: [] });
`,
    });
    const before = sha256(join(app, 'vite.config.ts'));

    const result = await runViteTransaction({ repoRoot: app, apply: true }, deps);
    expect(result.status).toBe('vite_config_broken_before_edit');
    expect(sha256(join(app, 'vite.config.ts'))).toBe(before);
    expect(git(app, 'status', '--porcelain')).toBe('');
  }, 60_000);

  /**
   * Four of the 22 real projects already run Sentry's source-map plugin, and
   * design section 6a verified coexistence against the real plugin. This pins
   * that decision: a Sentry project is accepted, edited, and still builds.
   */
  it('accepts a project that already runs the Sentry plugin', async () => {
    const app = await createApp({
      config: `import { defineConfig } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig({
  plugins: [
    sentryVitePlugin(),
  ],
});
`,
      dependencies: { '@sentry/vite-plugin': '5.1.0' },
      // A stand-in, so the build stays offline and sends nothing. It uses
      // writeBundle, the phase the real plugin works in. Whether Sentry still
      // receives its maps is the plugin's property and belongs to #224; what
      // this test owns is that we accept the project and the build survives.
      extraPackages: {
        '@sentry/vite-plugin': `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function sentryVitePlugin() {
  let root = process.cwd();
  return {
    name: 'sentry-vite-plugin',
    configResolved(config) { root = config.root; },
    writeBundle() { writeFileSync(join(root, '${SENTRY_MARKER}'), 'writeBundle'); },
  };
}
`,
      },
    });

    const result = await runViteTransaction({ repoRoot: app, apply: true }, deps);
    expect(result.status).toBe('edited');

    const build = viteBuild(app);
    expect(build.ok, build.output).toBe(true);
    expect(existsSync(join(app, HOOK_MARKER)), 'our plugin did not run').toBe(true);
    expect(existsSync(join(app, SENTRY_MARKER)), 'the other plugin did not run').toBe(true);
  }, 60_000);

  /**
   * Everything above substitutes the plugin contract, because the factory did
   * not exist while this command was written. It does now. This is the same
   * transaction against the real built @opslane/sdk, proving the two lines the
   * codemod writes load the actual plugin and that it does its job in a real
   * build: a debug ID footer in every chunk is something only the real plugin
   * can produce.
   */
  it('installs the real SDK plugin, which stamps a real build', async () => {
    const app = await createApp({
      config: MULTI_LINE,
      realSdk: true,
      dependencies: { '@opslane/sdk': '2.0.1' },
    });

    const result = await runViteTransaction({ repoRoot: app, apply: true }, {
      contract: { ...OPSLANE_VITE_PLUGIN, exportNames: ['opslane', 'opslaneVitePlugin'],
        viteMajors: { minimum: 5, maximum: 8 }, minimumSdkVersion: '2.0.1' },
      resolve: (options) => resolveViteConfig({ ...options, childEntry: CHILD_ENTRY }),
    });
    expect(result.status).toBe('edited');
    expect(git(app, 'status', '--porcelain').split('\n')).toEqual(['M vite.config.ts']);

    const build = viteBuild(app);
    expect(build.ok, build.output).toBe(true);

    const assets = join(app, 'dist', 'assets');
    const chunks = readdirSync(assets).filter((file) => file.endsWith('.js'));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(readFileSync(join(assets, chunk), 'utf8'), `${chunk} was not stamped`)
        .toContain('//# debugId=');
    }
  }, 60_000);
});
