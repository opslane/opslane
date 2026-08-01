import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  resolveInChild,
  resolveViteConfig,
  sanitizeChildEnv,
} from '../codemods/vite-resolve.js';

async function viteFixture(
  version: string,
  moduleSource: string,
  moduleType: 'module' | 'commonjs' = 'module',
): Promise<string> {
  const appDir = await mkdtemp(join(tmpdir(), 'opslane-vite-resolve-'));
  const viteDir = join(appDir, 'node_modules', 'vite');
  mkdirSync(viteDir, { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(appDir, 'vite.config.ts'), 'export default {}');
  writeFileSync(join(viteDir, 'package.json'), JSON.stringify({
    name: 'vite',
    version,
    type: moduleType,
    main: 'index.js',
    exports: {
      '.': './index.js',
      './package.json': './package.json',
    },
  }));
  writeFileSync(join(viteDir, 'index.js'), moduleSource);
  return appDir;
}

describe('resolveInChild', () => {
  it('uses the app Vite and returns cloneable plugin names', async () => {
    const appDir = await viteFixture(
      '6.4.3',
      `export async function resolveConfig(options, command) {
        if (options.configFile !== '${'${CONFIG}'}' && command !== 'build') throw new Error('bad args');
        return { plugins: [{ name: 'react' }, { name: 'opslane-source-map' }] };
      }`.replace("'${CONFIG}'", JSON.stringify(join('/unused'))),
    );
    const result = await resolveInChild({
      appDir,
      configPath: join(appDir, 'vite.config.ts'),
    });
    expect(result).toEqual({ ok: true, pluginNames: ['react', 'opslane-source-map'] });
  });

  it('supports Vite exposed through a CommonJS default', async () => {
    const appDir = await viteFixture(
      '6.0.0',
      `module.exports = { resolveConfig: async () => ({ plugins: [{ name: 'cjs' }] }) };`,
      'commonjs',
    );
    await expect(resolveInChild({
      appDir,
      configPath: join(appDir, 'vite.config.ts'),
    })).resolves.toEqual({ ok: true, pluginNames: ['cjs'] });
  });

  it('returns typed failures for missing, old, unusable, and throwing Vite', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'opslane-no-vite-'));
    writeFileSync(join(missing, 'package.json'), '{}');
    expect(await resolveInChild({
      appDir: missing,
      configPath: 'vite.config.ts',
      resolvePackage: () => {
        throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
      },
    }))
      .toMatchObject({ ok: false, reason: 'vite_not_installed' });

    const old = await viteFixture('4.5.0', `export const resolveConfig = async () => ({ plugins: [] })`);
    expect(await resolveInChild({ appDir: old, configPath: join(old, 'vite.config.ts') }))
      .toMatchObject({ ok: false, reason: 'vite_version_unsupported' });

    // Vite 5 is supported, and its CommonJS build exposes resolveConfig only
    // under `default`, which is the shape the resolver has to unwrap.
    const five = await viteFixture(
      '5.4.21',
      `export default { resolveConfig: async () => ({ plugins: [{ name: 'p' }] }) }`,
    );
    expect(await resolveInChild({ appDir: five, configPath: join(five, 'vite.config.ts') }))
      .toMatchObject({ ok: true, pluginNames: ['p'] });

    const unusable = await viteFixture('6.0.0', `export const value = 1`);
    expect(await resolveInChild({ appDir: unusable, configPath: join(unusable, 'vite.config.ts') }))
      .toMatchObject({ ok: false, reason: 'vite_not_usable' });

    const broken = await viteFixture('6.0.0', `export async function resolveConfig() { throw new Error('\\u001b[31mbroken config\\u001b[0m') }`);
    expect(await resolveInChild({ appDir: broken, configPath: join(broken, 'vite.config.ts') }))
      .toMatchObject({ ok: false, reason: 'vite_config_failed', error: 'broken config' });
  });
});

describe('resolveViteConfig', () => {
  it('handles a successful IPC result', async () => {
    const childEntry = fileURLToPath(
      new URL('./fixtures/vite-resolve-ok-child.mjs', import.meta.url),
    );
    await expect(resolveViteConfig({
      appDir: process.cwd(),
      configPath: 'vite.config.ts',
      childEntry,
      timeoutMs: 1_000,
    })).resolves.toEqual({
      ok: true,
      pluginNames: ['fixture-plugin', process.cwd()],
    });
  });

  it('escalates a trapped SIGTERM and waits for exit before timing out', async () => {
    const childEntry = fileURLToPath(
      new URL('./fixtures/vite-resolve-hang-child.mjs', import.meta.url),
    );
    const started = Date.now();
    await expect(resolveViteConfig({
      appDir: process.cwd(),
      configPath: 'vite.config.ts',
      childEntry,
      timeoutMs: 100,
      killGraceMs: 50,
    })).resolves.toEqual({ ok: false, reason: 'vite_resolve_timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });
});

it('removes only credential environment variables', () => {
  expect(sanitizeChildEnv({
    PATH: '/bin',
    OPSLANE_API_KEY: 'secret',
    ANTHROPIC_API_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    NPM_TOKEN: 'secret',
    VITE_PUBLIC_SETTING: 'keep',
  })).toEqual({
    PATH: '/bin',
    VITE_PUBLIC_SETTING: 'keep',
  });
});
