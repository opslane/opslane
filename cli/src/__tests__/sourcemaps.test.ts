import { describe, expect, it, vi } from 'vitest';

import type { AgentStatus } from '../contract.js';
import {
  runSourcemapsCommand,
  type SourcemapsCommandDeps,
} from '../sourcemaps.js';
import type {
  ViteTransactionOptions,
  ViteTransactionResult,
} from '../codemods/vite-transaction.js';

function harness(results: ViteTransactionResult[]) {
  const calls: ViteTransactionOptions[] = [];
  const emitted: Array<{ status: AgentStatus; data: Record<string, unknown>; code: number }> = [];
  const shown: string[] = [];
  let index = 0;
  const deps: SourcemapsCommandDeps = {
    cwd: '/repo',
    transaction: async (options) => {
      calls.push(options);
      return results[index++] ?? results.at(-1)!;
    },
    exit: (status, data, code) => emitted.push({ status, data, code }),
    show: (message) => shown.push(message),
  };
  return { deps, calls, emitted, shown };
}

const proposal: ViteTransactionResult = {
  status: 'consent_required',
  file: 'vite.config.ts',
  diff: '+ plugin',
  disclosure: 'source is readable',
  warnings: ['This config already has uncommitted changes.', 'build.sourcemap is overridden.'],
};

describe('sourcemaps install-plugin command', () => {
  it('rejects write and check modes together', async () => {
    const h = harness([]);
    await runSourcemapsCommand({ yes: true, check: true }, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.emitted).toMatchObject([{ status: 'usage_error', code: 1 }]);
  });

  it('prints one consent-required document and writes nothing without a TTY', async () => {
    const h = harness([proposal]);
    h.deps.isTTY = false;
    await runSourcemapsCommand({}, h.deps);
    expect(h.calls).toEqual([{ repoRoot: '/repo' }]);
    expect(h.emitted).toEqual([{
      status: 'consent_required',
      code: 1,
      data: {
        file: 'vite.config.ts',
        diff: '+ plugin',
        disclosure: 'source is readable',
        warnings: proposal.warnings,
      },
    }]);
  });

  it('--yes applies directly and emits one JSON-shaped result', async () => {
    const h = harness([{
      status: 'edited',
      file: 'apps/web/vite.config.ts',
      disclosure: 'source is readable',
    }]);
    await runSourcemapsCommand({ yes: true, appDir: 'apps/web' }, h.deps);
    expect(h.calls).toEqual([{ repoRoot: '/repo', appDir: 'apps/web', apply: true }]);
    expect(h.emitted).toMatchObject([{ status: 'edited', code: 0 }]);
  });

  it('--check never requests an apply transaction and exits 1 when absent', async () => {
    const h = harness([{ status: 'vite_plugin_not_registered', file: 'vite.config.ts' }]);
    await runSourcemapsCommand({ check: true }, h.deps);
    expect(h.calls).toEqual([{ repoRoot: '/repo', check: true }]);
    expect(h.emitted).toMatchObject([{ status: 'vite_plugin_not_registered', code: 1 }]);
  });

  it('shows both warnings before interactive consent and then applies', async () => {
    const h = harness([proposal, { status: 'edited', file: 'vite.config.ts' }]);
    h.deps.isTTY = true;
    h.deps.confirm = vi.fn().mockResolvedValue(true);
    await runSourcemapsCommand({}, h.deps);
    expect(h.shown[0]).toContain('uncommitted changes');
    expect(h.shown[0]).toContain('build.sourcemap');
    expect(h.calls.at(-1)).toEqual({
      repoRoot: '/repo',
      apply: true,
      expectedDiff: '+ plugin',
    });
    expect(h.emitted).toMatchObject([{ status: 'edited', code: 0 }]);
  });

  it('moves a suggested insertion, previews it, and binds consent to that diff', async () => {
    const suggested: ViteTransactionResult = {
      ...proposal,
      suggestion: {
        insertOffset: 40,
        line: 4,
        preview: ['plugins: [', '  react(),', '  fixturePlugin(),', '].filter(Boolean)'],
      },
    };
    const moved: ViteTransactionResult = {
      ...suggested,
      diff: '+ moved plugin',
      suggestion: {
        ...suggested.suggestion!,
        insertOffset: 25,
        line: 3,
      },
    };
    const h = harness([suggested, moved, { status: 'edited', file: 'vite.config.ts' }]);
    h.deps.isTTY = true;
    h.deps.chooseSuggestion = vi.fn().mockResolvedValue({ action: 'move', line: 3 });
    h.deps.confirm = vi.fn().mockResolvedValue(true);
    await runSourcemapsCommand({}, h.deps);
    expect(h.calls).toEqual([
      { repoRoot: '/repo' },
      { repoRoot: '/repo', suggestionLine: 3 },
      {
        repoRoot: '/repo',
        apply: true,
        expectedDiff: '+ moved plugin',
        suggestionLine: 3,
      },
    ]);
    expect(h.shown.some((message) => message.includes('we would add it here'))).toBe(true);
    expect(h.emitted).toMatchObject([{ status: 'edited', code: 0 }]);
  });

  it('includes manual completion guidance in an unsupported JSON result', async () => {
    const h = harness([{
      status: 'unsupported',
      file: 'vite.config.ts',
      reason: 'plugins_not_array',
    }]);
    await runSourcemapsCommand({ json: true }, h.deps);
    expect(h.emitted[0]?.data.message).toContain(
      'opslane sourcemaps install-plugin --check',
    );
  });
});
