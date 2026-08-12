#!/usr/bin/env node
// Maps changed files to prose docs via covers: frontmatter.
// Pure + dependency-free (cf. check-docs-drift.mjs). No git calls.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PUBLISHED_DOCS_POLICY = Object.freeze({
  prose: Object.freeze([
    'docs/install.md',
    'docs/guides/**/*.md',
    'docs/quickstart/**/*.md',
    'docs/architecture/**/*.md',
  ]),
  deterministic: Object.freeze(['docs/reference/**/*.md']),
  manual: Object.freeze([
    'docs/contracts/C4-amendments.md',
    'docs/contracts/action-scope.md',
    'docs/contracts/events.md',
    'docs/contracts/reliability.md',
  ]),
  excluded: Object.freeze([]),
});

// Contracts remain human-maintained because their wording is normative. These
// mappings never send a contract to the LLM; they only surface a deterministic
// review reminder when code that can change the promise moves.
export const MANUAL_DOC_COVERS = Object.freeze({
  'docs/contracts/action-scope.md': Object.freeze([
    'packages/ingestion/db/queries.go',
    'packages/ingestion/db/environments.go',
    'packages/ingestion/db/migrations/048_job_event_anchor.sql',
    'packages/ingestion/db/migrations/049_action_scope.sql',
    'packages/ingestion/handler/read_api.go',
    'packages/worker/src/db.ts',
    'packages/worker/src/index.ts',
  ]),
  'docs/contracts/C4-amendments.md': Object.freeze([
    'packages/sdk/package.json',
    'packages/sdk/src/replay.ts',
    'packages/sdk/src/session.ts',
    'packages/sdk/src/chunk-upload.ts',
    'packages/ingestion/handler/session*.go',
    'packages/ingestion/handler/replay*.go',
    'packages/ingestion/handler/routes.go',
    'packages/ingestion/db/sessions*.go',
    'packages/ingestion/db/migrations/002_sessions.sql',
  ]),
  'docs/contracts/events.md': Object.freeze([
    'shared/src/types.ts',
    'packages/sdk/src/core.ts',
    'packages/sdk/src/debug-images.ts',
    'packages/sdk/src/transport.ts',
    'packages/sdk/src/__tests__/wire-shape.test.ts',
    'packages/ingestion/handler/error_event*.go',
    'packages/ingestion/handler/wire_compat_test.go',
    'test-fixtures/wire/events/**',
    'scripts/check-wire-fixtures.mjs',
    '.github/workflows/wire-fixtures.yml',
  ]),
  'docs/contracts/reliability.md': Object.freeze([
    'packages/test-reliability/**',
    'packages/worker/src/**',
    'packages/ingestion/db/**',
    'packages/ingestion/handler/**',
    'packages/ingestion/db/migrations/*job*.sql',
  ]),
});

function normalizePath(path) {
  if (typeof path !== 'string') return null;
  const normalized = path.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  return normalized || null;
}

export function isProseTierDoc(path) {
  const relative = normalizePath(path);
  if (!relative?.endsWith('.md')) return false;
  if (relative === 'docs/install.md') return true;
  return /^docs\/(guides|architecture|quickstart)\//.test(relative);
}

export function docTypeOf(path) {
  const relative = normalizePath(path);
  if (!relative?.endsWith('.md')) return null;
  if (
    relative === 'docs/install.md' ||
    /^docs\/(guides|quickstart)\//.test(relative)
  ) {
    return 'setup';
  }
  if (/^docs\/architecture\//.test(relative)) return 'internals';
  if (/^docs\/contracts\//.test(relative)) return 'contract';
  return null;
}

export function readCovers(source) {
  if (typeof source !== 'string') throw new TypeError('frontmatter source must be a string');

  const normalized = source.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return [];

  const lines = normalized.split('\n');
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end === -1) throw new Error('unterminated frontmatter');

  const frontmatter = lines.slice(1, end);
  const coversLines = frontmatter
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^covers:\s*/.test(line));
  if (coversLines.length === 0) return [];
  if (coversLines.length > 1) throw new Error('duplicate covers field');

  const { line, index } = coversLines[0];
  const inlineValue = line.slice(line.indexOf(':') + 1).trim();
  if (inlineValue === '[]') throw new Error('empty covers list');
  if (inlineValue) throw new Error('covers must be a YAML list');

  const covers = [];
  for (const candidate of frontmatter.slice(index + 1)) {
    if (/^\s*$/.test(candidate) || /^\s+#/.test(candidate)) continue;
    if (!/^\s/.test(candidate)) break;

    const item = candidate.match(/^\s+-\s+(.+?)\s*$/);
    if (!item) throw new Error('covers must contain only list items');

    let value = item[1].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (!value.endsWith(quote) || value.length < 2) {
        throw new Error('unterminated quoted covers item');
      }
      value = value.slice(1, -1);
    }
    if (!value) throw new Error('empty covers item');
    covers.push(value);
  }

  if (covers.length === 0) throw new Error('empty covers list');
  return covers;
}

