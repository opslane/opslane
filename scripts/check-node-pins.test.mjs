import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkNodePins } from './check-node-pins.mjs';

// Writes the given files into a fresh git repo in a temp dir, runs fn against
// it, cleans up. Paths under `ignored` are written but listed in .gitignore.
function withFixture(files, fn, { ignored = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'node-pins-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    if (ignored.length > 0) writeFileSync(join(root, '.gitignore'), ignored.join('\n') + '\n');
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const AGREEING = { '.nvmrc': '22.23.2\n', 'docs-site/.nvmrc': '22.23.2' };

test('passes when the required pins exist and match the root', () => {
  withFixture(AGREEING, (root) => {
    assert.deepEqual(checkNodePins(root), { rootPin: '22.23.2', problems: [] });
  });
});

test('reports a nested .nvmrc or .node-version that drifts from the root pin', () => {
  withFixture({ ...AGREEING, 'docs-site/.nvmrc': '22.22.2\n', 'tools/.node-version': '24.0.0' }, (root) => {
    assert.deepEqual(checkNodePins(root).problems, [
      'docs-site/.nvmrc pins Node 22.22.2; root .nvmrc pins 22.23.2',
      'tools/.node-version pins Node 24.0.0; root .nvmrc pins 22.23.2',
    ]);
  });
});

test('reports the docs-site pin missing, which is the state that broke the Pages deploy', () => {
  withFixture({ '.nvmrc': '22.23.2', 'docs-site/package.json': '{}' }, (root) => {
    assert.deepEqual(checkNodePins(root).problems, [
      'docs-site/.nvmrc is missing; Cloudflare Pages reads it from that folder',
    ]);
  });
});

test('reports a missing root .nvmrc instead of throwing', () => {
  withFixture({ 'docs-site/.nvmrc': '22.23.2' }, (root) => {
    assert.deepEqual(checkNodePins(root), { rootPin: null, problems: ['root .nvmrc is missing'] });
  });
});

test('rejects ranges, aliases, and empty pins even when both files agree', () => {
  withFixture({ '.nvmrc': '22\n', 'docs-site/.nvmrc': '22' }, (root) => {
    assert.deepEqual(checkNodePins(root).problems, [
      '.nvmrc must pin an exact Node release like 22.23.2, got "22"',
    ]);
  });
  withFixture({ '.nvmrc': '22.23.2', 'docs-site/.nvmrc': 'lts/*' }, (root) => {
    assert.deepEqual(checkNodePins(root).problems, [
      'docs-site/.nvmrc must pin an exact Node release like 22.23.2, got "lts/*"',
    ]);
  });
});

test('ignores pins in gitignored local state such as sibling worktrees or data dirs', () => {
  withFixture(
    { ...AGREEING, '.worktrees/other/.nvmrc': '20.0.0', 'pgdata/.nvmrc': '20.0.0', 'node_modules/dep/.nvmrc': '18' },
    (root) => assert.deepEqual(checkNodePins(root).problems, []),
    { ignored: ['.worktrees/', 'pgdata/', 'node_modules/'] }
  );
});

test('an untracked but not ignored pin is checked, since a commit would ship it', () => {
  withFixture({ ...AGREEING, 'examples/app/.nvmrc': '20.0.0' }, (root) => {
    assert.deepEqual(checkNodePins(root).problems, [
      'examples/app/.nvmrc pins Node 20.0.0; root .nvmrc pins 22.23.2',
    ]);
  });
});

test('a required pin that is a symlink or directory does not count', (t) => {
  withFixture({ '.nvmrc': '22.23.2' }, (root) => {
    mkdirSync(join(root, 'docs-site'));
    try {
      symlinkSync('../.nvmrc', join(root, 'docs-site/.nvmrc'));
    } catch (err) {
      if (err.code === 'EPERM') return t.skip('symlinks need elevated rights on this platform');
      throw err;
    }
    assert.deepEqual(checkNodePins(root).problems, [
      'docs-site/.nvmrc must be a regular file, not a symlink or directory',
    ]);
  });
});

test('the repo itself passes', () => {
  assert.deepEqual(checkNodePins(fileURLToPath(new URL('..', import.meta.url))).problems, []);
});
