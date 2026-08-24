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
    files: [
      'install.md',
      'how-it-works.md',
      'quickstart/self-host.md',
      'guides/friction.md',
      'guides/github-app.md',
      'guides/source-maps.md',
      'guides/environments.md',
      'guides/slack-notifications.md',
      'guides/replay-privacy.md',
      'guides/source-map-privacy.md',
      'guides/api-keys.md',
      'architecture/precision.md',
      'architecture/trust.md',
      'reference/sdk-options.md',
      'reference/http-routes.md',
      'reference/reason-codes.md',
      'reference/environment-variables.md',
    ],
  });
  assert.ok(parseSidebarSlugs(SIDEBAR_SOURCE).includes('how-it-works'));
});

test('real docs tree has explicit policy coverage', () => {
  const result = checkDocsScope({ root: ROOT });

  assert.deepEqual(result.problems, []);
  assert.equal(result.published.length, 17);
  assert.equal(result.navigable.length, parseSidebarSlugs(SIDEBAR_SOURCE).length);
  assert.equal(result.policies.get('docs/how-it-works.md'), 'excluded');
  assert.equal(result.published.includes('docs/contracts/events.md'), false);
});

test('allows a published page to be intentionally absent from navigation', () => {
  const sidebarWithoutFriction = SIDEBAR_SOURCE.replace(
    /^.*slug: 'guides\/friction'.*\n/m,
    '',
  );
  const result = checkDocsScope({ root: ROOT, sidebarSource: sidebarWithoutFriction });

  assert.deepEqual(result.problems, []);
  assert.equal(result.published.includes('docs/guides/friction.md'), true);
  assert.equal(result.navigable.includes('guides/friction'), false);
});

test('fails when a published reference page loses its explicit policy', () => {
  const policyWithoutReferences = {
    ...PUBLISHED_DOCS_POLICY,
    deterministic: [],
  };
  const result = checkDocsScope({ root: ROOT, policy: policyWithoutReferences });

  assert.ok(
    result.problems.includes('docs/reference/http-routes.md is published but has no declared policy'),
  );
});

test('allows contributor contracts to keep deterministic staleness mappings', () => {
  const result = checkDocsScope({ root: ROOT, manualMappings: MANUAL_DOC_COVERS });

  assert.deepEqual(result.problems, []);
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
    "'install.md',",
    "'install.md',\n  'new-public/page.md',",
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
