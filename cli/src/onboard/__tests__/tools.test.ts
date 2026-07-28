import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createAskUserTool,
  createFinishApplyTool,
  createOnboardServer,
  createReportPlanTool,
  OPSLANE_SDK_VERSION,
  type OnboardingPlan,
  type ReportedPlanInput,
} from '../tools.js';

const call = (tool: { handler: (input: never, extra: never) => Promise<unknown> }, input: unknown) =>
  tool.handler(input as never, {} as never);

describe('ask_user', () => {
  it('routes each tool instance to its own resolver', async () => {
    const tool = createAskUserTool(async ({ options }) => [options[1]!]);

    const result = await call(tool, { question: 'Which?', options: ['a', 'b'], multi: false });

    expect((result as { content: unknown[] }).content[0]).toEqual({
      type: 'text',
      text: 'User chose: b',
    });
  });

  it('fails closed when a resolver is not installed', async () => {
    const tool = createAskUserTool(null);

    await expect(call(tool, { question: 'Which?', options: ['a'], multi: false })).rejects.toThrow(
      /resolver not installed/i,
    );
  });
});

describe('report_plan', () => {
  let root: string;
  let entryFile: string;
  let entryContents: string;
  let manifestContents: string;
  let plan: ReportedPlanInput;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opslane-plan-'));
    mkdirSync(join(root, 'web', 'src'), { recursive: true });
    entryFile = join(root, 'web', 'src', 'main.ts');
    entryContents = "import App from './App.vue';\ncreateApp(App).mount('#app');\n";
    manifestContents = '{\n  "name": "web",\n  "scripts": { "dev": "vite" },\n  "dependencies": {}\n}\n';
    writeFileSync(entryFile, entryContents);
    writeFileSync(join(root, 'web', 'package.json'), manifestContents);
    plan = {
      app_dir: 'web',
      framework: 'vue-vite',
      package_manager: 'pnpm',
      dev_script: 'dev',
      env_prefix: 'VITE_',
      env_dir: 'web',
      dependency: { name: '@opslane/sdk' },
      env_vars: {
        api_key: 'VITE_OPSLANE_API_KEY',
        endpoint: 'VITE_OPSLANE_ENDPOINT',
      },
      edit: {
        file: 'web/src/main.ts',
        manifest_file: 'web/package.json',
        import_line: "import { init } from '@opslane/sdk';",
        init_block:
          'init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY, endpoint: import.meta.env.VITE_OPSLANE_ENDPOINT });',
        anchor: "createApp(App).mount('#app');",
        position: 'before',
        occurrence: 0,
      },
      existing_sdk: { action: 'keep', name: '@sentry/vue' },
      rationale: 'Initialize monitoring immediately before the application mounts.',
    };
  });

  const report = (value: unknown, onPlan: (accepted: OnboardingPlan) => void = () => undefined) =>
    call(createReportPlanTool(root, onPlan), value);

  // Every real monorepo in the eval corpus loads env vars from somewhere other
  // than the app directory. excalidraw sets `envDir: "../"` and hoppscotch sets
  // `envDir: path.resolve(__dirname, "../../")`, and both keep their .env files
  // at the repo root. Writing .env.local into app_dir produced an app that
  // installs, runs, and never reports, because the bundler never reads it.
  describe('env_dir', () => {
    it('accepts an env dir outside the app dir', async () => {
      let captured: OnboardingPlan | undefined;
      await report({ status: 'ok', plan: { ...plan, env_dir: '.' } }, (accepted) => {
        captured = accepted;
      });
      expect(captured?.env_dir).toBe('.');
      expect(captured?.app_dir).toBe('web');
    });

    it('rejects an env dir that escapes the repository', async () => {
      await expect(
        report({ status: 'ok', plan: { ...plan, env_dir: '../elsewhere' } }),
      ).rejects.toThrow();
    });

    it('rejects an env dir that is not a directory on disk', async () => {
      await expect(
        report({ status: 'ok', plan: { ...plan, env_dir: 'web/package.json' } }),
      ).rejects.toThrow(/directory/i);
    });
  });

  it('accepts and canonicalizes a valid plan exactly once', async () => {
    let captured: OnboardingPlan | undefined;
    const tool = createReportPlanTool(root, (accepted) => {
      captured = accepted;
    });
    const nonCanonical = {
      status: 'ok',
      plan: {
        ...plan,
        app_dir: join(root, 'web'),
        edit: { ...plan.edit, file: join(root, 'web', 'src', '..', 'src', 'main.ts') },
      },
    };

    await call(tool, nonCanonical);

    // The HOST stamps entry_hash from the file it already reads. The model never
    // supplies it — it has only Read/Glob/search and cannot compute a sha256, so
    // requiring it made report_plan unsatisfiable and starved the run of a plan.
    expect(captured).toEqual({
      ...plan,
      edit: {
        ...plan.edit,
        entry_hash: createHash('sha256').update(entryContents).digest('hex'),
        manifest_hash: createHash('sha256').update(manifestContents).digest('hex'),
      },
      dependency: { name: '@opslane/sdk', version: OPSLANE_SDK_VERSION },
    });
    await expect(call(tool, { status: 'ok', plan })).rejects.toThrow(/already/i);
  });

  it('keeps dev_script through the schema and reports it', async () => {
    let captured: OnboardingPlan | undefined;
    const tool = createReportPlanTool(root, (value) => {
      captured = value;
    });

    await call(tool, { status: 'ok', plan });

    expect(captured?.dev_script).toBe('dev');
  });

  it('rejects a dev_script that the app manifest does not declare', async () => {
    const tool = createReportPlanTool(root, () => undefined);

    await expect(
      call(tool, { status: 'ok', plan: { ...plan, dev_script: 'serve' } }),
    ).rejects.toThrow(/dev_script must be one of: dev/);
  });

  it('rejects a plan with no dev_script at all', async () => {
    const tool = createReportPlanTool(root, () => undefined);
    const { dev_script: _omitted, ...withoutDevScript } = plan;

    await expect(call(tool, { status: 'ok', plan: withoutDevScript })).rejects.toThrow();
  });

  it.each([
    ['an empty string field', () => ({ ...plan, framework: '' }), /non-empty/i],
    ['an app path escape', () => ({ ...plan, app_dir: '../outside' }), /contain/i],
    [
      'a secret edit file',
      () => {
        writeFileSync(join(root, 'web', '.env.production'), entryContents);
        return {
          ...plan,
          edit: {
            ...plan.edit,
            file: 'web/.env.production',
          },
        };
      },
      /secret/i,
    ],
    [
      'an edit outside app_dir',
      () => {
        writeFileSync(join(root, 'outside.ts'), entryContents);
        return {
          ...plan,
          edit: {
            ...plan.edit,
            file: 'outside.ts',
          },
        };
      },
      /app_dir/i,
    ],
    ['a missing edit file', () => ({ ...plan, edit: { ...plan.edit, file: 'web/src/nope.ts' } }), /exist/i],
    [
      'a manifest outside app_dir',
      () => {
        writeFileSync(join(root, 'package.json'), '{}\n');
        return { ...plan, edit: { ...plan.edit, manifest_file: 'package.json' } };
      },
      /app_dir/i,
    ],
    [
      'a non-package manifest',
      () => {
        writeFileSync(join(root, 'web', 'manifest.json'), '{}\n');
        return { ...plan, edit: { ...plan.edit, manifest_file: 'web/manifest.json' } };
      },
      /package\.json/i,
    ],
    [
      'a symlinked manifest escape',
      () => {
        const outside = mkdtempSync(join(tmpdir(), 'opslane-outside-'));
        writeFileSync(join(outside, 'package.json'), '{}\n');
        unlinkSync(join(root, 'web', 'package.json'));
        symlinkSync(join(outside, 'package.json'), join(root, 'web', 'package.json'));
        return plan;
      },
      /contain|regular/i,
    ],
    [
      'a variable outside the app prefix',
      () => ({ ...plan, env_vars: { ...plan.env_vars, api_key: 'NEXT_PUBLIC_OPSLANE_API_KEY' } }),
      /prefix/i,
    ],
    [
      'a variable borrowed from another product',
      () => ({ ...plan, env_vars: { ...plan.env_vars, api_key: 'VITE_APP_DEFENDER_API_KEY' } }),
      /opslane/i,
    ],
    ['an unknown package manager', () => ({ ...plan, package_manager: 'curl|sh' }), /package manager/i],
    ['an absent anchor', () => ({ ...plan, edit: { ...plan.edit, anchor: 'not in the file' } }), /anchor/i],
    [
      'a partial-line anchor',
      () => ({ ...plan, edit: { ...plan.edit, anchor: 'createApp(App)' } }),
      /complete non-whitespace content/i,
    ],
    [
      'an unavailable anchor occurrence',
      () => ({ ...plan, edit: { ...plan.edit, occurrence: 1 } }),
      /occurrence/i,
    ],
    [
      'an unknown existing SDK action',
      () => ({ ...plan, existing_sdk: { ...plan.existing_sdk, action: 'replace_everything' } }),
      /existing SDK action/i,
    ],
    [
      'an init block with an extra executable statement',
      () => ({
        ...plan,
        edit: {
          ...plan.edit,
          init_block: `${plan.edit.init_block}\nfetch('https://attacker.invalid');`,
        },
      }),
      /one direct Opslane init call/i,
    ],
    [
      'a side effect hidden inside an init option',
      () => ({
        ...plan,
        edit: {
          ...plan.edit,
          init_block:
            "init({ apiKey: (fetch('https://attacker.invalid'), import.meta.env.VITE_OPSLANE_API_KEY), endpoint: import.meta.env.VITE_OPSLANE_ENDPOINT });",
        },
      }),
      /apiKey option must directly reference/i,
    ],
    [
      'a bare variable instead of a concrete environment lookup',
      () => ({
        ...plan,
        edit: {
          ...plan.edit,
          init_block:
            'init({ apiKey: VITE_OPSLANE_API_KEY, endpoint: VITE_OPSLANE_ENDPOINT });',
        },
      }),
      /apiKey option must directly reference/i,
    ],
  ])('rejects %s', async (_name, makePlan, message) => {
    await expect(report({ status: 'ok', plan: makePlan() })).rejects.toThrow(message);
  });

  it('accepts an unsupported result without plan fields', async () => {
    let reason: string | undefined;
    let plans = 0;
    const tool = createReportPlanTool(
      root,
      () => {
        plans += 1;
      },
      (value) => {
        reason = value;
      },
    );

    await call(tool, { status: 'unsupported', reason: 'no web app: Go services only' });

    expect(reason).toBe('no web app: Go services only');
    expect(plans).toBe(0);
  });

  it.each([
    [{ status: 'unsupported', reason: '' }, /reason/i],
    [{ status: 'unsupported' }, /reason/i],
    [{ status: 'unsupported', reason: 'no web app', plan: {} }, /must not include a plan/i],
    [{ status: 'ok' }, /plan/i],
    [{ status: 'ok', plan: {}, reason: 'not applicable' }, /must not include.*reason/i],
  ])('rejects an incomplete discriminated result', async (input, message) => {
    await expect(report(input)).rejects.toThrow(message);
  });

  it('registers report_plan with an input schema on the MCP server', () => {
    const server = createOnboardServer(createReportPlanTool(root, () => undefined));
    const registered = (
      server.instance as unknown as {
        _registeredTools: Record<string, { inputSchema?: unknown }>;
      }
    )._registeredTools;

    expect(registered.report_plan?.inputSchema).toBeDefined();
  });

  it('host-pins the SDK version even when the model includes an attacker-controlled value', async () => {
    let captured: OnboardingPlan | undefined;
    await report(
      {
        status: 'ok',
        plan: {
          ...plan,
          dependency: { name: '@opslane/sdk', version: 'npm:attacker@latest' },
        },
      },
      (accepted) => {
        captured = accepted;
      },
    );

    expect(captured?.dependency.version).toBe(OPSLANE_SDK_VERSION);
    expect(JSON.stringify(captured)).not.toContain('attacker');
  });

  it('requires the reported package manager to match the nearest lockfile', async () => {
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    await expect(
      report({ status: 'ok', plan: { ...plan, package_manager: 'npm' } }),
    ).rejects.toThrow(/match pnpm lockfile/i);
  });
});

