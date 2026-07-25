import { describe, expect, it } from 'vitest';

import { renderApplySpec, renderDetectSpec } from '../spec.js';
import type { OnboardingPlan } from '../tools.js';

describe('detect-stage agent specification', () => {
  it('frames a read-only repository investigation and report', () => {
    const spec = renderDetectSpec({ cwd: '/repo/x' });

    expect(spec).toContain('/repo/x');
    expect(spec.toLowerCase()).toContain('read the repository');
    expect(spec).toMatch(/name them after opslane/i);
    expect(spec).toMatch(/never borrow another product/i);
    expect(spec).toMatch(/use the repo's own prefix/i);
    for (const required of [
      'goal',
      'read',
      'report_plan',
      'ask_user',
      'primary user-facing web app',
      'multi:false',
      'no edit tools',
      'unsupported',
    ]) {
      expect(spec.toLowerCase()).toContain(required);
    }
  });

  it('requires one structured report grounded in the selected app', () => {
    const spec = renderDetectSpec({ cwd: '/repo/x' });

    expect(spec).toContain('@opslane/sdk');
    expect(spec).toMatch(/select exactly one/i);
    expect(spec).toMatch(/exactly once/i);
    expect(spec).toMatch(/coexist/i);
    expect(spec).toContain('import_line');
    expect(spec).toContain('init_block');
    expect(spec).toMatch(/anchor[\s\S]{0,100}init block|init block[\s\S]{0,100}anchor/i);
    expect(spec).toMatch(/import_line[\s\S]{0,100}module top level/i);
    expect(spec).toContain('manifest_file');
    expect(spec).toContain('dev_script');
    expect(spec).toMatch(/exact key[\s\S]{0,120}package\.json "scripts"/i);
    expect(spec).toMatch(/host pins the SDK version/i);
    expect(spec).not.toMatch(/\bedit or write\b/i);
  });
});

describe('apply-stage agent specification', () => {
  const plan: OnboardingPlan = {
    app_dir: 'web',
    framework: 'vue-vite',
    package_manager: 'pnpm',
    dev_script: 'dev',
    env_prefix: 'VITE_',
    dependency: { name: '@opslane/sdk', version: '^1.2.0' },
    env_vars: {
      api_key: 'VITE_OPSLANE_API_KEY',
      endpoint: 'VITE_OPSLANE_ENDPOINT',
    },
    edit: {
      file: 'web/src/main.ts',
      entry_hash: 'entry-hash',
      manifest_file: 'web/package.json',
      manifest_hash: 'manifest-hash',
      import_line: "import { init } from '@opslane/sdk';",
      init_block:
        'init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY, endpoint: import.meta.env.VITE_OPSLANE_ENDPOINT });',
      anchor: "createApp(App).mount('#app');",
      position: 'before',
      occurrence: 0,
    },
    existing_sdk: { action: 'none', name: null },
    rationale: 'Initialize before mount.',
  };

  it('renders the exact approved operations and narrow safety contract', () => {
    const spec = renderApplySpec({ cwd: '/repo/x', plan });

    for (const required of [
      '/repo/x',
      plan.edit.file,
      plan.edit.manifest_file,
      plan.edit.import_line,
      plan.edit.init_block,
      plan.edit.anchor,
      plan.dependency.version,
      'finish_apply',
      'top level',
      'Change nothing else',
      'Do not run installs',
      'Migration is unsupported',
    ]) {
      expect(spec).toContain(required);
    }
    expect(spec).toMatch(/do not reformat unrelated/i);
    expect(spec).toMatch(/make no edits or other tool calls after finish_apply/i);
  });

  it('renders an explicit migrate refusal', () => {
    const spec = renderApplySpec({
      cwd: '/repo/x',
      plan: {
        ...plan,
        existing_sdk: { action: 'migrate', name: '@sentry/vue' },
      },
    });

    expect(spec).toMatch(/migration is unsupported/i);
    expect(spec).toMatch(/never attempt a partial migration/i);
  });
});
