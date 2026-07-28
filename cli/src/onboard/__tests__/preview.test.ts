import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildActionPreview } from '../preview.js';
import { OPSLANE_SDK_VERSION, type OnboardingPlan } from '../tools.js';

function fixture(): { root: string; plan: OnboardingPlan } {
  const root = mkdtempSync(join(tmpdir(), 'opslane-preview-'));
  mkdirSync(join(root, 'web', 'src'), { recursive: true });
  const entry = "createApp(App).mount('#app');\n";
  const manifest = '{"scripts":{"dev":"vite"},"dependencies":{}}\n';
  writeFileSync(join(root, 'web', 'src', 'main.ts'), entry);
  writeFileSync(join(root, 'web', 'package.json'), manifest);
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  return {
    root,
    plan: {
      app_dir: 'web',
      framework: 'vue-vite',
      package_manager: 'pnpm',
      dev_script: 'dev',
      env_prefix: 'VITE_',
      env_dir: '.',
      dependency: { name: '@opslane/sdk', version: OPSLANE_SDK_VERSION },
      env_vars: {
        api_key: 'VITE_OPSLANE_API_KEY',
        endpoint: 'VITE_OPSLANE_ENDPOINT',
      },
      edit: {
        file: 'web/src/main.ts',
        entry_hash: createHash('sha256').update(entry).digest('hex'),
        manifest_file: 'web/package.json',
        manifest_hash: createHash('sha256').update(manifest).digest('hex'),
        import_line: "import { init } from '@opslane/sdk';",
        init_block:
          'init({\n  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,\n});',
        anchor: "createApp(App).mount('#app');",
        position: 'before',
        occurrence: 0,
      },
      existing_sdk: { action: 'none', name: null },
      rationale: 'This is the user-facing app.',
    },
  };
}

describe('buildActionPreview', () => {
  it('derives every checked action from the plan and repository', () => {
    const { root, plan } = fixture();
    writeFileSync(join(root, '.env.local'), 'VITE_OPSLANE_API_KEY=old\n');

    expect(buildActionPreview({
      cwd: root,
      plan,
      envValues: {
        VITE_OPSLANE_API_KEY: 'new',
        VITE_OPSLANE_ENDPOINT: 'http://localhost:8082',
      },
    })).toEqual({
      entryFile: 'web/src/main.ts',
      manifestFile: 'web/package.json',
      addedDependency: `@opslane/sdk@${OPSLANE_SDK_VERSION}`,
      envFile: '.env.local',
      envKeysAdded: ['VITE_OPSLANE_ENDPOINT'],
      envKeysReplaced: ['VITE_OPSLANE_API_KEY'],
      gitignoreWillChange: true,
      editsCode: true,
      installCommand: 'pnpm install',
      devCommand: 'pnpm run dev',
      devCwd: 'web',
      insert: {
        anchor: "createApp(App).mount('#app');",
        position: 'before',
        lines: [
          "import { init } from '@opslane/sdk';",
          'init({',
          '  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,',
          '});',
        ],
      },
    });
  });

  it('does not promise a gitignore edit when .env.local is already ignored', () => {
    const { root, plan } = fixture();
    writeFileSync(join(root, '.gitignore'), 'dist\n.env.local\n');

    expect(buildActionPreview({
      cwd: root,
      plan,
      envValues: {
        VITE_OPSLANE_API_KEY: 'key',
        VITE_OPSLANE_ENDPOINT: 'endpoint',
      },
    }).gitignoreWillChange).toBe(false);
  });

  it('omits code and install actions for an already-wired repository', () => {
    const { root, plan } = fixture();
    const preview = buildActionPreview({
      cwd: root,
      plan: { ...plan, existing_sdk: { action: 'no_op', name: '@opslane/sdk' } },
      envValues: {
        VITE_OPSLANE_API_KEY: 'key',
        VITE_OPSLANE_ENDPOINT: 'endpoint',
      },
    });

    expect(preview.installCommand).toBeNull();
  });
});
