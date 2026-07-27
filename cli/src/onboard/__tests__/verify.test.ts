import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  OPSLANE_IDENTITY_MIN_VERSION,
  type VerifiableOnboardingPlan,
  verifyAlreadyOnboarded,
  verifyApplied,
} from '../verify.js';

const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');

describe('deterministic apply verification', () => {
  let root: string;
  let originalEntry: Buffer;
  let originalManifest: Buffer;
  let plan: VerifiableOnboardingPlan;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opslane-verify-'));
    mkdirSync(join(root, 'src'));
    originalEntry = Buffer.from(
      [
        "import App from './App.vue';",
        '',
        'async function start() {',
        "\tcreateApp(App).mount('#app');",
        '}',
        '',
      ].join('\n'),
    );
    originalManifest = Buffer.from(
      [
        '{',
        '  "name": "fixture",',
        '  "dependencies": {',
        '    "vue": "^3.5.0"',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, 'src', 'main.ts'), originalEntry);
    writeFileSync(join(root, 'package.json'), originalManifest);

    plan = {
      app_dir: '.',
      framework: 'vue-vite',
      package_manager: 'pnpm',
      dev_script: 'dev',
      env_prefix: 'VITE_',
      dependency: { name: '@opslane/sdk', version: '^2.0.0' },
      env_vars: {
        api_key: 'VITE_OPSLANE_API_KEY',
        endpoint: 'VITE_OPSLANE_ENDPOINT',
      },
      edit: {
        file: 'src/main.ts',
        entry_hash: hash(originalEntry),
        manifest_file: 'package.json',
        manifest_hash: hash(originalManifest),
        import_line: "import { init } from '@opslane/sdk';",
        init_block: [
          'init({',
          '  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,',
          '  endpoint: import.meta.env.VITE_OPSLANE_ENDPOINT,',
          '});',
        ].join('\n'),
        anchor: "createApp(App).mount('#app');",
        position: 'before',
        occurrence: 0,
      },
      existing_sdk: { action: 'none', name: null },
      rationale: 'Initialize immediately before mounting the application.',
    };
  });

  function applyFixture(customPlan = plan): void {
    const entry = originalEntry
      .toString('utf8')
      .replace(
        "import App from './App.vue';\n",
        `import App from './App.vue';\n${customPlan.edit.import_line}\n`,
      )
      .replace(
        "\tcreateApp(App).mount('#app');",
        `\t${customPlan.edit.init_block.replaceAll('\n', '\n\t')}\n\tcreateApp(App).mount('#app');`,
      );
    const manifest = originalManifest
      .toString('utf8')
      .replace(
        '    "vue": "^3.5.0"',
        `    "vue": "^3.5.0",\n    "@opslane/sdk": "${customPlan.dependency.version}"`,
      );
    writeFileSync(join(root, customPlan.edit.file), entry);
    writeFileSync(join(root, customPlan.edit.manifest_file), manifest);
  }

  const verify = (customPlan = plan, editedFiles = ['src/main.ts', 'package.json']) =>
    verifyApplied({
      root,
      plan: customPlan,
      editedFiles,
      originals: { entry: originalEntry, manifest: originalManifest },
    });

  it('accepts exactly the planned top-level import, indented init, and pinned dependency', () => {
    applyFixture();

    expect(verify()).toEqual({ ok: true, failures: [] });
  });

  // Codex QA P0 #4: an invalid byte would decode to U+FFFD, so a lossy string
  // comparison could hide a change. verify must reject non-UTF-8 rather than
  // silently pass it.
  it('rejects an entry file that is not valid UTF-8', () => {
    applyFixture();
    const applied = readFileSync(join(root, 'src', 'main.ts'));
    writeFileSync(join(root, 'src', 'main.ts'), Buffer.concat([applied, Buffer.from([0xff, 0xfe])]));

    const result = verify();
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('entry file is not valid UTF-8');
  });

  // Codex QA P1 #5: a leading BOM must not make a correctly-applied file fail.
  // Detect hashes the real (BOM-bearing) bytes, so the snapshot hash reflects them.
  it('accepts a correctly applied entry that carries a leading BOM', () => {
    const bomOriginal = Buffer.concat([Buffer.from('﻿', 'utf8'), originalEntry]);
    const bomPlan = { ...plan, edit: { ...plan.edit, entry_hash: hash(bomOriginal) } };
    applyFixture(bomPlan);
    const applied = readFileSync(join(root, 'src', 'main.ts'), 'utf8');
    writeFileSync(join(root, 'src', 'main.ts'), Buffer.from('﻿' + applied, 'utf8'));

    const result = verifyApplied({
      root,
      plan: bomPlan,
      editedFiles: ['src/main.ts', 'package.json'],
      originals: { entry: bomOriginal, manifest: originalManifest },
    });
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('accepts an init block placed after a complete-line anchor', () => {
    plan = { ...plan, edit: { ...plan.edit, position: 'after' } };
    const entry = originalEntry
      .toString('utf8')
      .replace(
        "import App from './App.vue';\n",
        `import App from './App.vue';\n${plan.edit.import_line}\n`,
      )
      .replace(
        "\tcreateApp(App).mount('#app');",
        `\tcreateApp(App).mount('#app');\n\t${plan.edit.init_block.replaceAll('\n', '\n\t')}`,
      );
    writeFileSync(join(root, 'src', 'main.ts'), entry);
    writeFileSync(
      join(root, 'package.json'),
      originalManifest
        .toString('utf8')
        .replace(
          '    "vue": "^3.5.0"',
          '    "vue": "^3.5.0",\n    "@opslane/sdk": "^2.0.0"',
        ),
    );

    expect(verify()).toEqual({ ok: true, failures: [] });
  });

  it('accepts creating dependencies and updating an older Opslane version', () => {
    originalManifest = Buffer.from('{\n  "name": "fixture"\n}\n');
    plan = {
      ...plan,
      edit: { ...plan.edit, manifest_hash: hash(originalManifest) },
    };
    writeFileSync(join(root, 'package.json'), originalManifest);
    const entry = originalEntry
      .toString('utf8')
      .replace(
        "import App from './App.vue';\n",
        `import App from './App.vue';\n${plan.edit.import_line}\n`,
      )
      .replace(
        "\tcreateApp(App).mount('#app');",
        `\t${plan.edit.init_block.replaceAll('\n', '\n\t')}\n\tcreateApp(App).mount('#app');`,
      );
    writeFileSync(join(root, 'src', 'main.ts'), entry);
    writeFileSync(
      join(root, 'package.json'),
      '{\n  "name": "fixture",\n  "dependencies": {\n    "@opslane/sdk": "^2.0.0"\n  }\n}\n',
    );
    expect(verify()).toEqual({ ok: true, failures: [] });

    originalManifest = Buffer.from(
      '{\n  "name": "fixture",\n  "dependencies": {\n    "@opslane/sdk": "^1.0.0"\n  }\n}\n',
    );
    plan = {
      ...plan,
      edit: { ...plan.edit, manifest_hash: hash(originalManifest) },
    };
    writeFileSync(
      join(root, 'package.json'),
      originalManifest.toString('utf8').replace('^1.0.0', '^2.0.0'),
    );
    expect(verify()).toEqual({ ok: true, failures: [] });
  });

  it('rejects an edited-file set containing an unapproved third file', () => {
    applyFixture();
    writeFileSync(join(root, 'README.md'), 'changed');

    const result = verify(plan, ['src/main.ts', 'package.json', 'README.md']);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain('edited file set does not match the approved plan');
  });

  it('rejects unrelated entry changes and a mis-indented init independently', () => {
    applyFixture();
    const file = join(root, 'src', 'main.ts');
    writeFileSync(
      file,
      read(file)
        .replace('async function start()', 'async function renamed()')
        .replace('\tinit({', '  init({'),
    );

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      'entry file differs by more than the planned import and init insertion',
    );
  });

  it('requires environment references inside the sole initializer call', () => {
    plan = {
      ...plan,
      edit: {
        ...plan.edit,
        init_block: [
          "init({ apiKey: 'literal', endpoint: 'literal' });",
          'const VITE_OPSLANE_API_KEY = 1, VITE_OPSLANE_ENDPOINT = 1;',
        ].join('\n'),
      },
    };
    applyFixture();

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      'planned init block must be one direct Opslane init call with one object',
    );
  });

  it('rejects a planned import placed inside a block', () => {
    const entry = originalEntry
      .toString('utf8')
      .replace(
        'async function start() {\n',
        `async function start() {\n${plan.edit.import_line}\n`,
      )
      .replace(
        "\tcreateApp(App).mount('#app');",
        `\t${plan.edit.init_block.replaceAll('\n', '\n\t')}\n\tcreateApp(App).mount('#app');`,
      );
    writeFileSync(join(root, 'src', 'main.ts'), entry);
    writeFileSync(
      join(root, 'package.json'),
      originalManifest
        .toString('utf8')
        .replace(
          '    "vue": "^3.5.0"',
          '    "vue": "^3.5.0",\n    "@opslane/sdk": "^2.0.0"',
        ),
    );

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => /syntax|top[- ]level/i.test(failure))).toBe(true);
  });

  it('rejects a top-level import placed away from the module import section', () => {
    const entry = originalEntry
      .toString('utf8')
      .replace(
        "\tcreateApp(App).mount('#app');",
        `\t${plan.edit.init_block.replaceAll('\n', '\n\t')}\n\tcreateApp(App).mount('#app');`,
      )
      .replace(/}\n$/, `}\n${plan.edit.import_line}\n`);
    writeFileSync(join(root, 'src', 'main.ts'), entry);
    writeFileSync(
      join(root, 'package.json'),
      originalManifest
        .toString('utf8')
        .replace(
          '    "vue": "^3.5.0"',
          '    "vue": "^3.5.0",\n    "@opslane/sdk": "^2.0.0"',
        ),
    );

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      'planned Opslane import is not in the module top-level import section',
    );
  });

  it('rejects a syntactically broken entry file', () => {
    applyFixture();
    writeFileSync(join(root, 'src', 'main.ts'), `${read(join(root, 'src', 'main.ts'))}\n{`);

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.failures).toContain('entry file has a syntax error');
  });

  it('rejects unrelated manifest semantics and whole-file reformatting', () => {
    applyFixture();
    const manifestPath = join(root, 'package.json');
    const parsed = JSON.parse(read(manifestPath)) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...parsed, private: true }));

    const unrelated = verify();
    expect(unrelated.ok).toBe(false);
    expect(unrelated.failures).toContain(
      'manifest has changes other than the pinned Opslane dependency',
    );

    applyFixture();
    writeFileSync(
      manifestPath,
      JSON.stringify(JSON.parse(read(manifestPath)), null, 4) + '\n',
    );
    const reformatted = verify();
    expect(reformatted.ok).toBe(false);
    expect(reformatted.failures).toContain('manifest rewrote existing bytes');
  });

  it('scans only added bytes for dotenv values and redacts the value', () => {
    const secret = 'canary-never-print-this-value';
    writeFileSync(join(root, '.env.local'), `PRIVATE_TOKEN=${secret}\n`);
    plan = {
      ...plan,
      edit: {
        ...plan.edit,
        init_block: `${plan.edit.init_block.slice(0, -3)}  release: '${secret}',\n});`,
      },
    };
    applyFixture();

    const result = verify();

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      'newly added content contains the value of dotenv variable PRIVATE_TOKEN',
    );
    expect(result.failures.join(' ')).not.toContain(secret);
  });

  it('does not reject a dotenv value that existed only in unchanged bytes', () => {
    const existing = 'preexisting-canary-value';
    originalEntry = Buffer.from(`// ${existing}\n${originalEntry.toString('utf8')}`);
    plan = {
      ...plan,
      edit: { ...plan.edit, entry_hash: hash(originalEntry) },
    };
    writeFileSync(join(root, 'src', 'main.ts'), originalEntry);
    writeFileSync(join(root, '.env'), `PRIVATE_TOKEN=${existing}\n`);
    applyFixture();

    expect(verify()).toEqual({ ok: true, failures: [] });
  });

  it('does not follow a symlinked dotenv file outside the repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'opslane-outside-'));
    writeFileSync(join(outside, 'secret'), 'PRIVATE_TOKEN=outside-canary-value\n');
    symlinkSync(join(outside, 'secret'), join(root, '.env.link'));
    applyFixture();

    expect(verify()).toEqual({ ok: true, failures: [] });
  });

  it('rejects unsupported entry extensions instead of skipping parsing', () => {
    const unsupported = join(root, 'src', 'main.vue');
    writeFileSync(unsupported, originalEntry);
    plan = {
      ...plan,
      edit: {
        ...plan.edit,
        file: 'src/main.vue',
        entry_hash: hash(originalEntry),
      },
    };
    applyFixture();

    const result = verify(plan, ['src/main.vue', 'package.json']);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unsupported entry extension: .vue');
  });

  it('confirms no-op only when the dependency and its imported initializer call exist', () => {
    applyFixture();

    expect(verifyAlreadyOnboarded({ root, plan })).toEqual({
      ok: true,
      failures: [],
    });

    writeFileSync(
      join(root, 'src', 'main.ts'),
      [
        "import App from './App.vue';",
        "// import { init } from '@opslane/sdk';",
        "const note = 'init()';",
        "createApp(App).mount('#app');",
      ].join('\n'),
    );
    const rejected = verifyAlreadyOnboarded({ root, plan });
    expect(rejected.ok).toBe(false);
    expect(rejected.failures).toContain('entry file has no top-level Opslane SDK import');
  });

  // Codex QA P0 #1: `import type { init }` is erased at runtime and cannot
  // initialize the SDK, so it must not satisfy the no-op existence check.
  it('rejects no-op when the SDK import is type-only', () => {
    applyFixture(); // installs the dependency in package.json
    writeFileSync(
      join(root, 'src', 'main.ts'),
      [
        "import App from './App.vue';",
        "import type { init } from '@opslane/sdk';",
        'init();',
        "createApp(App).mount('#app');",
      ].join('\n'),
    );
    const rejected = verifyAlreadyOnboarded({ root, plan });
    expect(rejected.ok).toBe(false);
    expect(rejected.failures).toContain('entry file has no top-level Opslane SDK import');
  });

  it('rejects no-op for an identity-broken SDK version or a nonexistent default export', () => {
    applyFixture();
    const manifest = join(root, 'package.json');
    writeFileSync(manifest, read(manifest).replace('^2.0.0', '^1.0.0'));

    const oldVersion = verifyAlreadyOnboarded({ root, plan });
    expect(oldVersion.ok).toBe(false);
    expect(oldVersion.failures[0])
      .toContain(`identity-capable Opslane SDK version (>=${OPSLANE_IDENTITY_MIN_VERSION})`);

    writeFileSync(manifest, read(manifest).replace('^1.0.0', '2.0.0-beta.1'));
    expect(verifyAlreadyOnboarded({ root, plan }).ok).toBe(false);

    writeFileSync(manifest, read(manifest).replace('2.0.0-beta.1', '^2.0.0'));
    writeFileSync(
      join(root, 'src', 'main.ts'),
      [
        "import Opslane from '@opslane/sdk';",
        'Opslane.init({',
        '  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,',
        '  endpoint: import.meta.env.VITE_OPSLANE_ENDPOINT,',
        '});',
      ].join('\n'),
    );
    const defaultImport = verifyAlreadyOnboarded({ root, plan });
    expect(defaultImport.ok).toBe(false);
    expect(defaultImport.failures).toContain('entry file has no top-level Opslane SDK import');
  });
});

function read(file: string): string {
  return readFileSync(file, 'utf8');
}