export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new TypeError('cover glob must be a non-empty string');
  }

  let expression = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if ('.+?^${}()|[]\\/'.includes(character)) {
      expression += `\\${character}`;
    } else {
      expression += character;
    }
  }
  return new RegExp(`^${expression}$`);
}

export function publishedPoliciesFor(path, policy = PUBLISHED_DOCS_POLICY) {
  const relative = normalizePath(path);
  if (!relative) return [];

  return Object.entries(policy)
    .filter(([, patterns]) => patterns.some((pattern) => globToRegExp(pattern).test(relative)))
    .map(([name]) => name);
}

export function publishedPolicyOf(path, policy = PUBLISHED_DOCS_POLICY) {
  const matches = publishedPoliciesFor(path, policy);
  if (matches.length > 1) {
    throw new Error(`${normalizePath(path)} has multiple published-doc policies: ${matches.join(', ')}`);
  }
  return matches[0] ?? null;
}

export function manualDocsForChangedPaths(changedPaths, mappings = MANUAL_DOC_COVERS) {
  const matched = new Set();
  const compiled = Object.entries(mappings).map(([path, patterns]) => ({
    path,
    patterns: patterns.map(globToRegExp),
  }));

  for (const rawPath of changedPaths) {
    const path = normalizePath(rawPath);
    if (!path) continue;
    for (const doc of compiled) {
      if (doc.patterns.some((pattern) => pattern.test(path))) matched.add(doc.path);
    }
  }
  return [...matched].sort();
}

function isCodePath(path) {
  if (path.startsWith('docs/')) return false;
  if (/(^|\/)__tests__\//.test(path)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /_test\.go$/.test(path)) return false;
  const basename = path.split('/').at(-1);
  if (
    /^(?:\.dockerignore|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|Dockerfile|Makefile|go\.(?:mod|sum)|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
      basename,
    ) ||
    /\.config\.[cm]?[jt]s$/.test(basename) ||
    /\.(?:lock|toml)$/.test(basename)
  ) {
    return false;
  }
  if (
    /(^|\/)(?:package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|.*\.ya?ml|.*\.md)$/.test(
      path,
    )
  ) {
    return false;
  }
  return true;
}

export function mapChangedPaths(changedPaths, docsIndex) {
  const compiled = docsIndex.map((doc) => ({
    path: normalizePath(doc.path),
    patterns: doc.covers.map(globToRegExp),
  }));
  const matched = new Set();
  const uncovered = new Set();

  for (const rawPath of changedPaths) {
    const path = normalizePath(rawPath);
    if (!path) continue;

    let hit = false;
    for (const doc of compiled) {
      if (doc.patterns.some((pattern) => pattern.test(path))) {
        matched.add(doc.path);
        hit = true;
      }
    }
    if (!hit && isCodePath(path)) uncovered.add(path);
  }

  return {
    matched: [...matched].sort(),
    uncovered: [...uncovered].sort(),
  };
}

function* walkMarkdown(root, directory) {
  const absoluteDirectory = join(root, directory);
  if (!existsSync(absoluteDirectory)) return;

  const entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(root, relative);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield relative.split(sep).join('/');
  }
}

export function buildDocsIndex(root = DEFAULT_ROOT) {
  const index = [];
  for (const relative of walkMarkdown(root, 'docs')) {
    if (!isProseTierDoc(relative)) continue;

    try {
      index.push({
        path: relative,
        covers: readCovers(readFileSync(join(root, relative), 'utf8')),
      });
    } catch (error) {
      throw new Error(`${relative}: ${error.message}`, { cause: error });
    }
  }
  return index.sort((left, right) => left.path.localeCompare(right.path));
}

export function findUncoveredProseDocs(index) {
  return index
    .filter((doc) => doc.covers.length === 0)
    .map((doc) => doc.path)
    .sort();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const changedPaths = readFileSync(0, 'utf8')
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean);
  const result = {
    ...mapChangedPaths(changedPaths, buildDocsIndex()),
    manualReview: manualDocsForChangedPaths(changedPaths),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