describe('finish_apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'opslane-finish-'));
  const state = () => ({ finished: false });

  it('canonicalizes a valid report and finishes only once', async () => {
    const runState = state();
    const reports: unknown[] = [];
    const finish = createFinishApplyTool(root, runState, (report) => reports.push(report));

    await call(finish, { edited_files: [join(root, 'src/main.ts')], summary: 'Applied plan.' });

    expect(reports).toEqual([
      { editedFiles: ['src/main.ts'], summary: 'Applied plan.' },
    ]);
    expect(runState.finished).toBe(true);
    await expect(
      call(finish, { edited_files: ['src/main.ts'], summary: 'Again.' }),
    ).rejects.toThrow(/already|finished/i);
  });

  it.each([
    [{ edited_files: [], summary: 'None.' }, /too small|at least|array/i],
    [{ edited_files: ['../outside.ts'], summary: 'Escape.' }, /contain/i],
    [{ edited_files: ['.env.production'], summary: 'Secret.' }, /secret/i],
    [{ edited_files: ['src/main.ts', 'src/main.ts'], summary: 'Duplicate.' }, /duplicate/i],
  ])('rejects an invalid report without flipping state', async (input, message) => {
    const runState = state();
    const finish = createFinishApplyTool(root, runState, () => undefined);

    await expect(call(finish, input)).rejects.toThrow(message);
    expect(runState.finished).toBe(false);
  });

  it('rejects finish while an edit is unsettled', async () => {
    const runState = state();
    const finish = createFinishApplyTool(root, runState, () => undefined, () => false);

    await expect(
      call(finish, { edited_files: ['src/main.ts'], summary: 'Too soon.' }),
    ).rejects.toThrow(/unsettled/i);
    expect(runState.finished).toBe(false);
  });
});
