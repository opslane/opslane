// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The published surface that external tooling installs against.
 *
 * Everything else in this suite imports the TypeScript source. That misses the
 * failure the installer actually hits: a name or export that exists in source
 * but never reaches `dist/`, or reaches it under a different shape. The
 * installer only ever sees the built entry named in `exports`, so this file
 * resolves that entry the same way a consumer would and asserts the contract
 * it depends on. A break here is a silent 100%-failure at install time, not a
 * type error, so it has to be caught by a test rather than by `tsc`.
 */
const packageRoot = resolve(__dirname, '../..');

function builtEntry(): string {
  const pkg = JSON.parse(
    readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
  ) as { exports?: Record<string, { import?: string }> };
  const declared = pkg.exports?.['./vite-plugin']?.import;
  if (!declared) {
    throw new Error('package.json must declare an exports["./vite-plugin"].import');
  }
  return resolve(packageRoot, declared);
}

describe('built @opslane/sdk/vite-plugin contract', () => {
  let entry: string;

  beforeAll(() => {
    entry = builtEntry();
    if (!existsSync(entry)) {
      execFileSync('pnpm', ['build'], { cwd: packageRoot, stdio: 'inherit' });
    }
  }, 180_000);

  it('ships the entry that package.json promises', () => {
    expect(existsSync(entry)).toBe(true);
  });

  it('exports the plugin name as a value, not just a literal in source', async () => {
    const mod = await import(entry);
    expect(mod.OPSLANE_VITE_PLUGIN_NAME).toBe('opslane-debug-ids');
    expect(mod.LEGACY_VITE_PLUGIN_NAME).toBe('opslane-source-map');
    // The two must stay distinct. Sharing a name would make the working plugin
    // and the throwing stub indistinguishable in a resolved plugin list.
    expect(mod.OPSLANE_VITE_PLUGIN_NAME).not.toBe(mod.LEGACY_VITE_PLUGIN_NAME);
  });

  it('registers under exactly the exported name', async () => {
    const mod = await import(entry);
    expect(mod.opslane().name).toBe(mod.OPSLANE_VITE_PLUGIN_NAME);
    expect(mod.opslaneVitePlugin().name).toBe(mod.OPSLANE_VITE_PLUGIN_NAME);
  });

  // Tooling matches on the imported identifier to tell the current plugin from
  // the deprecated one. Both spellings are public and both must be accepted.
  it('offers both factory names, callable with no arguments', async () => {
    const mod = await import(entry);
    for (const name of ['opslane', 'opslaneVitePlugin']) {
      expect(typeof mod[name], `${name} must be exported`).toBe('function');
      expect(() => mod[name]()).not.toThrow();
    }
    expect(mod.opslane).toBe(mod.opslaneVitePlugin);
  });

  // Constructing it is fine; the build must die at configResolved. Asserting
  // the hook rather than the factory keeps this honest about where it fails.
  it('keeps the deprecated uploader failing loudly rather than silently', async () => {
    const mod = await import(entry);
    const legacy = mod.opslaneSourceMapPlugin({
      endpoint: 'https://example.com',
      apiKey: 'opslane_sk_x',
    });
    expect(legacy.name).toBe(mod.LEGACY_VITE_PLUGIN_NAME);
    expect(() => legacy.configResolved()).toThrow(
      /source-map upload is unavailable/,
    );
  });
});
