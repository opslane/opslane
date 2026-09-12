#!/usr/bin/env node
/**
 * The Node pins Cloudflare Pages and CI read must exist and agree.
 *
 * Cloudflare Pages builds docs-site with that folder as its root directory and
 * reads `.nvmrc` (or `.node-version`) from there, never from the repo root.
 * Without its own copy it falls back to the build image's default Node, and
 * `engine-strict=true` makes `pnpm install` fail as soon as any dependency
 * wants a newer Node (jsdom 30 and undici 8 did, 2026-08-27). Deleting the
 * docs-site pin or bumping one pin without the other reopens that gap
 * silently, so this check fails instead.
 *
 * Only files git can see are checked (tracked, or untracked and not ignored),
 * so gitignored local state such as sibling worktrees or database data dirs
 * cannot fail it. A NODE_VERSION variable in the Pages dashboard overrides
 * both files and is outside what the repo can verify.
 *
 * Usage: node scripts/check-node-pins.mjs [repoRoot]
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pins that must exist because a build system reads them from that folder.
const REQUIRED_PINS = ['docs-site/.nvmrc'];
const PIN_FILES = new Set(['.nvmrc', '.node-version']);
// Exact release only: ranges and aliases ("22", "lts/*") resolve differently
// on every runner, which is how two pins can agree and still differ.
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const toPosix = (path) => path.split(sep).join('/');

function listPinFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((p) => p && PIN_FILES.has(basename(p)))
    .map(toPosix)
    .sort();
}

// Returns the trimmed pin, or pushes a problem and returns null.
function readPin(root, file, problems) {
  let stat;
  try {
    stat = lstatSync(join(root, file));
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    problems.push(`${file} must be a regular file, not a symlink or directory`);
    return null;
  }
  const pin = readFileSync(join(root, file), 'utf8').trim();
  if (!EXACT_VERSION.test(pin)) {
    problems.push(`${file} must pin an exact Node release like 22.23.2, got ${JSON.stringify(pin)}`);
    return null;
  }
  return pin;
}

export function checkNodePins(root) {
  const problems = [];
  const files = new Set(listPinFiles(root));
  if (!files.has('.nvmrc')) {
    return { rootPin: null, problems: ['root .nvmrc is missing'] };
  }
  const rootPin = readPin(root, '.nvmrc', problems);
  if (rootPin === null) return { rootPin: null, problems };

  for (const required of REQUIRED_PINS) {
    if (!files.has(required)) {
      problems.push(`${required} is missing; Cloudflare Pages reads it from that folder`);
    }
  }
  for (const file of files) {
    if (file === '.nvmrc') continue;
    const pin = readPin(root, file, problems);
    if (pin !== null && pin !== rootPin) {
      problems.push(`${file} pins Node ${pin}; root .nvmrc pins ${rootPin}`);
    }
  }
  return { rootPin, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const { rootPin, problems } = checkNodePins(root);
  if (problems.length > 0) {
    console.error('Node pins disagree:');
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nEvery .nvmrc must exist where a build system reads it and carry the root version.');
    process.exit(1);
  }
  console.log(`Node pins OK: every .nvmrc pins ${rootPin}.`);
}
