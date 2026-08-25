#!/usr/bin/env node
// Verifies that published docs, navigation, and docs-sync policy stay aligned.
// The loader and sidebar source files are parsed directly so neither public set
// is silently duplicated in this script.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isSetupDoc,
  loadSnippetManifest,
  parseMarkdownFences,
  validateSnippetContract,
} from './docs-sync/validation.mjs';
import {
  MANUAL_DOC_COVERS,
  PUBLISHED_DOCS_POLICY,
  docTypeOf,
  isProseTierDoc,
  publishedPoliciesFor,
} from './docs-map.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_NAMES = new Set(['prose', 'deterministic', 'manual', 'excluded']);

function declarationStrings(source, identifier) {
  const expression = new RegExp(
    `const\\s+${identifier}\\s*=\\s*(?:new\\s+Set\\s*\\()?\\s*\\[([\\s\\S]*?)\\]\\s*\\)?\\s*;`,
  );
  const body = source.match(expression)?.[1];
  if (body === undefined) {
    throw new Error(`could not parse ${identifier} from docs loader source`);
  }

  const strings = [...body.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
  const unexplained = body
    .replace(/(['"])(.*?)\1/g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/[\s,]/g, '');
  if (unexplained || strings.length === 0) {
    throw new Error(`${identifier} must remain a non-empty literal string list`);
  }
  return strings;
}

export function parseLoaderAllowlist(source) {
  if (typeof source !== 'string') throw new TypeError('loader source must be a string');
  return {
    files: declarationStrings(source, 'PUBLIC_DOCS_FILES'),
  };
}

export function parseSidebarSlugs(source) {
  if (typeof source !== 'string') throw new TypeError('sidebar source must be a string');
  if (!/\bsidebar\s*:/.test(source)) throw new Error('could not find sidebar configuration');

  // Only slugs inside the sidebar array count. Other integrations declare
  // their own `slug:` keys (the llms-txt custom sets, for one), and treating
  // those as navigation entries reports a page that was never claimed.
  const start = source.search(/\bsidebar\s*:\s*\[/);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('[', start); i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const sidebarBlock = source.slice(start, end);

  return [...sidebarBlock.matchAll(/\bslug\s*:\s*(['"])(.*?)\1/g)].map((match) => match[2]);
}

function* walkMarkdown(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(absolute);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield absolute;
  }
}

function isLoaderAllowed(path, allowlist) {
  return allowlist.files.includes(path);
}

function canonicalSlug(path) {
  return path
    .replace(/\.md$/, '')
    .split('/')
    .map((segment) =>
      segment
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
    )
    .join('/');
}

export function publishedDocs(root, loaderSource) {
  const allowlist = parseLoaderAllowlist(loaderSource);
  const docsRoot = join(root, 'docs');
  return [...walkMarkdown(docsRoot)]
    .map((absolute) => relative(docsRoot, absolute).split(sep).join('/'))
    .filter((path) => isLoaderAllowed(path, allowlist))
    .map((path) => `docs/${path}`)
    .sort();
}

function readDoc(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

export function checkDocsScope({
  root = DEFAULT_ROOT,
  policy = PUBLISHED_DOCS_POLICY,
  manualMappings = MANUAL_DOC_COVERS,
  loaderSource = readFileSync(join(root, 'docs-site/src/loaders/repo-docs.ts'), 'utf8'),
  sidebarSource = readFileSync(join(root, 'docs-site/astro.config.mjs'), 'utf8'),
  snippetManifest = loadSnippetManifest(join(root, 'scripts/docs-sync/snippets.json')),
} = {}) {
  const problems = [];
  const published = publishedDocs(root, loaderSource);
  const navigable = parseSidebarSlugs(sidebarSource);
  const publishedSlugs = new Map(
    published.map((path) => [canonicalSlug(path.slice('docs/'.length)), path]),
  );
  const policies = new Map();

  for (const name of Object.keys(policy)) {
    if (!POLICY_NAMES.has(name)) problems.push(`unknown published-doc policy: ${name}`);
  }
  for (const name of POLICY_NAMES) {
    if (!Array.isArray(policy[name])) problems.push(`published-doc policy ${name} must be a list`);
  }

  for (const path of published) {
    const matches = publishedPoliciesFor(path, policy);
    if (matches.length === 0) {
      problems.push(`${path} is published but has no declared policy`);
      continue;
    }
    if (matches.length > 1) {
      problems.push(`${path} has multiple declared policies: ${matches.join(', ')}`);
      continue;
    }

    const declared = matches[0];
    policies.set(path, declared);
    if (isProseTierDoc(path) !== (declared === 'prose')) {
      problems.push(`${path} prose policy disagrees with isProseTierDoc`);
    }
    if (/^docs\/reference\//.test(path) !== (declared === 'deterministic')) {
      problems.push(`${path} deterministic policy disagrees with the published reference set`);
    }
    if (docTypeOf(path) === 'contract' && declared !== 'manual') {
      problems.push(`${path} is a published contract and must have manual policy`);
    }
  }

  for (const name of ['manual', 'excluded']) {
    for (const path of policy[name] ?? []) {
      if (/[*?\[]/.test(path)) {
        problems.push(`${name} policy entries must name exact published pages: ${path}`);
      } else if (!published.includes(path)) {
        problems.push(`${name} policy names a page outside the loader-published set: ${path}`);
      }
    }
  }

  for (const path of policy.manual ?? []) {
    const covers = manualMappings[path];
    if (!Array.isArray(covers) || covers.length === 0) {
      problems.push(`${path} is manual but has no deterministic staleness mapping`);
    }
  }
  for (const path of Object.keys(manualMappings)) {
    if (published.includes(path) && !(policy.manual ?? []).includes(path)) {
      problems.push(`${path} has a manual staleness mapping but is not manual policy`);
    }
  }

  // Hold every published setup doc to the contract docs-sync will enforce on it
  // later. Both halves of that contract used to be invisible until a sync
  // happened to target the page, which can be many merges after it drifted: a
  // page added under docs/guides/ was never declared at all, and an edit that
  // added a fence to a declared page left the counts disagreeing. Running the
  // real validator here -- rather than re-deriving a weaker version of it --
  // means the two can never diverge.
  for (const path of published) {
    if (!isSetupDoc(path)) continue;
    try {
      validateSnippetContract(path, parseMarkdownFences(readDoc(root, path)), snippetManifest);
    } catch (error) {
      problems.push(`${path}: ${error.message}`);
    }
  }
  for (const path of Object.keys(snippetManifest.documents ?? {})) {
    if (!published.includes(path)) {
      problems.push(`${path} has a snippet-manifest entry but is not a published page`);
    } else if (!isSetupDoc(path)) {
      problems.push(`${path} has a snippet-manifest entry but is not setup documentation`);
    }
  }

  const seenSlugs = new Set();
  for (const slug of navigable) {
    if (seenSlugs.has(slug)) problems.push(`sidebar contains duplicate slug: ${slug}`);
    seenSlugs.add(slug);
    if (!publishedSlugs.has(slug)) {
      problems.push(`sidebar slug does not resolve to a loader-published page: ${slug}`);
    }
  }

  return { published, navigable, policies, problems };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = checkDocsScope();
  if (result.problems.length > 0) {
    console.error(`✗ docs scope integrity failed (${result.problems.length}):`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    const counts = Object.fromEntries(
      [...POLICY_NAMES].map((name) => [
        name,
        [...result.policies.values()].filter((policy) => policy === name).length,
      ]),
    );
    console.log(
      `✓ docs scope integrity: ${result.published.length} published, ${result.navigable.length} navigable; ` +
        `${counts.prose} prose, ${counts.deterministic} deterministic, ${counts.manual} manual, ${counts.excluded} excluded`,
    );
  }
}
