import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectFramework } from '../detect.js';
import { applyPatches, init } from '../init.js';
import type { FilePatch } from '../codemods/types.js';
import { TEST_PUBLIC_KEY } from './fixtures.js';

describe('detectFramework', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-detect-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects react-vite from package.json with react + vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('react-vite');
  });

  it('detects nextjs from package.json with next', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nextjs');
  });

  it('detects vue-vite from package.json with vue + vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { vue: '^3.4.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('vue-vite');
  });

  it('detects nuxt from package.json with nuxt', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { nuxt: '^3.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nuxt');
  });

  it('returns unknown for bare package.json', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'bare-project',
        dependencies: {},
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('unknown');
  });

  it('returns unknown when no package.json exists', async () => {
    const result = await detectFramework(tmpDir);
    expect(result).toBe('unknown');
  });

  it('priority: next wins over react + vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nextjs');
  });

  it('priority: next wins over vue + vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^14.0.0', vue: '^3.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nextjs');
  });

  it('priority: nuxt wins over vue-vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { nuxt: '^3.0.0', vue: '^3.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nuxt');
  });

  it('priority: next > nuxt > vue-vite > react-vite', async () => {
    // All frameworks present — next should win
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          next: '^14.0.0',
          nuxt: '^3.0.0',
          vue: '^3.0.0',
          react: '^18.0.0',
        },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    expect(await detectFramework(tmpDir)).toBe('nextjs');

    // Remove next — nuxt should win
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          nuxt: '^3.0.0',
          vue: '^3.0.0',
          react: '^18.0.0',
        },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    expect(await detectFramework(tmpDir)).toBe('nuxt');

    // Remove nuxt — vue-vite should win
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { vue: '^3.0.0', react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    expect(await detectFramework(tmpDir)).toBe('vue-vite');

    // Remove vue — react-vite should win
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    expect(await detectFramework(tmpDir)).toBe('react-vite');
  });

  it('detects framework from devDependencies too', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        devDependencies: { next: '^14.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nextjs');
  });
});

describe('init patch application', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-init-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exports applyPatches and supports a JSON-serializable start-of-file anchor', async () => {
    await writeFile(join(tmpDir, 'entry.ts'), 'export {};\n');
    const patches: FilePatch[] = [{
      filePath: 'entry.ts',
      action: 'modify',
      insertAfter: '',
      insertContent: "import { init } from '@opslane/sdk';",
    }];
    expect(() => JSON.stringify(patches)).not.toThrow();
    await applyPatches(tmpDir, patches);
    expect(await readFile(join(tmpDir, 'entry.ts'), 'utf-8')).toMatch(
      /^import \{ init \}.*\nexport \{\};/,
    );
  });

  it('never writes a supplied API key into generated source or .opslane.json', async () => {
    await mkdir(join(tmpDir, 'src'));
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );
    await writeFile(
      join(tmpDir, 'src/main.tsx'),
      "import React from 'react';\nexport {};\n",
    );

    await init({
      cwd: tmpDir,
      nonInteractive: true,
      projectId: 'project-1',
      apiKey: TEST_PUBLIC_KEY,
    });

    const source = await readFile(join(tmpDir, 'src/main.tsx'), 'utf-8');
    const config = await readFile(join(tmpDir, '.opslane.json'), 'utf-8');
    const env = await readFile(join(tmpDir, '.env.local'), 'utf-8');
    const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    expect(source).toContain('import.meta.env.VITE_OPSLANE_API_KEY');
    expect(source).not.toContain(TEST_PUBLIC_KEY);
    expect(config).not.toContain(TEST_PUBLIC_KEY);
    expect(JSON.parse(config)).not.toHaveProperty('apiKey');
    expect(env).toBe(`VITE_OPSLANE_API_KEY=${TEST_PUBLIC_KEY}\n`);
    expect(gitignore).toContain('.env.local');
  });

  it('refuses to write a legacy key into browser environment config', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: {} }),
    );

    await expect(init({
      cwd: tmpDir,
      nonInteractive: true,
      projectId: 'project-1',
      apiKey: 'def_must-never-be-written',
    })).rejects.toThrow(/only opslane_pk_ keys belong in browser code/);

    await expect(readFile(join(tmpDir, '.env.local'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
