#!/usr/bin/env node
/**
 * Classifies a pull request's changed files into CI areas.
 *
 * Deliberately coarse. There are exactly three outcomes:
 *
 *   top-level workflow YAML except ci.yml, plus known repo metadata -> no heavy job
 *   docs/**, docs-site/**, top-level *.md -> js only
 *   anything else, including anything unrecognised -> everything
 *
 * A finer per-package map was tried and rejected. This monorepo's
 * cross-directory imports make one unsafe to derive by hand -- an independent
 * review of the fine-grained version found five real holes:
 *
 *   - packages/ingestion/handler/wire_compat_test.go replays every fixture
 *     under test-fixtures/wire/events, and additions are allowed by the
 *     append-only gate (fixtures feed Go)
 *   - packages/test-reliability is a workspace package with tsc + vitest unit
 *     tests that run in pnpm test:unit (it feeds JS)
 *   - packages/sdk-python/tests/test_wire_shape.py reads test-fixtures/wire
 *     (fixtures feed Python)
 *
 * Refine later if the numbers justify it, one rule and one test at a time.
 * Never add a complement rule ("everything except X") -- that makes paths
 * which did not exist when the rule was written silently inert, the exact
 * opposite of what a CI gate should do.
 *
 * Usage: git diff --no-renames --name-only -z BASE...HEAD | node scripts/ci-changed-areas.mjs
 * Writes `area=true|false` lines on stdout for $GITHUB_OUTPUT, and the
 * per-path classification on stderr for the run log.
 */

export const AREAS = ['go', 'js', 'python', 'e2e', 'reliability'];

const ALL = AREAS;
const JS_ONLY = ['js'];
const NONE = [];
const INERT_META_PATHS = new Set(['.github/dependabot.yml', '.github/CLA.md']);
/**
 * File types that are read by humans and rendered, never executed.
 * Anchored with a negative lookahead rather than `$`: `$` also matches before a
 * trailing newline, and a filename may legally contain one.
 */
const PROSE = /\.(md|png|jpe?g|svg|gif|webp)(?![\s\S])/;

// Ordered. First match wins.
const RULES = [
  // The gate itself: any change here must run everything.
  // Matched as ya?ml so a rename to ci.yaml cannot fall through to the meta
  // rule below, which would make the gate file itself inert.
  { tag: 'global', areas: ALL, test: (p) => /^\.github\/workflows\/ci\.ya?ml$/.test(p) },

  // Other top-level workflow YAML and explicitly known repo-meta files.
  // Action pinning is covered by the always-on repo-checks job, secret
  // scanning by the always-on security job, and workflow security by CodeQL's
  // `actions` analysis. Deliberately do not match all of .github/: executable
  // local actions and future unknown metadata must fail closed.
  {
    tag: 'meta',
    areas: NONE,
    test: (p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || INERT_META_PATHS.has(p),
  },

  // Prose. Feeds js because docs-site/astro.config.mjs processes ../docs and
  // its build runs check-built-links.mjs, and the js job runs `pnpm -r build`.
  //
  // docs/ is matched by extension, not by prefix: it holds only .md and .png
  // today and nothing there is executed, but a future docs/tools/gen.mjs or
  // docs/deploy.sh under a prefix rule would be silently inert to go, python,
  // e2e, and reliability. Anything else under docs/ falls through to UNKNOWN.
  //
  // docs-site/ IS matched by prefix, deliberately: it is a pnpm workspace
  // package, so its code is genuinely covered by `pnpm -r build` and
  // `pnpm test:unit`, both of which the js area turns on.
  { tag: 'docs', areas: JS_ONLY, test: (p) => p.startsWith('docs/') && PROSE.test(p) },
  { tag: 'docs-site', areas: JS_ONLY, test: (p) => p.startsWith('docs-site/') },

  // Top level only. Markdown nested inside a package is NOT inert:
  // packages/sdk-python/README.md is the wheel's long_description and
  // `twine check --strict` reads it.
  { tag: 'root-doc', areas: JS_ONLY, test: (p) => !p.includes('/') && p.endsWith('.md') },
];

/** Returns the tag for a path, or 'UNKNOWN' when no rule matches. */
export function classify(path) {
  for (const rule of RULES) {
    if (rule.test(path)) return rule.tag;
  }
  return 'UNKNOWN';
}

function areasForPath(path) {
  for (const rule of RULES) {
    if (rule.test(path)) return rule.areas;
  }
  return ALL; // UNKNOWN: fail closed.
}

/**
 * Union of the areas every changed path needs. An empty list turns everything
 * on: no detected changes means the diff computation is wrong.
 */
export function areasFor(paths) {
  if (paths.length === 0) return Object.fromEntries(AREAS.map((a) => [a, true]));
  const on = Object.fromEntries(AREAS.map((a) => [a, false]));
  for (const path of paths) {
    for (const area of areasForPath(path)) on[area] = true;
  }
  return on;
}

/** Splits `git diff -z` output. NUL-separated, trailing separator dropped. */
export function parsePaths(raw) {
  return raw.split('\0').filter((p) => p.length > 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const paths = parsePaths(Buffer.concat(chunks).toString('utf8'));
  for (const path of paths) console.error(`${classify(path).padEnd(10)} ${path}`);
  for (const [area, on] of Object.entries(areasFor(paths))) console.log(`${area}=${on}`);
}
