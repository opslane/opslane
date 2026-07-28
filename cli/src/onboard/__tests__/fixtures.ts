/**
 * Shared screen fixtures.
 *
 * The tests assert on these and `cli/scripts/tui-playground.tsx` renders them,
 * so what a reviewer looks at is the same data the suite pins. A playground
 * with its own copy drifts from the component silently, which is worse than
 * having none: it shows a screen nobody ships.
 */
import type { ActionPreview } from '../preview.js';
import type { OnboardingPlan } from '../tools.js';

export const plan: OnboardingPlan = {
  app_dir: 'web',
  framework: 'vue-vite',
  package_manager: 'pnpm',
  dev_script: 'dev',
  env_prefix: 'VITE_',
  env_dir: '.',
  dependency: { name: '@opslane/sdk', version: '^2.0.0' },
  env_vars: {
    api_key: 'VITE_OPSLANE_API_KEY',
    endpoint: 'VITE_OPSLANE_ENDPOINT',
  },
  edit: {
    file: 'web/src/main.ts',
    entry_hash: 'entry',
    manifest_file: 'web/package.json',
    manifest_hash: 'manifest',
    import_line: "import { init } from '@opslane/sdk';",
    init_block: 'init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY });',
    anchor: "createApp(App).mount('#app');",
    position: 'before',
    occurrence: 0,
  },
  existing_sdk: { action: 'none', name: null },
  rationale: 'This is the only user-facing app; it uses VITE_ and keeps Sentry.',
};

export const preview: ActionPreview = {
  entryFile: 'web/src/main.ts',
  manifestFile: 'web/package.json',
  addedDependency: '@opslane/sdk@^2.0.0',
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
      'init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY });',
    ],
  },
};
