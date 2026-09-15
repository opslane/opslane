import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The package has no runtime dependencies: every import must be relative and stay inside src.
// Static imports, re-exports, side-effect imports, dynamic imports and require.
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function offending(file: string, spec: string): boolean {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return true; // bare, node:, absolute, file: or URL
  const rel = relative(SRC, resolve(dirname(file), spec));
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || resolve(SRC, rel) !== resolve(dirname(file), spec);
}

describe('@opslane/agent-runs isolation', () => {
  it('imports nothing outside the package, in any import form', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIERS)) {
        const spec = match[1]!;
        if (offending(file, spec)) {
          offenders.push(`${relative(SRC, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('catches every import form it claims to', () => {
    const file = join(SRC, 'schema.ts');
    const samples = [`import 'pg';`, `export * from "node:fs";`, `const m = await import('e2b');`, `require('@aws-sdk/client-s3')`,
      `import x from '/etc/passwd';`, `import y from '../../worker/src/db.js';`];
    for (const sample of samples) {
      const spec = [...sample.matchAll(SPECIFIERS)][0]?.[1] ?? '';
      expect(offending(file, spec), sample).toBe(true);
    }
    expect(offending(file, './canonical.js')).toBe(false);
  });
});
