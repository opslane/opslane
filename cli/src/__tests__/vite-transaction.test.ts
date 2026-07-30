import {
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PluginContractDeps } from '../codemods/vite-contract.js';
import type { ViteResolveResult } from '../codemods/vite-resolve.js';
import {
  runViteTransaction,
  type ViteTransactionDeps,
} from '../codemods/vite-transaction.js';
import { addOpslanePlugin } from '../codemods/vite-sourcemaps.js';

const contract: PluginContractDeps = {
  specifier: 'fixture/plugin',
  exportName: 'fixturePlugin',
  pluginName: 'fixture-plugin',
  importLine: "import { fixturePlugin } from 'fixture/plugin';",
  callText: 'fixturePlugin()',
  minimumSdkVersion: '3.0.0',
};

async function fixture(source = `export default { plugins: [] }\n`): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opslane-vite-transaction-'));
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'vite.config.ts'), source);
  chmodSync(join(root, 'vite.config.ts'), 0o640);
  return root;
}

function deps(results: ViteResolveResult[]): ViteTransactionDeps {
  let index = 0;
  return {
    contract,
    discovery: {
      installedVersion: async (_dir, name) => name === 'vite' ? '6.4.3' : '3.0.0',
    },
    resolve: async () => results[index++] ?? results.at(-1)!,
    gitStatus: () => '',
    dirtyFiles: () => [],
  };
}

const clean: ViteResolveResult = { ok: true, pluginNames: [] };
const wired: ViteResolveResult = { ok: true, pluginNames: ['fixture-plugin'] };

