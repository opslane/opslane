#!/usr/bin/env node
/**
 * License-boundary check for the MIT-published packages.
 *
 * The JavaScript SDK and shared contracts ship under MIT, so every production
 * dependency in their tarballs must carry an MIT-compatible permissive
 * license. Copyleft (GPL/AGPL/LGPL) or unlicensed dependencies fail the
 * build. The AGPL packages can consume anything permissive plus
 * AGPL itself, so they are not checked here.
 *
 * Usage: node scripts/check-licenses.mjs
 * (expects `pnpm install` to have run; reads the workspace via `pnpm list`)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIT_PACKAGES = ['@opslane/sdk', '@opslane/shared'];
const EXPECTED_MIT_INVENTORY = ['@opslane/sdk', '@opslane/sdk-python', '@opslane/shared'];
const EXPECTED_MIT_PNPM_PACKAGES = ['@opslane/sdk', '@opslane/shared'];

const agentCorePackage = JSON.parse(
  readFileSync(new URL('../packages/agent-core/package.json', import.meta.url), 'utf8')
);
if (agentCorePackage.license !== 'AGPL-3.0-only') {
  throw new Error(
    `packages/agent-core/package.json must declare AGPL-3.0-only, found ${JSON.stringify(agentCorePackage.license)}`
  );
}

const workspaceProjects = JSON.parse(execFileSync(
  'pnpm',
  ['list', '--recursive', '--depth', '-1', '--json'],
  { encoding: 'utf8' }
));
const actualMitInventory = workspaceProjects
  .map((project) => JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8')))
  .filter((manifest) => manifest.license === 'MIT')
  .map((manifest) => manifest.name);
const pythonManifest = readFileSync(
  new URL('../packages/sdk-python/pyproject.toml', import.meta.url),
  'utf8'
);
if (/^license\s*=\s*"([^"]+)"/m.exec(pythonManifest)?.[1] === 'MIT') {
  actualMitInventory.push('@opslane/sdk-python');
}
actualMitInventory.sort();
const expectedMitInventory = [...EXPECTED_MIT_INVENTORY].sort();
if (JSON.stringify(actualMitInventory) !== JSON.stringify(expectedMitInventory)) {
  throw new Error(
    `MIT package inventory must be exactly ${expectedMitInventory.join(', ')}; found ${actualMitInventory.join(', ')}`
  );
}
if (
  MIT_PACKAGES.length !== EXPECTED_MIT_PNPM_PACKAGES.length
  || MIT_PACKAGES.some((name, index) => name !== EXPECTED_MIT_PNPM_PACKAGES[index])
) {
  throw new Error(
    `MIT dependency checks must be exactly ${EXPECTED_MIT_PNPM_PACKAGES.join(', ')}`
  );
}

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'MIT OR Apache-2.0',
  'Apache-2.0 OR MIT',
  '(MIT OR CC0-1.0)',
]);

const listJson = execFileSync(
  'pnpm',
  [
    'list',
    '--prod',
    '--depth',
    'Infinity',
    '--json',
    ...MIT_PACKAGES.flatMap((p) => ['--filter', p]),
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);

const projects = JSON.parse(listJson);
const seen = new Map(); // "name@version" -> path
function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const key = `${name}@${info.version}`;
    if (seen.has(key)) continue;
    seen.set(key, info.path);
    walk(info.dependencies);
  }
}
for (const project of projects) walk(project.dependencies);

const problems = [];
let checked = 0;
for (const [key, pkgPath] of seen) {
  // Workspace packages are NOT exempt: an MIT package depending on an AGPL
  // workspace package (e.g. @opslane/worker) violates the boundary just as
  // hard as a third-party copyleft dependency would.
  let license;
  try {
    const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
    license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
  } catch {
    problems.push(`${key}: cannot read package.json at ${pkgPath}`);
    continue;
  }
  checked += 1;
  if (!license) {
    problems.push(`${key}: no license declared`);
  } else if (!ALLOWED.has(license)) {
    problems.push(`${key}: license "${license}" is not on the MIT-boundary allowlist`);
  }
}

if (checked === 0) {
  console.error('License check inspected zero dependencies — something is wrong.');
  process.exit(1);
}
if (problems.length > 0) {
  console.error('License-boundary check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `License check OK: ${checked} production dependencies of ${MIT_PACKAGES.join(', ')} are MIT-compatible.`
);
