#!/usr/bin/env node
// Clone the real-repo Detect eval corpus, then hand it to detect-eval.mjs.
//
//   export ANTHROPIC_API_KEY=...
//   pnpm --filter @opslane/cli build
//   node cli/scripts/onboard-eval-corpus.mjs           # clone (if needed) + run detect-eval
//   node cli/scripts/onboard-eval-corpus.mjs --clone-only
//   node cli/scripts/onboard-eval-corpus.mjs --only excalidraw
//
// The repos are NOT vendored. They are shallow-cloned into a gitignored
// directory, because a Detect eval is only meaningful against real trees and
// vendoring ~140MB of third-party source into this repo would be worse than
// re-cloning. Pinning is deliberately loose (default branch, depth 1): the point
// is to catch "we broke detection on real-world shapes", and a repo that
// restructures itself is itself a signal worth seeing.
//
// detect-eval.mjs is read-only and verifies each tree is unchanged afterwards,
// so running this against clones in place is safe.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = process.env.OPSLANE_EVAL_CORPUS_DIR
  ?? resolve(HERE, '../../.eval-corpus');
const manifest = JSON.parse(readFileSync(join(HERE, 'onboard-eval-corpus.json'), 'utf8'));

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;
const cloneOnly = process.argv.includes('--clone-only');

const repos = manifest.repos.filter((r) => only === undefined || r.name === only);
if (repos.length === 0) {
  console.error(`no repo named ${JSON.stringify(only)} in the corpus`);
  process.exit(1);
}

mkdirSync(CORPUS_DIR, { recursive: true });

const paths = [];
for (const repo of repos) {
  const target = join(CORPUS_DIR, repo.name);
  if (existsSync(target)) {
    console.log(`  present  ${repo.name}`);
  } else {
    console.log(`  cloning  ${repo.name} ...`);
    execFileSync('git', ['clone', '--depth', '1', '--quiet', repo.url, target], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  paths.push(target);
  console.log(`           exercises: ${repo.exercises.split('.')[0]}.`);
}

if (cloneOnly) {
  console.log(`\ncorpus ready at ${CORPUS_DIR}`);
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\nANTHROPIC_API_KEY is required to run the detect eval.');
  process.exit(1);
}

console.log('');
execFileSync(process.execPath, [join(HERE, 'detect-eval.mjs'), ...paths], {
  stdio: 'inherit',
});
