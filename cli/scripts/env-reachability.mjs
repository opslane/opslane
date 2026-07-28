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

// A real repo usually already has a .env.local, so append rather than replace,
// and put the original back on exit. Replacing it would delete whatever the
// developer had there, and refusing outright would make the check unrunnable on
// exactly the repos worth checking.
mkdirSync(join(repo, envDir), { recursive: true });
if (existsSync(envFile)) {
  const original = readFileSync(envFile);
  restore.push(() => writeFileSync(envFile, original));
  writeFileSync(envFile, `${original.toString('utf8').replace(/\n?$/, '\n')}${varName}=${SENTINEL}\n`);
} else {
  restore.push(() => rmSync(envFile, { force: true }));
  writeFileSync(envFile, `${varName}=${SENTINEL}\n`);
}

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

// ── fast path: ask Vite directly, no build ─────────────────────────────────
//
// Building is the strongest evidence, but it needs the repo to build, and real
// repos often do not on a fresh clone: hoppscotch fails in vite-plugin-pages
// before our code runs, and umami's build wants a database. --via-config asks
// Vite itself instead. resolveConfig applies the app's real vite config, so
// envDir and envPrefix are the values the app would actually use, and loadEnv
// returns exactly the variables Vite would expose to the browser. That covers
// both failures seen in the corpus — wrong directory and wrong prefix — without
// compiling anything.

if (process.argv.includes('--via-config')) {
  const appDir = arg('build-cwd', '.');
  const { resolveConfig, loadEnv } = await import(
    join(repo, 'node_modules', 'vite', 'dist', 'node', 'index.js')
  ).catch(async () => import(join(repo, appDir, 'node_modules', 'vite', 'dist', 'node', 'index.js')));

  const config = await resolveConfig({ root: join(repo, appDir) }, 'build');
  // An unset envPrefix means Vite's default, not "no prefix". Printing the raw
  // undefined told the reader the app exposes nothing, which is the opposite.
  const prefix = config.envPrefix ?? 'VITE_';
  const exposed = loadEnv('production', config.envDir, prefix);
  const value = exposed[varName];

  console.log(`  vite envDir    ${config.envDir}`);
  console.log(`  vite envPrefix ${JSON.stringify(prefix)}${config.envPrefix === undefined ? ' (Vite default)' : ''}`);
  console.log(
    value === SENTINEL
      ? `\nREACHABLE    ${varName} is exposed to the browser by this app's Vite config`
      : `\nNOT REACHABLE  ${varName} is not exposed to the browser.\n`
        + `             Vite reads .env from ${config.envDir} and only exposes names\n`
        + `             starting with ${JSON.stringify(prefix)}.`,
  );
  process.exit(value === SENTINEL ? 0 : 1);
}

// ── build ──────────────────────────────────────────────────────────────────

try {
  if (!existsSync(join(repo, 'node_modules'))) {
    console.log(`  installing with ${pm} ...`);
    run(pm, ['install'], repo);
  }
  // Install belongs at the workspace root, but the build script often lives in
  // the app package and has no root-level equivalent — hoppscotch has no root
  // "build" at all. --build-cwd says where to run it.
  const buildCwd = join(repo, arg('build-cwd', '.'));
  console.log(`  building (${pm} run ${buildScript} in ${arg('build-cwd', '.')}) ...`);
  run(pm, ['run', buildScript], buildCwd);
} catch (error) {
  console.error(`\nBUILD FAILED — cannot judge reachability.\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  process.exit(2);
}

// ── look for the sentinel in the built output ──────────────────────────────

// A monorepo writes its bundle inside the app package, not at the repo root, so
// the caller can name it. Guessing wrong would search an empty tree and report
// "not reachable" for a build that was actually fine.
const explicitOut = arg('out');
const OUTPUT_DIRS = explicitOut === undefined
  ? ['dist', 'build', '.next', 'out']
  : [explicitOut];
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
