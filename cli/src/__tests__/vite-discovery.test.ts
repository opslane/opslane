import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { type PluginContractDeps } from '../codemods/vite-contract.js';
import {
  discoverViteProject,
  versionAtLeast,
} from '../codemods/vite-discovery.js';

const contract: PluginContractDeps = {
  specifier: 'fixture/plugin',
  exportName: 'opslane',
  pluginName: 'fixture-plugin',
  importLine: "import { opslane } from 'fixture/plugin';",
  callText: 'opslane()',
  exportNames: ['opslane', 'opslaneVitePlugin'],
  viteMajors: { minimum: 5, maximum: 8 },
  minimumSdkVersion: '3.0.0',
};

async function repo(configs: string[] = ['vite.config.ts']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opslane-vite-discovery-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { '@sentry/vite-plugin': '1.0.0' },
  }));
  for (const config of configs) writeFileSync(join(root, config), 'export default {}');
  return root;
}

const installed = async (_appDir: string, name: string): Promise<string | null> =>
  name === 'vite' ? '6.4.3' : '3.1.0';

describe('discoverViteProject', () => {
  it('finds one of exactly six names', async () => {
    const root = await repo(['vite.config.mts']);
    const result = await discoverViteProject({ repoRoot: root, contract }, {
      installedVersion: installed,
    });
    expect(result).toMatchObject({
      ok: true,
      configRelative: 'vite.config.mts',
    });
  });

  it('reports missing and multiple configs without guessing', async () => {
    const empty = await repo([]);
    expect(await discoverViteProject({ repoRoot: empty, contract }, { installedVersion: installed }))
      .toMatchObject({ ok: false, status: 'config_not_found' });

    const multiple = await repo(['vite.config.js', 'vite.config.ts']);
    writeFileSync(join(multiple, 'index.html'), '');
    expect(await discoverViteProject({ repoRoot: multiple, contract }, { installedVersion: installed }))
      .toMatchObject({
        ok: false,
        status: 'multiple_configs',
        candidates: [
          { file: 'vite.config.js', hasIndexHtml: true },
          { file: 'vite.config.ts', hasIndexHtml: true },
        ],
      });
  });

  it.each([
    ['vite_not_installed', null, '3.1.0'],
    ['vite_version_unsupported', '4.5.0', '3.1.0'],
    ['sdk_not_installed', '6.0.0', null],
    ['plugin_not_available_yet', '6.0.0', '2.9.9'],
  ] as const)('returns %s', async (status, vite, sdk) => {
    const root = await repo();
    const result = await discoverViteProject({ repoRoot: root, contract }, {
      installedVersion: async (_dir, name) => name === 'vite' ? vite : sdk,
    });
    expect(result).toMatchObject({ ok: false, status });
  });

  it('never compares an installed SDK version against a null contract floor', async () => {
    const root = await repo();
    const result = await discoverViteProject({
      repoRoot: root,
      contract: { ...contract, minimumSdkVersion: null },
    }, { installedVersion: installed });
    expect(result).toMatchObject({ ok: false, status: 'plugin_not_available_yet' });
  });

  it('refuses escaping, symlinked, and hard-linked configs', async () => {
    const root = await repo([]);
    const outside = join(await mkdtemp(join(tmpdir(), 'opslane-outside-')), 'vite.config.ts');
    writeFileSync(outside, 'export default {}');
    expect(await discoverViteProject({
      repoRoot: root,
      config: outside,
      contract,
    }, { installedVersion: installed })).toMatchObject({ ok: false, status: 'unsafe_config' });

    symlinkSync(outside, join(root, 'vite.config.ts'));
    expect(await discoverViteProject({
      repoRoot: root,
      contract,
    }, { installedVersion: installed })).toMatchObject({ ok: false, status: 'unsafe_config' });

    const hardRoot = await repo([]);
    linkSync(outside, join(hardRoot, 'vite.config.ts'));
    expect(await discoverViteProject({
      repoRoot: hardRoot,
      contract,
    }, { installedVersion: installed })).toMatchObject({ ok: false, status: 'unsafe_config' });
  });

  it('contains app-dir and explicit config within the repository', async () => {
    const root = await repo([]);
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'custom.ts'), 'export default {}');
    writeFileSync(join(root, 'apps', 'web', 'package.json'), '{}');
    const result = await discoverViteProject({
      repoRoot: root,
      appDir: 'apps/web',
      config: 'custom.ts',
      contract,
    }, { installedVersion: installed });
    expect(result).toMatchObject({ ok: true, configRelative: 'apps/web/custom.ts' });
  });

  it('rejects a file passed as app-dir', async () => {
    const root = await repo();
    expect(await discoverViteProject({
      repoRoot: root,
      appDir: 'package.json',
      contract,
    }, { installedVersion: installed })).toMatchObject({
      ok: false,
      status: 'unsafe_config',
    });
  });
});

it('compares exact installed versions without a semver dependency', () => {
  expect(versionAtLeast('3.0.0', '3.0.0')).toBe(true);
  expect(versionAtLeast('3.1.0', '3.0.5')).toBe(true);
  expect(versionAtLeast('2.9.9', '3.0.0')).toBe(false);
  expect(versionAtLeast('3.0.0-beta.1', '3.0.0')).toBe(false);
  expect(versionAtLeast('3.1.0-beta.1', '3.0.0')).toBe(true);
});

/**
 * The plugin declares support for Vite 6 to 8. Accepting a newer major would
 * install into a build the plugin has never run in, moving the failure from
 * this command into the customer's build.
 */
describe('discoverViteProject Vite version range', () => {
  it.each([
    ['4.5.0', 'vite_version_unsupported'],
    ['5.4.21', 'ok'],
    ['6.0.0', 'ok'],
    ['8.9.9', 'ok'],
    ['9.0.0', 'vite_version_unsupported'],
  ])('installed Vite %s', async (viteVersion, expected) => {
    const root = await repo();
    const result = await discoverViteProject({ repoRoot: root, contract }, {
      installedVersion: async (_dir, name) => name === 'vite' ? viteVersion : '3.0.0',
    });
    expect(result.ok ? 'ok' : result.status).toBe(expected);
  });
});
