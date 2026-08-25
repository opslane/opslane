import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Definition, Image, Link, Root } from 'mdast';
import { unified } from 'unified';
import { expect, it } from 'vitest';

import remarkRepoLinks from '../remark-repo-links';

function touch(root: string, relativePath: string) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, 'fixture');
  return target;
}

function link(url: string): Link {
  return { type: 'link', url, children: [{ type: 'text', value: url }] };
}

function definition(url: string): Definition {
  return { type: 'definition', identifier: 'reference', url };
}

function image(url: string): Image {
  return { type: 'image', url, alt: url };
}

it('rewrites public docs to routes and other repository files to GitHub', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'opslane-docs-'));
  const sourcePath = touch(repoRoot, 'docs/guides/react.md');
  touch(repoRoot, 'docs/architecture/trust.md');
  touch(repoRoot, 'docs/plans/internal.md');
  touch(repoRoot, 'packages/sdk/README.md');
  touch(repoRoot, 'scripts/check-docs-drift.mjs');

  const links = [
    link('../architecture/trust.md?view=full#masking'),
    link('../plans/internal.md'),
    link('../../packages/sdk/README.md#install'),
    link('../../scripts/check-docs-drift.mjs?raw=1'),
    definition('../architecture/trust.md#masking'),
    link('#same-page'),
    link('https://example.com/docs.md'),
  ];
  const tree: Root = { type: 'root', children: links };

  unified().use(remarkRepoLinks, { repoRoot }).runSync(tree, { path: sourcePath });

  expect(links.map((node) => node.url)).toEqual([
    '/architecture/trust/?view=full#masking',
    'https://github.com/opslane/opslane/blob/main/docs/plans/internal.md',
    'https://github.com/opslane/opslane/blob/main/packages/sdk/README.md#install',
    'https://github.com/opslane/opslane/blob/main/scripts/check-docs-drift.mjs?raw=1',
    '/architecture/trust/#masking',
    '#same-page',
    'https://example.com/docs.md',
  ]);
});

it('rewrites repository images to the raw host so excluded assets never enter the build', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'opslane-docs-'));
  const sourcePath = touch(repoRoot, 'docs/guides/react.md');
  touch(repoRoot, 'docs/evidence/issue-54/diagram.png');
  touch(repoRoot, 'docs/architecture/trust.md');

  const images = [image('../evidence/issue-54/diagram.png'), image('../architecture/trust.md')];
  const tree: Root = { type: 'root', children: images };

  unified().use(remarkRepoLinks, { repoRoot }).runSync(tree, { path: sourcePath });

  expect(images.map((node) => node.url)).toEqual([
    'https://raw.githubusercontent.com/opslane/opslane/main/docs/evidence/issue-54/diagram.png',
    'https://raw.githubusercontent.com/opslane/opslane/main/docs/architecture/trust.md',
  ]);
});

it('leaves links alone when the target escapes the repo root, is missing, or is a directory', () => {
  const outer = mkdtempSync(path.join(tmpdir(), 'opslane-docs-'));
  const repoRoot = path.join(outer, 'repo');
  const sourcePath = touch(repoRoot, 'docs/guides/react.md');
  touch(outer, 'outside.md');
  mkdirSync(path.join(repoRoot, 'docs/architecture'), { recursive: true });

  const links = [
    link('../../../outside.md'), // exists, but escapes the repo root
    link('../missing.md'), // does not exist
    link('../architecture'), // exists, but is a directory
  ];
  const tree: Root = { type: 'root', children: links };

  unified().use(remarkRepoLinks, { repoRoot }).runSync(tree, { path: sourcePath });

  expect(links.map((node) => node.url)).toEqual([
    '../../../outside.md',
    '../missing.md',
    '../architecture',
  ]);
});

it('leaves malformed percent-encoded links alone instead of throwing', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'opslane-docs-'));
  const sourcePath = touch(repoRoot, 'docs/guides/react.md');

  const malformed = link('%ZZ%.md');
  const tree: Root = { type: 'root', children: [malformed] };

  expect(() =>
    unified().use(remarkRepoLinks, { repoRoot }).runSync(tree, { path: sourcePath }),
  ).not.toThrow();
  expect(malformed.url).toBe('%ZZ%.md');
});
