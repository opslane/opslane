// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import {
  eachMapping,
  originalPositionFor,
  TraceMap,
} from '@jridgewell/trace-mapping';
import { build } from 'vite';
import { opslaneVitePlugin } from '../../vite-plugin/index.js';

interface BuiltFile {
  bytes: Buffer;
  path: string;
}

function collectFiles(root: string, directory = root): BuiltFile[] {
  const files: BuiltFile[] = [];
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) {
      files.push(...collectFiles(root, path));
    } else {
      files.push({ path: relative(root, path), bytes: readFileSync(path) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function buildFixture(parent: string): Promise<BuiltFile[]> {
  const root = join(parent, 'app');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'main.ts'),
    [
      'export const eager = 1;',
      "export const lazy = () => import('./lazy.ts');",
      'console.log(eager);',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'lazy.ts'),
    ['export const first = 1;', 'export const second = first + 1;'].join(
      '\n',
    ),
  );
  const outDir = join(parent, 'dist');

  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      opslaneVitePlugin({ sourcemaps: 'keep', logLevel: 'silent' }),
    ],
    build: {
      sourcemap: 'hidden',
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: join(root, 'main.ts') },
    },
  });

  return collectFiles(outDir);
}

describe('Vite debug-ID determinism', () => {
  it('emits byte-identical chunks and valid maps from different roots', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'opslane-debug-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'opslane-debug-b-'));
    const first = await buildFixture(firstRoot);
    const second = await buildFixture(secondRoot);

    expect(first.map((file) => file.path)).toEqual(
      second.map((file) => file.path),
    );
    for (let index = 0; index < first.length; index++) {
      expect(first[index].bytes.equals(second[index].bytes)).toBe(true);
    }

    for (const file of first.filter((entry) => entry.path.endsWith('.map'))) {
      const map = JSON.parse(file.bytes.toString('utf8')) as {
        debugId: string;
        sources: string[];
      };
      expect(map.debugId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      for (const source of map.sources) {
        expect(isAbsolute(source)).toBe(false);
        expect(source).not.toContain(basename(firstRoot));
        expect(source).not.toContain(basename(secondRoot));
      }

      const trace = new TraceMap(map as never);
      const mappings: Array<{
        generatedLine: number;
        generatedColumn: number;
        originalLine: number;
        source: string;
      }> = [];
      eachMapping(trace, (mapping) => {
        if (mapping.source !== null && mapping.originalLine !== null) {
          mappings.push({
            generatedLine: mapping.generatedLine,
            generatedColumn: mapping.generatedColumn,
            originalLine: mapping.originalLine,
            source: mapping.source,
          });
        }
      });
      expect(mappings.length).toBeGreaterThan(2);
      for (const index of [
        0,
        Math.floor(mappings.length / 2),
        mappings.length - 1,
      ]) {
        const mapping = mappings[index];
        const original = originalPositionFor(trace, {
          line: mapping.generatedLine,
          column: mapping.generatedColumn,
        });
        expect(original.source).toBe(mapping.source);
        expect(original.line).toBe(mapping.originalLine);
      }
    }

    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  });
});
