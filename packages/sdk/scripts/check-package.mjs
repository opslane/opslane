#!/usr/bin/env node
// Publish-readiness check: asserts the npm tarball would contain the README,
// license, and every built entry point declared in package.json exports.
// Run after `pnpm build`; fails (exit 1) listing anything missing.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

const required = new Set(['README.md', 'LICENSE']);
for (const entry of Object.values(pkg.exports ?? {})) {
  for (const target of Object.values(entry)) {
    required.add(target.replace(/^\.\//, ''));
  }
}
if (pkg.main) required.add(pkg.main.replace(/^\.\//, ''));
if (pkg.types) required.add(pkg.types.replace(/^\.\//, ''));

const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: pkgDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const packed = new Set(JSON.parse(out)[0].files.map((f) => f.path));

const missing = [...required].filter((f) => !packed.has(f));
if (missing.length > 0) {
  console.error(`✗ npm tarball for ${pkg.name} is missing:`);
  for (const f of missing) console.error(`  - ${f}`);
  process.exit(1);
}

const NODE_BUILTIN_IMPORT =
  /(?:from\s*["']|require\(\s*["']|import\(\s*["'])node:[a-z_]+["']/;
const distDir = join(pkgDir, 'dist');
const pending = [distDir];
while (pending.length > 0) {
  const current = pending.pop();
  if (!current) break;
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    if (statSync(path).isDirectory()) {
      pending.push(path);
      continue;
    }
    if (NODE_BUILTIN_IMPORT.test(readFileSync(path, 'utf8'))) {
      console.error(`✗ ${path} contains a Node built-in import`);
      process.exit(1);
    }
  }
}

console.log(`✓ ${pkg.name} tarball contains README, LICENSE, and all ${required.size - 2} declared entry files (${packed.size} files total)`);