describe('runViteTransaction', () => {
  it('returns a non-writing proposal before consent', async () => {
    const root = await fixture();
    const before = readFileSync(join(root, 'vite.config.ts'));
    const result = await runViteTransaction({ repoRoot: root }, deps([clean]));
    expect(result).toMatchObject({
      status: 'consent_required',
      file: 'vite.config.ts',
    });
    expect(result.diff).toContain("import { fixturePlugin } from 'fixture/plugin';");
    expect(result.disclosure).toContain('readable copy');
    expect(readFileSync(join(root, 'vite.config.ts')).equals(before)).toBe(true);
  });

  it('writes, rereads, resolves, and preserves permissions', async () => {
    const root = await fixture();
    const result = await runViteTransaction(
      { repoRoot: root, apply: true },
      deps([clean, wired]),
    );
    expect(result.status).toBe('edited');
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain('fixturePlugin()');
    expect(lstatSync(join(root, 'vite.config.ts')).mode & 0o777).toBe(0o640);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('check never writes and verifies the resolved plugin name', async () => {
    const root = await fixture();
    const before = readFileSync(join(root, 'vite.config.ts'));
    expect(await runViteTransaction(
      { repoRoot: root, check: true },
      deps([wired]),
    )).toMatchObject({ status: 'already_wired' });
    expect(readFileSync(join(root, 'vite.config.ts'))).toEqual(before);
  });

  it('stops before writing when the original config is broken', async () => {
    const root = await fixture();
    const before = readFileSync(join(root, 'vite.config.ts'));
    const result = await runViteTransaction(
      { repoRoot: root, apply: true },
      deps([{ ok: false, reason: 'vite_config_failed', error: 'already broken' }]),
    );
    expect(result.status).toBe('vite_config_broken_before_edit');
    expect(readFileSync(join(root, 'vite.config.ts'))).toEqual(before);
  });

  it.each([
    ['vite_plugin_not_registered', clean],
    ['vite_config_broken_after_edit', { ok: false, reason: 'vite_config_failed', error: 'boom' }],
    ['vite_config_resolve_timeout', { ok: false, reason: 'vite_resolve_timeout' }],
  ] as const)('restores bytes and mode after %s', async (status, post) => {
    const root = await fixture();
    const file = join(root, 'vite.config.ts');
    const before = readFileSync(file);
    const mode = lstatSync(file).mode;
    const result = await runViteTransaction(
      { repoRoot: root, apply: true },
      deps([clean, post as ViteResolveResult]),
    );
    expect(result.status).toBe(status);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(lstatSync(file).mode).toBe(mode);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('restores when re-read bytes or structure do not match', async () => {
    const root = await fixture();
    const file = join(root, 'vite.config.ts');
    const before = readFileSync(file);
    const injected = deps([clean, wired]);
    injected.writeAtomic = async (target) => {
      writeFileSync(target, 'not the proposed edit');
    };
    const result = await runViteTransaction({ repoRoot: root, apply: true }, injected);
    expect(result.status).toBe('vite_config_structure_mismatch');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('restores an edited file that no longer parses', async () => {
    const root = await fixture();
    const file = join(root, 'vite.config.ts');
    const before = readFileSync(file);
    const injected = deps([clean, wired]);
    let calls = 0;
    injected.codemod = (text, filename, policy) => {
      calls += 1;
      if (calls === 1) {
        return {
          outcome: 'edited',
          text: 'export default { plugins: [',
          insertOffset: 27,
          line: 1,
        };
      }
      return addOpslanePlugin(text, filename, policy);
    };
    const result = await runViteTransaction({ repoRoot: root, apply: true }, injected);
    expect(result.status).toBe('vite_config_parse_failed');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('does not overwrite a config changed while the baseline resolve ran', async () => {
    const root = await fixture();
    const file = join(root, 'vite.config.ts');
    const injected = deps([clean]);
    injected.resolve = async () => {
      writeFileSync(file, 'export default { plugins: [userChange()] }\n');
      return clean;
    };
    const result = await runViteTransaction({ repoRoot: root, apply: true }, injected);
    expect(result.status).toBe('config_changed_before_write');
    expect(readFileSync(file, 'utf8')).toContain('userChange()');
  });

  it('rolls back when another repository path changes', async () => {
    const root = await fixture();
    const file = join(root, 'vite.config.ts');
    const before = readFileSync(file);
    const statuses = ['', '', '', 'changed-other-path', ''];
    const injected = deps([clean, wired]);
    injected.gitStatus = () => statuses.shift() ?? '';
    const result = await runViteTransaction({ repoRoot: root, apply: true }, injected);
    expect(result.status).toBe('repo_changed_during_verification');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('reports restore failure loudly and writes a recovery copy', async () => {
    const root = await fixture();
    const file = join(root, 'vite.config.ts');
    const original = readFileSync(file);
    const injected = deps([clean, { ok: false, reason: 'vite_config_failed', error: 'boom' }]);
    injected.restore = () => 'vite.config.ts: injected restore failure';
    const result = await runViteTransaction({ repoRoot: root, apply: true }, injected);
    expect(result).toMatchObject({
      status: 'restore_failed',
      restoreFailures: ['vite.config.ts: injected restore failure'],
      recoveryPath: expect.stringMatching(
        /\/\.opslane-recovery\/vite\.config\.ts\.[0-9a-f-]+\.backup$/,
      ),
    });
    expect(result.recoveryPath).toBeDefined();
    expect(readFileSync(result.recoveryPath!).equals(original)).toBe(true);
    expect(readFileSync(file).equals(original)).toBe(false);
  });

  it('rolls back when post-edit resolution rejects', async () => {
    const root = await fixture();
    const file = join(root, 'vite.config.ts');
    const before = readFileSync(file);
    const injected = deps([clean]);
    let calls = 0;
    injected.resolve = async () => {
      calls += 1;
      if (calls === 1) return clean;
      throw new Error('resolver crashed');
    };
    const result = await runViteTransaction({ repoRoot: root, apply: true }, injected);
    expect(result).toMatchObject({
      status: 'vite_config_broken_after_edit',
      reason: 'resolver crashed',
    });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('rolls back when config execution mutates the selected config', async () => {
    const root = await fixture();
    const file = join(root, 'vite.config.ts');
    const before = readFileSync(file);
    const injected = deps([clean]);
    let calls = 0;
    injected.resolve = async () => {
      calls += 1;
      if (calls === 2) writeFileSync(file, 'export default { plugins: [] }\n');
      return calls === 1 ? clean : wired;
    };
    const result = await runViteTransaction({ repoRoot: root, apply: true }, injected);
    expect(result).toMatchObject({
      status: 'vite_config_structure_mismatch',
      reason: 'The config changed while Vite resolved it.',
    });
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
