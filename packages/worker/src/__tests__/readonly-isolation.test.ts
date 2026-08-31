import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as tools from '../investigate-tools.js';
import { MachineUnavailableError, VerificationInfraError } from '../harness/errors.js';
import { toInfraError } from '../harness/readonly-sandbox.js';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));
const src = (p: string): string => readFileSync(join(SRC_ROOT, p), 'utf8');

/** Every module under `src`, excluding tests, as paths relative to `src`. */
function allSourceFiles(dir = SRC_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : allSourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [relative(SRC_ROOT, full)] : [];
  });
}

/**
 * The modules a file pulls in at runtime.
 *
 * `import type` is excluded because it is erased and imports nothing; a value
 * import of a type (`import { type Foo } from`) still loads the module and is
 * therefore included.
 */
function importsOf(file: string): string[] {
  const text = src(file);
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*import\s+(type\s+)?[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) continue; // `import type` — erased at compile time
    const specifier = match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Resolve a relative `./x.js` specifier back to the `.ts` source it came from. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(join(SRC_ROOT, fromFile)), specifier).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return relative(SRC_ROOT, candidate);
    } catch { /* not this shape */ }
  }
  return null;
}

/** Every in-package module reachable from `entry`, including `entry` itself. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of importsOf(file)) {
      const local = resolveLocal(file, specifier);
      if (local && !seen.has(local)) {
        seen.add(local);
        queue.push(local);
      }
    }
  }
  return [...seen];
}

/** Node builtins that would put the host's filesystem or a subprocess in reach. */
const HOST_ACCESS = /from '(?:node:)?(?:fs|fs\/promises|child_process)'/;

/**
 * The one module with host access a read-only job may have in its import graph.
 *
 * `harness/local-sandbox.ts` is the deterministic reliability harness's sandbox
 * transport double. It is not a repository reader: it never resolves a path in a
 * customer checkout, and it runs scripted fixture commands in a temp directory
 * it created. It earns the exemption by being unreachable in production rather
 * than by assertion — `createSandboxRuntime` loads it with a dynamic import that
 * it reaches only after `OPSLANE_RELIABILITY_HARNESS=1`, so a production process
 * never evaluates the module. The test below pins that ordering; if the gate
 * moves or disappears, this exemption stops being true and that test fails.
 */
const HARNESS_ONLY_HOST_ACCESS = [join('harness', 'local-sandbox.ts')];

/**
 * The job sources whose repository access must now happen inside a sandbox.
 *
 * `product-context/job.ts` is deliberately absent: its `discoverRepositoryRoutes`
 * walk reads up to 10,000 files on the host and needs a seam `RepoReader` does
 * not provide, so it was descoped from this change and is tracked separately.
 * The descoped assertion below states that out loud rather than letting the
 * silence read as coverage.
 */
const ISOLATED_JOB_SOURCES = ['investigate.ts', 'inquiry/job.ts', 'friction/investigate-friction.ts'];
const DESCOPED_JOB_SOURCES = ['product-context/job.ts'];

describe('read-only jobs no longer read the host', () => {
  it('exports no host reader and no lexical path guard', () => {
    expect(Object.keys(tools)).not.toContain('createHostReader');
    expect(Object.keys(tools)).not.toContain('safePath');
  });

  it('investigate-tools does not import the filesystem', () => {
    expect(src('investigate-tools.ts')).not.toMatch(/from 'node:fs/);
  });

  it('the quote checker no longer reads the host synchronously', () => {
    expect(src('investigate.ts')).not.toMatch(/readFileSync|statSync/);
  });

  it.each(ISOLATED_JOB_SOURCES)('%s touches neither the host filesystem nor a subprocess', (file) => {
    const text = src(file);
    expect(text).not.toMatch(HOST_ACCESS);
    expect(text).not.toMatch(/execFile/);
  });

  it.each(ISOLATED_JOB_SOURCES)('%s reaches no host access through anything it imports', (file) => {
    // The check above reads one file, and host access does not have to live in
    // it. Re-adding `import { resolveInsideRepo } from './repo-paths.js'` to
    // investigate.ts — a module that imports node:fs — restored full host
    // filesystem access with every isolation test still green. This walks the
    // real import graph instead, so the boundary is asserted where it exists.
    const offenders = reachableFrom(file)
      .filter((reached) => HOST_ACCESS.test(src(reached)))
      .filter((reached) => !HARNESS_ONLY_HOST_ACCESS.includes(reached));
    expect(offenders, `${file} reaches the host through: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the harness sandbox double stays unreachable without the harness gate', () => {
    // The exemption above is only true while the gate comes FIRST: a static
    // import, or a dynamic one hoisted above the check, would load a module that
    // can run arbitrary commands on this host into every production worker.
    const runtime = src(join('harness', 'sandbox-runtime.ts'));
    expect(runtime, 'the double must not be statically imported').not.toMatch(
      /^\s*import\s[^;]*from\s*'\.\/local-sandbox\.js'/m,
    );
    const gate = runtime.indexOf("process.env['OPSLANE_RELIABILITY_HARNESS'] !== '1'");
    const load = runtime.indexOf("await import('./local-sandbox.js')");
    expect(gate, 'the harness gate must still exist').toBeGreaterThan(-1);
    expect(load, 'the double must still be loaded dynamically').toBeGreaterThan(gate);
  });

  it('the harness double reads no customer checkout', () => {
    // It is exempt because it is a transport double, not a repository reader.
    // The read-only reader that DOES resolve model-chosen paths is
    // createSandboxReader, and it must stay on the far side of the machine.
    const double = src(join('harness', 'local-sandbox.ts'));
    expect(double).not.toMatch(/host-reader|repo-paths|createSandboxReader/);
  });

  it('the host reader is imported only by the fix pipeline and the descoped job', () => {
    // Enumerated from disk, not from a fixed list: a NEW module importing the
    // host reader — a new read-only job type, exactly the regression this file
    // exists to prevent — is the case a hardcoded list cannot see.
    const importers = allSourceFiles().filter((file) => /host-reader/.test(src(file)));
    expect(importers.sort()).toEqual(['agent-fix.ts', join('product-context', 'job.ts')]);
  });

  it('no isolated job still clones onto this host', () => {
    for (const file of ISOLATED_JOB_SOURCES) {
      expect(src(file), `${file} must not call cloneRepo`).not.toMatch(/cloneRepo\(/);
    }
  });

  it.each(DESCOPED_JOB_SOURCES)('%s is a known, tracked gap that still reads the host', (file) => {
    // Asserted so that isolating it fails this test and forces the file out of
    // DESCOPED_JOB_SOURCES and into ISOLATED_JOB_SOURCES, rather than leaving a
    // stale exemption behind.
    expect(src(file)).toMatch(HOST_ACCESS);
  });
});

describe('toInfraError', () => {
  const machine = { sandboxId: 'sbx-1', createdAt: Date.now() - 5000 };

  it('converts a machine failure into the existing infra retry lane', () => {
    const out = toInfraError(new MachineUnavailableError('gone', 'gone'), machine, {} as never);
    expect(out).toBeInstanceOf(VerificationInfraError);
  });

  it('leaves an unrelated error alone so real bugs are not laundered as infra', () => {
    const bug = new TypeError('cannot read property of undefined');
    expect(toInfraError(bug, machine, {} as never)).toBe(bug);
  });
});
