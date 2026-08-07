import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AREAS, classify, areasFor, parsePaths } from '../ci-changed-areas.mjs';

const CLI = fileURLToPath(new URL('../ci-changed-areas.mjs', import.meta.url));

const all = () => Object.fromEntries(AREAS.map((a) => [a, true]));
const none = () => Object.fromEntries(AREAS.map((a) => [a, false]));
const jsOnly = () => ({ ...none(), js: true });

// --- fail-closed defaults ---

test('an unrecognised path turns every area on', () => {
  assert.deepEqual(areasFor(['some-new-toplevel-thing/file.txt']), all());
});

test('an empty file list turns every area on', () => {
  // No detected changes means the diff computation is wrong, not that there
  // is nothing to test.
  assert.deepEqual(areasFor([]), all());
});

test('source, tests, fixtures, scripts, and lockfiles all turn every area on', () => {
  for (const path of [
    'packages/ingestion/handler/routes.go',
    'packages/worker/src/index.ts',
    'packages/dashboard/src/App.vue',
    'packages/sdk/src/core.ts',
    'packages/sdk-python/src/opslane/__init__.py',
    'packages/test-reliability/src/system.ts',
    'shared/src/contracts.ts',
    'cli/src/init.ts',
    'test-e2e/browser-smoke.test.ts',
    'test-fixtures/wire/events/v1.2.0-full.json',
    'scripts/run-migrations.sh',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.nvmrc',
    'docker-compose.yml',
    'LICENSE',
  ]) {
    assert.deepEqual(areasFor([path]), all(), path);
  }
});

// --- the two narrow inert cases ---

test('ci.yml itself turns every area on', () => {
  assert.deepEqual(areasFor(['.github/workflows/ci.yml']), all());
});

test('other workflow files turn no area on', () => {
  assert.deepEqual(areasFor(['.github/workflows/release-npm.yml']), none());
  assert.deepEqual(areasFor(['.github/dependabot.yml']), none());
  assert.deepEqual(areasFor(['.github/CLA.md']), none());
});

test('executable or unknown .github paths turn every area on', () => {
  assert.deepEqual(areasFor(['.github/actions/example/action.yml']), all());
  assert.deepEqual(areasFor(['.github/workflows/helpers/build.mjs']), all());
  assert.deepEqual(areasFor(['.github/new-metadata.yml']), all());
});

test('docs and docs-site turn on js only, because docs-site builds ../docs', () => {
  assert.deepEqual(areasFor(['docs/install.md']), jsOnly());
  assert.deepEqual(areasFor(['docs/contracts/events.md']), jsOnly());
  assert.deepEqual(areasFor(['docs/images/architecture.png']), jsOnly());
  assert.deepEqual(areasFor(['docs-site/src/pages/index.astro']), jsOnly());
});

test('an executable file under docs/ is NOT prose and turns every area on', () => {
  // docs/ holds only .md and .png today. The docs rule matches by extension so
  // a tool added there later fails closed instead of being silently inert.
  assert.deepEqual(areasFor(['docs/tools/gen.mjs']), all());
  assert.deepEqual(areasFor(['docs/deploy.sh']), all());
  assert.equal(classify('docs/tools/gen.mjs'), 'UNKNOWN');
});

test('top-level markdown turns on js only', () => {
  assert.deepEqual(areasFor(['README.md']), jsOnly());
  assert.deepEqual(areasFor(['AGENTS.md']), jsOnly());
});

test('markdown nested inside a package is NOT treated as prose', () => {
  // packages/sdk-python/README.md is the wheel's long_description and
  // `twine check --strict` reads it; a nested README is not safely inert.
  assert.deepEqual(areasFor(['packages/sdk-python/README.md']), all());
  assert.deepEqual(areasFor(['packages/ingestion/README.md']), all());
});

// --- union behaviour ---

test('areas union across files', () => {
  assert.deepEqual(areasFor(['docs/install.md', '.github/workflows/release-npm.yml']), jsOnly());
});

test('one unrecognised file poisons an otherwise inert diff', () => {
  assert.deepEqual(areasFor(['docs/install.md', 'weird-new-file']), all());
  assert.deepEqual(areasFor(['.github/dependabot.yml', 'packages/worker/src/x.ts']), all());
});

// --- first-match-wins: every rule is reachable and ordered correctly ---

test('classify returns each tag, proving every rule is reachable', () => {
  assert.equal(classify('.github/workflows/ci.yml'), 'global');
  assert.equal(classify('.github/workflows/release-pypi.yml'), 'meta');
  assert.equal(classify('docs/install.md'), 'docs');
  assert.equal(classify('docs-site/astro.config.mjs'), 'docs-site');
  assert.equal(classify('README.md'), 'root-doc');
  assert.equal(classify('packages/worker/src/index.ts'), 'UNKNOWN');
});

test('ci.yml is matched by the global rule before the .github rule', () => {
  assert.notEqual(classify('.github/workflows/ci.yml'), 'meta');
});

test('the .yaml spelling of the gate file is still global, not inert meta', () => {
  assert.equal(classify('.github/workflows/ci.yaml'), 'global');
  assert.deepEqual(areasFor(['.github/workflows/ci.yaml']), all());
});

// --- input parsing ---

test('parsePaths splits NUL-separated input and drops the trailing empty', () => {
  assert.deepEqual(parsePaths('a.txt\0b/c.txt\0'), ['a.txt', 'b/c.txt']);
  assert.deepEqual(parsePaths(''), []);
});

test('parsePaths keeps paths containing spaces intact', () => {
  assert.deepEqual(parsePaths('docs/a b.md\0'), ['docs/a b.md']);
});

// --- the CLI wrapper: its stdout IS $GITHUB_OUTPUT ---

const runCli = (stdin) => execFileSync(process.execPath, [CLI], { input: stdin, encoding: 'utf8' });

test('CLI emits exactly one area=value line per area, in AREAS order', () => {
  assert.equal(runCli('docs/install.md\0'), 'go=false\njs=true\npython=false\ne2e=false\nreliability=false\n');
});

test('CLI emits every area true for an unrecognised path', () => {
  assert.equal(runCli('packages/worker/src/index.ts\0'), AREAS.map((a) => `${a}=true`).join('\n') + '\n');
});

test('CLI emits every area true for empty stdin, not an empty output', () => {
  // An empty $GITHUB_OUTPUT would leave every `needs.changes.outputs.*` unset,
  // which check-ci-ok.mjs rejects -- but failing open here would be worse.
  assert.equal(runCli(''), AREAS.map((a) => `${a}=true`).join('\n') + '\n');
});

test('CLI cannot inject extra lines into $GITHUB_OUTPUT via a crafted filename', () => {
  // Per-path classification goes to stderr; only area=value reaches stdout.
  // The name is also not prose (it does not end in .md), so it fails closed.
  const hostile = 'docs/x.md\ngo=true\nreliability=true\0';
  assert.equal(runCli(hostile), AREAS.map((a) => `${a}=true`).join('\n') + '\n');
});

test('a filename with a trailing newline after .md is not treated as prose', () => {
  // JS `$` also matches before a trailing newline, so PROSE is lookahead-anchored.
  assert.deepEqual(areasFor(['docs/x.md\n']), all());
});
