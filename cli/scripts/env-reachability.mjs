#!/usr/bin/env node
// Does the browser actually receive the Opslane key?
//
//   node cli/scripts/env-reachability.mjs <repo> --env-dir <dir> --var <NAME> \
//        --entry <file> [--build <script>] [--pm <npm|pnpm|yarn|bun>]
//
// Every check in detect-eval.mjs inspects the PLAN. None of them runs anything,
// so a plan can pass all of them and still produce an app that installs, starts
// and never reports. Three of three repos in the eval corpus do exactly that:
//
//   umami       plans UMAMI_* vars, but Next.js only exposes NEXT_PUBLIC_* to
//               the browser unless next.config lists them, which Apply may not edit
//   excalidraw  excalidraw-app/vite.config.mts sets envDir: "../"
//   hoppscotch  selfhost-web/vite.config.ts sets envDir: "../../"
//
// In all three the value is undefined in the browser. This script catches that
// class of failure without a server or a browser: put a unique sentinel in the
// env file, build the app for real, then look for the sentinel in the output.
// A bundler inlines these variables at build time, so if the sentinel is not in
// the built assets, the running app cannot have the value either.
//
// This MUTATES the repo. The env file and, with --inject, the entry file are
// both restored on exit, including on failure. Installing and building are NOT
// undone: node_modules, a lockfile, and the build output are left behind,
// because removing them is destructive and they are what makes a second run
// fast. Point this at a disposable clone.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} requires a value`);
    process.exit(2);
  }
  return value;
}

const repo = resolve(process.argv[2] ?? '.');
const envDir = arg('env-dir', '.');
const varName = arg('var');
const entry = arg('entry');
const buildScript = arg('build', 'build');
const inject = process.argv.includes('--inject');

if (varName === undefined || entry === undefined) {
  console.error('usage: env-reachability.mjs <repo> --env-dir <dir> --var <NAME> --entry <file>');
  process.exit(2);
}

// Unique per run so a stale build directory cannot produce a false pass.
const SENTINEL = `opslane_reachability_${process.pid}_${varName.toLowerCase()}`;

const envFile = join(repo, envDir, '.env.local');
const entryFile = join(repo, entry);
const restore = [];

function cleanup() {
  for (const undo of restore.reverse()) {
    try {
      undo();
    } catch (error) {
      console.error(`  cleanup failed: ${error.message}`);
    }
  }
}
process.on('exit', cleanup);

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

// ── set up ─────────────────────────────────────────────────────────────────

if (existsSync(envFile)) {
  console.error(`refusing to overwrite ${envFile}`);
  process.exit(2);
}
mkdirSync(join(repo, envDir), { recursive: true });
writeFileSync(envFile, `${varName}=${SENTINEL}\n`);
restore.push(() => rmSync(envFile, { force: true }));

// The bundler only inlines a variable that the source actually reads. After a
// real Apply the init block does that; --inject reproduces it for a repo that
// has not been wired yet, so the check can run standalone.
if (inject) {
  const original = readFileSync(entryFile);
  restore.push(() => writeFileSync(entryFile, original));
  const accessor = varName.startsWith('NEXT_PUBLIC_')
    ? `process.env.${varName}`
    : `import.meta.env.${varName}`;
  writeFileSync(
    entryFile,
    `${original.toString('utf8')}\nconsole.log('opslane-reachability', ${accessor});\n`,
  );
}

const pm = arg('pm', existsSync(join(repo, 'pnpm-lock.yaml'))
  ? 'pnpm'
  : existsSync(join(repo, 'yarn.lock'))
    ? 'yarn'
    : 'npm');

// ── build ──────────────────────────────────────────────────────────────────

try {
  if (!existsSync(join(repo, 'node_modules'))) {
    console.log(`  installing with ${pm} ...`);
    run(pm, ['install'], repo);
  }
  console.log(`  building (${pm} run ${buildScript}) ...`);
  run(pm, ['run', buildScript], repo);
} catch (error) {
  console.error(`\nBUILD FAILED — cannot judge reachability.\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  process.exit(2);
}

// ── look for the sentinel in the built output ──────────────────────────────

const OUTPUT_DIRS = ['dist', 'build', '.next', 'out'];
let searched = 0;
let found = false;

function walk(directory) {
  for (const entryName of readdirSync(directory)) {
    const target = join(directory, entryName);
    const stats = statSync(target);
    if (stats.isDirectory()) {
      walk(target);
    } else if (stats.isFile() && stats.size < 32 * 1024 * 1024) {
      searched += 1;
      if (readFileSync(target, 'utf8').includes(SENTINEL)) found = true;
    }
    if (found) return;
  }
}

const present = OUTPUT_DIRS.map((d) => join(repo, d)).filter((d) => existsSync(d));
if (present.length === 0) {
  console.error(`\nNo build output found in ${OUTPUT_DIRS.join(', ')} — cannot judge.`);
  process.exit(2);
}
for (const directory of present) {
  if (!found) walk(directory);
}

console.log(
  found
    ? `\nREACHABLE    ${varName} is inlined into the built app (${searched} files searched)`
    : `\nNOT REACHABLE  ${varName} never reached the bundle (${searched} files searched)\n`
      + `             The app would run and report nothing. Check the env prefix the\n`
      + `             bundler exposes, and which directory it loads .env from.`,
);
process.exit(found ? 0 : 1);
