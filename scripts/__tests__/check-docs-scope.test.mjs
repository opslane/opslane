import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkDocsScope,
  parseLoaderAllowlist,
  parseSidebarSlugs,
} from '../check-docs-scope.mjs';
import { MANUAL_DOC_COVERS, PUBLISHED_DOCS_POLICY } from '../docs-map.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_SOURCE = readFileSync(
  join(ROOT, 'docs-site/src/loaders/repo-docs.ts'),
  'utf8',
);
const SIDEBAR_SOURCE = readFileSync(join(ROOT, 'docs-site/astro.config.mjs'), 'utf8');

test('parses the loader allowlist and sidebar from their authoritative sources', () => {
  assert.deepEqual(parseLoaderAllowlist(LOADER_SOURCE), {
    files: ['install.md'],
    directories: ['quickstart', 'guides', 'reference', 'architecture', 'contracts'],
  });
  assert.ok(parseSidebarSlugs(SIDEBAR_SOURCE).includes('contracts/c4-amendments'));
});

test('real docs tree has explicit policy coverage', () => {
  const result = checkDocsScope({ root: ROOT });

  assert.deepEqual(result.problems, []);
  assert.equal(result.published.length, 32);
  assert.equal(result.navigable.length, parseSidebarSlugs(SIDEBAR_SOURCE).length);
  assert.equal(result.policies.get('docs/contracts/events.md'), 'manual');
});

test('allows a published page to be intentionally absent from navigation', () => {
  const sidebarWithoutEvents = SIDEBAR_SOURCE.replace(
    /^.*slug: 'contracts\/events'.*\n/m,
    '',
  );
  const result = checkDocsScope({ root: ROOT, sidebarSource: sidebarWithoutEvents });

  assert.deepEqual(result.problems, []);
  assert.equal(result.published.includes('docs/contracts/events.md'), true);
  assert.equal(result.navigable.includes('contracts/events'), false);
});

test('fails when the published events contract loses its explicit policy', () => {
  const policyWithoutEvents = {
    ...PUBLISHED_DOCS_POLICY,
    manual: PUBLISHED_DOCS_POLICY.manual.filter(
      (path) => path !== 'docs/contracts/events.md',
    ),
  };
  const result = checkDocsScope({ root: ROOT, policy: policyWithoutEvents });

  assert.ok(
    result.problems.includes('docs/contracts/events.md is published but has no declared policy'),
  );
});

test('fails when a manual contract loses its deterministic staleness mapping', () => {
  const { ['docs/contracts/events.md']: _events, ...manualMappings } = MANUAL_DOC_COVERS;
  const result = checkDocsScope({ root: ROOT, manualMappings });

  assert.ok(
    result.problems.includes(
      'docs/contracts/events.md is manual but has no deterministic staleness mapping',
    ),
  );
});

test('fails when sidebar navigation points at a non-published page', () => {
  const danglingSidebar = SIDEBAR_SOURCE.replace(
    'sidebar: [',
    "sidebar: [{ label: 'Missing', slug: 'guides/missing' },",
  );
  const result = checkDocsScope({ root: ROOT, sidebarSource: danglingSidebar });

  assert.ok(
    result.problems.includes(
      'sidebar slug does not resolve to a loader-published page: guides/missing',
    ),
  );
});

test('new loader-allowed content enters P instead of being hidden by a duplicate list', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'docs-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/new-public'), { recursive: true });
  writeFileSync(join(root, 'docs/install.md'), '# Install');
  writeFileSync(join(root, 'docs/new-public/page.md'), '# New page');

  const loaderSource = LOADER_SOURCE.replace(
    "'contracts',",
    "'contracts',\n  'new-public',",
  );
  const result = checkDocsScope({
    root,
    loaderSource,
    sidebarSource: 'export default { sidebar: [] };',
    // Injected like every other source here: this root is a bare docs tree with
    // no scripts/ directory to read a manifest from.
    snippetManifest: { version: 1, documents: { 'docs/install.md': { fences: [] } } },
    policy: {
      prose: ['docs/install.md'],
      deterministic: [],
      manual: [],
      excluded: [],
    },
  });

  assert.ok(result.published.includes('docs/new-public/page.md'));
  assert.ok(
    result.problems.includes('docs/new-public/page.md is published but has no declared policy'),
  );
});

// The snippet contract used to be checked only when docs-sync happened to
// target a page, so a guide could be added -- or gain a fence -- and stay
// broken for many merges. These pin both halves at repo-check time.
test('flags a published setup doc with no snippet-manifest entry', () => {
  const manifest = { version: 1, documents: {} };
  const result = checkDocsScope({ root: ROOT, snippetManifest: manifest });

  assert.ok(
    result.problems.some((problem) =>
      problem.startsWith('docs/guides/source-maps.md:')
      && problem.includes('not classified'),
    ),
    `expected an undeclared-setup-doc problem, got ${JSON.stringify(result.problems)}`,
  );
});

test('flags a snippet-manifest entry whose fence count has drifted', () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'scripts/docs-sync/snippets.json'), 'utf8'),
  );
  manifest.documents['docs/guides/source-maps.md'].fences.pop();
  const result = checkDocsScope({ root: ROOT, snippetManifest: manifest });

  assert.ok(
    result.problems.some((problem) =>
      problem.includes('docs/guides/source-maps.md')
      && problem.includes('count mismatch'),
    ),
    `expected a fence-count problem, got ${JSON.stringify(result.problems)}`,
  );
});

test('flags a snippet-manifest entry for a page that is not published', () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'scripts/docs-sync/snippets.json'), 'utf8'),
  );
  manifest.documents['docs/guides/does-not-exist.md'] = { fences: [] };
  const result = checkDocsScope({ root: ROOT, snippetManifest: manifest });

  assert.ok(
    result.problems.includes(
      'docs/guides/does-not-exist.md has a snippet-manifest entry but is not a published page',
    ),
    `expected an unpublished-entry problem, got ${JSON.stringify(result.problems)}`,
  );
});
