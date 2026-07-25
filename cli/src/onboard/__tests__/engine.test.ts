import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyOptions,
  detectOptions,
  runApply,
  runDetect,
  type ApplyReport,
  type QueryFn,
} from '../engine.js';
import {
  OPSLANE_SDK_VERSION,
  type OnboardingPlan,
  type ReportPlanInput,
  type ReportedPlanInput,
} from '../tools.js';

const originalApiKey = process.env.ANTHROPIC_API_KEY;

const stub = (messages: unknown[]): ReturnType<QueryFn> => ({
  [Symbol.asyncIterator]: async function* () {
    for (const message of messages) yield message as never;
  },
});

function fixture(): { root: string; report: ReportPlanInput; plan: OnboardingPlan } {
  const root = mkdtempSync(join(tmpdir(), 'opslane-engine-'));
  mkdirSync(join(root, 'src'));
  const contents = "createApp(App).mount('#app');\n";
  const manifest =
    '{\n  "name": "fixture",\n  "scripts": { "dev": "vite" },\n  "dependencies": {}\n}\n';
  writeFileSync(join(root, 'src', 'main.ts'), contents);
  writeFileSync(join(root, 'package.json'), manifest);
  const plan: OnboardingPlan = {
    app_dir: '.',
    framework: 'vue-vite',
    package_manager: 'pnpm',
    dev_script: 'dev',
    env_prefix: 'VITE_',
    dependency: { name: '@opslane/sdk', version: OPSLANE_SDK_VERSION },
    env_vars: {
      api_key: 'VITE_OPSLANE_API_KEY',
      endpoint: 'VITE_OPSLANE_ENDPOINT',
    },
    edit: {
      file: 'src/main.ts',
      entry_hash: createHash('sha256').update(contents).digest('hex'),
      manifest_file: 'package.json',
      manifest_hash: createHash('sha256').update(manifest).digest('hex'),
      import_line: "import { init } from '@opslane/sdk';",
      init_block:
        'init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY, endpoint: import.meta.env.VITE_OPSLANE_ENDPOINT });',
      anchor: "createApp(App).mount('#app');",
      position: 'before',
      occurrence: 0,
    },
    existing_sdk: { action: 'keep', name: '@sentry/vue' },
    rationale: 'Initialize before the application mount.',
  };
  const reported: ReportedPlanInput = plan;
  return { root, plan, report: { status: 'ok', plan: reported } };
}

type RegisteredTool = {
  handler: (input: unknown, extra: unknown) => Promise<unknown>;
};

function reportQuery(
  input: ReportPlanInput,
  {
    duplicateRejectedAttempt = false,
    terminalSubtype = 'success',
  }: {
    duplicateRejectedAttempt?: boolean;
    terminalSubtype?: string;
  } = {},
): QueryFn {
  return (request) => ({
    [Symbol.asyncIterator]: async function* () {
      const onboardServer = request.options?.mcpServers?.onboard as unknown as {
        instance: { _registeredTools: Record<string, RegisteredTool> };
      };
      await onboardServer.instance._registeredTools.report_plan!.handler(input, {});
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'report-1', name: 'mcp__onboard__report_plan', input },
          ],
        },
      } as never;
      yield {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'report-1', is_error: false }],
        },
      } as never;
      if (duplicateRejectedAttempt) {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'report-2', name: 'mcp__onboard__report_plan', input },
            ],
          },
        } as never;
        await expect(
          onboardServer.instance._registeredTools.report_plan!.handler(input, {}),
        ).rejects.toThrow(/already/i);
        yield {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'report-2', is_error: true }],
          },
        } as never;
      }
      yield { type: 'result', subtype: terminalSubtype } as never;
    },
  });
}

function appliedContents(plan: OnboardingPlan): { entry: string; manifest: string } {
  return {
    entry: `${plan.edit.import_line}\n${plan.edit.init_block}\n${plan.edit.anchor}\n`,
    manifest: `{\n  "name": "fixture",\n  "scripts": { "dev": "vite" },\n  "dependencies": {\n    "@opslane/sdk": "${plan.dependency.version}"\n  }\n}\n`,
  };
}

function applyQuery(
  plan: OnboardingPlan,
  {
    reportedFiles = [plan.edit.file, plan.edit.manifest_file],
    entry = appliedContents(plan).entry,
    manifest = appliedContents(plan).manifest,
    lateEntry,
    duplicateEntryCommit = false,
  }: {
    reportedFiles?: string[];
    entry?: string;
    manifest?: string;
    lateEntry?: string;
    duplicateEntryCommit?: boolean;
  } = {},
): QueryFn {
  return (request) => ({
    [Symbol.asyncIterator]: async function* () {
      const onboardServer = request.options?.mcpServers?.onboard as unknown as {
        instance: { _registeredTools: Record<string, RegisteredTool> };
      };
      const editUse = (id: string, file: string) =>
        ({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file } }],
          },
        }) as never;
      const editResult = (id: string) =>
        ({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: id, is_error: false }],
          },
        }) as never;

      yield editUse('entry-edit', plan.edit.file);
      writeFileSync(join(request.options!.cwd!, plan.edit.file), entry);
      yield editResult('entry-edit');
      if (duplicateEntryCommit) {
        yield editUse('entry-edit-2', plan.edit.file);
        yield editResult('entry-edit-2');
      }
      yield editUse('manifest-edit', plan.edit.manifest_file);
      writeFileSync(join(request.options!.cwd!, plan.edit.manifest_file), manifest);
      yield editResult('manifest-edit');

      const finishInput = { edited_files: reportedFiles, summary: 'Applied approved plan.' };
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'finish-apply',
              name: 'mcp__onboard__finish_apply',
              input: finishInput,
            },
          ],
        },
      } as never;
      await onboardServer.instance._registeredTools.finish_apply!.handler(finishInput, {});
      yield {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'finish-apply', is_error: false },
          ],
        },
      } as never;

      if (lateEntry !== undefined) {
        yield editUse('late-edit', plan.edit.file);
        writeFileSync(join(request.options!.cwd!, plan.edit.file), lateEntry);
        yield editResult('late-edit');
      }
      yield { type: 'result', subtype: 'success' } as never;
    },
  });
}

function concurrentFinishQuery(plan: OnboardingPlan): QueryFn {
  return (request) => ({
    [Symbol.asyncIterator]: async function* () {
      const onboardServer = request.options?.mcpServers?.onboard as unknown as {
        instance: { _registeredTools: Record<string, RegisteredTool> };
      };
      const premature = {
        edited_files: [plan.edit.file, plan.edit.manifest_file],
        summary: 'Premature.',
      };
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'entry-edit',
              name: 'Edit',
              input: { file_path: plan.edit.file },
            },
            {
              type: 'tool_use',
              id: 'manifest-edit',
              name: 'Edit',
              input: { file_path: plan.edit.manifest_file },
            },
            {
              type: 'tool_use',
              id: 'premature-finish',
              name: 'mcp__onboard__finish_apply',
              input: premature,
            },
          ],
        },
      } as never;
      const applied = appliedContents(plan);
      writeFileSync(join(request.options!.cwd!, plan.edit.file), applied.entry);
      writeFileSync(join(request.options!.cwd!, plan.edit.manifest_file), applied.manifest);
      await expect(
        onboardServer.instance._registeredTools.finish_apply!.handler(premature, {}),
      ).rejects.toThrow(/unsettled/i);
      yield {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'premature-finish', is_error: true },
            { type: 'tool_result', tool_use_id: 'entry-edit', is_error: false },
            { type: 'tool_result', tool_use_id: 'manifest-edit', is_error: false },
          ],
        },
      } as never;

      const accepted = { ...premature, summary: 'Applied after edits settled.' };
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'accepted-finish',
              name: 'mcp__onboard__finish_apply',
              input: accepted,
            },
          ],
        },
      } as never;
      await onboardServer.instance._registeredTools.finish_apply!.handler(accepted, {});
      yield {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'accepted-finish', is_error: false },
          ],
        },
      } as never;
      yield { type: 'result', subtype: 'success' } as never;
    },
  });
}

function rehashPlan(root: string, plan: OnboardingPlan): OnboardingPlan {
  return {
    ...plan,
    edit: {
      ...plan.edit,
      entry_hash: createHash('sha256')
        .update(readFileSync(join(root, plan.edit.file)))
        .digest('hex'),
      manifest_hash: createHash('sha256')
        .update(readFileSync(join(root, plan.edit.manifest_file)))
        .digest('hex'),
    },
  };
}

describe('detect-stage engine', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-only';
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('locks the SDK permission and configuration gates', async () => {
    const options = detectOptions({
      cwd: '/r',
      hook: async () => ({}),
      mcpServers: {},
      abortController: new AbortController(),
    });

    expect(options.permissionMode).toBe('default');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools).toEqual([
      'mcp__onboard__report_plan',
      'mcp__onboard__ask_user',
    ]);
    expect(options.tools).toEqual(['Read', 'Glob']);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining([
        'Grep',
        'Write',
        'Edit',
        'MultiEdit',
        'Bash',
        'WebFetch',
        'WebSearch',
      ]),
    );
    expect(options.disallowedTools).not.toContain('Read');
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(options.maxTurns).toBe(50);
    await expect(options.canUseTool?.('Read', {}, {} as never)).resolves.toMatchObject({
      behavior: 'allow',
    });
    await expect(
      options.canUseTool?.('mcp__onboard__search', {}, {} as never),
    ).resolves.toMatchObject({ behavior: 'allow' });
    await expect(options.canUseTool?.('Bash', {}, {} as never)).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('maps one validated plan and a clean result to success', async () => {
    const { root, report, plan } = fixture();
    const captured: OnboardingPlan[] = [];
    const seen: unknown[] = [];

    const result = await runDetect({
      cwd: root,
      onMessage: (message) => seen.push(message),
      onPlan: (accepted) => captured.push(accepted),
      signal: new AbortController().signal,
      queryFn: reportQuery(report),
    });

    expect(result).toEqual({ ok: true, aborted: false, subtype: 'success' });
    expect(captured).toEqual([plan]);
    expect(seen).toHaveLength(3);
  });

  it('rejects a clean result with no validated plan', async () => {
    const { root } = fixture();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: () => stub([{ type: 'result', subtype: 'success' }]),
    });

    expect(result).toMatchObject({ ok: false, reason: 'no_plan' });
  });

  it('rejects a second report attempt after a plan was accepted', async () => {
    const { root, report } = fixture();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: reportQuery(report, { duplicateRejectedAttempt: true }),
    });

    expect(result).toMatchObject({ ok: false, reason: 'multiple_plans' });
  });

  it('allows a rejected invalid report to be corrected once', async () => {
    const { root, report, plan } = fixture();
    const invalid = {
      status: 'ok',
      plan: { ...plan, framework: '' },
    } as ReportPlanInput;
    const queryFn: QueryFn = (request) => ({
      [Symbol.asyncIterator]: async function* () {
        const onboardServer = request.options?.mcpServers?.onboard as unknown as {
          instance: { _registeredTools: Record<string, RegisteredTool> };
        };
        const reportTool = onboardServer.instance._registeredTools.report_plan!;

        await expect(reportTool.handler(invalid, {})).rejects.toThrow(/non-empty/i);
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'invalid-report',
                name: 'mcp__onboard__report_plan',
                input: invalid,
              },
            ],
          },
        } as never;
        yield {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'invalid-report', is_error: true },
            ],
          },
        } as never;

        await reportTool.handler(report, {});
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'valid-report',
                name: 'mcp__onboard__report_plan',
                input: report,
              },
            ],
          },
        } as never;
        yield {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'valid-report', is_error: false },
            ],
          },
        } as never;
        yield { type: 'result', subtype: 'success' } as never;
      },
    });

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('maps unsupported as a distinct non-error outcome without calling onPlan', async () => {
    const { root } = fixture();
    let plans = 0;

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => {
        plans += 1;
      },
      signal: new AbortController().signal,
      queryFn: reportQuery({
        status: 'unsupported',
        reason: 'no web app: only Go services and documentation',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      aborted: false,
      subtype: 'success',
      reason: 'unsupported',
    });
    expect(plans).toBe(0);
  });

  it('returns the agent explanation when the repo is unsupported', async () => {
    const { root } = fixture();

    const result = await runDetect({
      cwd: root,
      signal: new AbortController().signal,
      onMessage: () => undefined,
      onPlan: () => undefined,
      queryFn: reportQuery({
        status: 'unsupported',
        reason: 'this repository has no web application',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'unsupported',
      unsupportedReason: 'this repository has no web application',
    });
  });

  it.each([
    ['an error result', [{ type: 'result', subtype: 'error_max_turns' }], 'error_max_turns'],
    ['a missing result', [], 'missing_result'],
  ])('maps %s to failure', async (_name, messages, reason) => {
    const { root } = fixture();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: () => stub(messages),
    });

    expect(result).toMatchObject({ ok: false, reason });
  });

  it('handles an already-aborted caller signal without querying', async () => {
    const { root } = fixture();
    const controller = new AbortController();
    let queried = false;
    controller.abort();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: controller.signal,
      queryFn: () => {
        queried = true;
        return stub([]);
      },
    });

    expect(result).toMatchObject({ ok: false, aborted: true, reason: 'aborted' });
    expect(queried).toBe(false);
  });

  it('propagates a caller abort that happens during iteration', async () => {
    const { root } = fixture();
    const controller = new AbortController();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: controller.signal,
      queryFn: () => ({
        [Symbol.asyncIterator]: async function* () {
          controller.abort();
          yield { type: 'result', subtype: 'success' } as never;
        },
      }),
    });

    expect(result).toMatchObject({ ok: false, aborted: true, reason: 'aborted' });
  });

  it('fails cleanly before querying when the API key is missing', async () => {
    const { root } = fixture();
    delete process.env.ANTHROPIC_API_KEY;
    let queried = false;

    try {
      const result = await runDetect({
        cwd: root,
        onMessage: () => undefined,
        onPlan: () => undefined,
        signal: new AbortController().signal,
        queryFn: () => {
          queried = true;
          return stub([]);
        },
      });

      expect(result).toMatchObject({ ok: false, aborted: false, reason: 'no_api_key' });
      expect(queried).toBe(false);
    } finally {
      process.env.ANTHROPIC_API_KEY = 'test-only';
    }
  });

  it('maps query failures without throwing', async () => {
    const { root } = fixture();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: () => {
        throw new Error('subprocess failed');
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'subprocess failed' });
  });

  it('allows intentional report_plan and ask_user shadow warnings', async () => {
    const { root, report } = fixture();
    const warning = Object.assign(
      new Error(
        'canUseTool will not be invoked for: mcp__onboard__report_plan, mcp__onboard__ask_user. Bare allowedTools entries auto-approve these tools.',
      ),
      { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' },
    );
    const queryFn = reportQuery(report);

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: (request) => {
        process.emit('warning', warning);
        return queryFn(request);
      },
    });

    expect(result.ok).toBe(true);
  });

  it('aborts safely on an unexpected permission-shadow warning', async () => {
    const { root } = fixture();
    const warning = Object.assign(
      new Error(
        'canUseTool will not be invoked for: Edit. Bare allowedTools entries auto-approve this tool.',
      ),
      { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' },
    );

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: () => {
        process.emit('warning', warning);
        return stub([{ type: 'result', subtype: 'success' }]);
      },
    });

    expect(result).toMatchObject({ ok: false, aborted: false });
    expect(result.reason).toMatch(/shadowed.*Edit/i);
  });
});

describe('apply-stage engine', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-only';
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('locks the SDK permission and tool gates', async () => {
    const options = applyOptions({
      cwd: '/r',
      hook: async () => ({}),
      mcpServers: {},
      canUseTool: async () => ({ behavior: 'deny', message: 'test' }),
      abortController: new AbortController(),
    });

    expect(options.cwd).toBe('/r');
    expect(options.permissionMode).toBe('default');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools).toEqual([]);
    expect(options.tools).toEqual(['Read', 'Edit', 'Write']);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Grep', 'Glob', 'MultiEdit', 'Bash', 'WebFetch', 'WebSearch']),
    );
    expect(options.maxTurns).toBe(30);
  });

  it.each([
    ['entry hash', (plan: OnboardingPlan) => ({ ...plan, edit: { ...plan.edit, entry_hash: 'stale' } }), 'stale_plan'],
    [
      'manifest hash',
      (plan: OnboardingPlan) => ({ ...plan, edit: { ...plan.edit, manifest_hash: 'stale' } }),
      'stale_manifest',
    ],
    [
      'anchor',
      (plan: OnboardingPlan) => ({ ...plan, edit: { ...plan.edit, anchor: 'moved anchor' } }),
      'anchor_moved',
    ],
    [
      'migration',
      (plan: OnboardingPlan) => ({
        ...plan,
        existing_sdk: { action: 'migrate' as const, name: '@sentry/vue' },
      }),
      'migrate_unsupported',
    ],
    [
      'manifest outside the app directory',
      (plan: OnboardingPlan) => ({ ...plan, app_dir: 'src' }),
      'invalid_manifest',
    ],
    [
      'untrusted dependency version',
      (plan: OnboardingPlan) => ({
        ...plan,
        dependency: { ...plan.dependency, version: 'npm:attacker@latest' },
      }),
      'invalid_dependency',
    ],
    [
      'untrusted package manager',
      (plan: OnboardingPlan) => ({
        ...plan,
        package_manager: 'curl | sh' as OnboardingPlan['package_manager'],
      }),
      'invalid_package_manager',
    ],
  ])('rejects stale or unsupported %s before querying', async (_name, mutate, reason) => {
    const { root, plan } = fixture();
    let queried = false;

    const result = await runApply({
      cwd: root,
      plan: mutate(plan),
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => {
        queried = true;
        return stub([]);
      },
    });

    expect(result).toMatchObject({ ok: false, reason });
    expect(queried).toBe(false);
  });

  it('mechanically confirms no-op as a distinct already-onboarded outcome', async () => {
    const { root, plan: original } = fixture();
    const applied = appliedContents(original);
    writeFileSync(join(root, original.edit.file), applied.entry);
    writeFileSync(join(root, original.edit.manifest_file), applied.manifest);
    const plan = rehashPlan(root, {
      ...original,
      existing_sdk: { action: 'no_op', name: null },
    });
    const reports: ApplyReport[] = [];

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: (report) => reports.push(report),
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => {
        throw new Error('no-op must not query');
      },
    });

    expect(result).toMatchObject({
      ok: true,
      subtype: 'already_onboarded',
      editedFiles: [],
      installRequired: false,
    });
    expect(reports).toHaveLength(1);
  });

  it('rejects a package manager that conflicts with the nearest lockfile', async () => {
    const { root, plan } = fixture();
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const result = await runApply({
      cwd: root,
      plan: { ...plan, package_manager: 'npm' },
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => {
        throw new Error('lockfile mismatch must not query');
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_package_manager' });
  });

  it('rejects an unproven no-op without querying', async () => {
    const { root, plan } = fixture();

    const result = await runApply({
      cwd: root,
      plan: { ...plan, existing_sdk: { action: 'no_op', name: null } },
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => {
        throw new Error('invalid no-op must not query');
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_no_op' });
  });

  it('applies, verifies, reconciles, and reports trusted install follow-up', async () => {
    const { root, plan } = fixture();
    const reports: ApplyReport[] = [];

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: (report) => reports.push(report),
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: applyQuery(plan),
    });

    expect(result).toMatchObject({
      ok: true,
      subtype: 'success',
      editedFiles: ['src/main.ts', 'package.json'],
      installRequired: true,
      installCommand: 'pnpm install',
      installCwd: '.',
    });
    expect(reports).toEqual([
      {
        editedFiles: ['src/main.ts', 'package.json'],
        summary: 'Applied approved plan.',
        installRequired: true,
        installCommand: 'pnpm install',
        installCwd: '.',
      },
    ]);
  });

  it('reconciles duplicate committed edits to one file as canonical sets', async () => {
    const { root, plan } = fixture();

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: applyQuery(plan, { duplicateEntryCommit: true }),
    });

    expect(result.ok).toBe(true);
  });

  it('rejects finish issued concurrently with unsettled edits, then accepts a retry', async () => {
    const { root, plan } = fixture();

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: concurrentFinishQuery(plan),
    });

    expect(result.ok).toBe(true);
  });

  it('rolls both files back when report reconciliation fails', async () => {
    const { root, plan } = fixture();
    const beforeEntry = readFileSync(join(root, plan.edit.file));
    const beforeManifest = readFileSync(join(root, plan.edit.manifest_file));

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: applyQuery(plan, { reportedFiles: [plan.edit.file] }),
    });

    expect(result).toMatchObject({ ok: false, reason: 'edit_reconciliation_failed' });
    expect(readFileSync(join(root, plan.edit.file))).toEqual(beforeEntry);
    expect(readFileSync(join(root, plan.edit.manifest_file))).toEqual(beforeManifest);
  });

  it('rolls back a verified apply when the external report callback fails', async () => {
    const { root, plan } = fixture();
    const beforeEntry = readFileSync(join(root, plan.edit.file));
    const beforeManifest = readFileSync(join(root, plan.edit.manifest_file));

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => {
        throw new Error('report sink unavailable');
      },
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: applyQuery(plan),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'report_callback_failed: report sink unavailable',
    });
    expect(readFileSync(join(root, plan.edit.file))).toEqual(beforeEntry);
    expect(readFileSync(join(root, plan.edit.manifest_file))).toEqual(beforeManifest);
  });

  it('rejects a clean terminal result with no apply report', async () => {
    const { root, plan } = fixture();

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => stub([{ type: 'result', subtype: 'success' }]),
    });

    expect(result).toMatchObject({ ok: false, reason: 'no_apply_report' });
  });

  it('rejects an edit committed after finish and restores the snapshot', async () => {
    const { root, plan } = fixture();
    const beforeEntry = readFileSync(join(root, plan.edit.file));

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: applyQuery(plan, { lateEntry: 'late mutation\n' }),
    });

    expect(result).toMatchObject({ ok: false, reason: 'edits_after_finish' });
    expect(readFileSync(join(root, plan.edit.file))).toEqual(beforeEntry);
  });

  it('rolls back exact bytes when deterministic verification fails', async () => {
    const { root, plan } = fixture();
    const beforeEntry = readFileSync(join(root, plan.edit.file));
    const beforeManifest = readFileSync(join(root, plan.edit.manifest_file));

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: applyQuery(plan, { entry: `${appliedContents(plan).entry}{` }),
    });

    expect(result).toMatchObject({ ok: false, reason: 'verification_failed' });
    expect(result.failures).toContain('entry file has a syntax error');
    expect(readFileSync(join(root, plan.edit.file))).toEqual(beforeEntry);
    expect(readFileSync(join(root, plan.edit.manifest_file))).toEqual(beforeManifest);
  });

  it('restores the snapshot when the agent lifecycle throws after an edit', async () => {
    const { root, plan } = fixture();
    const beforeEntry = readFileSync(join(root, plan.edit.file));
    const queryFn: QueryFn = (request) => ({
      [Symbol.asyncIterator]: async function* () {
        writeFileSync(join(request.options!.cwd!, plan.edit.file), 'partial mutation\n');
        throw new Error('agent crashed');
      },
    });

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn,
    });

    expect(result).toMatchObject({ ok: false, reason: 'agent crashed' });
    expect(readFileSync(join(root, plan.edit.file))).toEqual(beforeEntry);
  });

  it('restores the snapshot when the caller aborts after a partial edit', async () => {
    const { root, plan } = fixture();
    const beforeEntry = readFileSync(join(root, plan.edit.file));
    const controller = new AbortController();
    const queryFn: QueryFn = (request) => ({
      [Symbol.asyncIterator]: async function* () {
        writeFileSync(join(request.options!.cwd!, plan.edit.file), 'partial mutation\n');
        controller.abort();
        yield { type: 'result', subtype: 'success' } as never;
      },
    });

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: controller.signal,
      queryFn,
    });

    expect(result).toMatchObject({ ok: false, aborted: true, reason: 'aborted' });
    expect(readFileSync(join(root, plan.edit.file))).toEqual(beforeEntry);
  });

  it('returns a distinct restore failure without following a swapped symlink', async () => {
    const { root, plan } = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'opslane-restore-outside-'));
    const outsideFile = join(outside, 'outside.ts');
    writeFileSync(outsideFile, 'outside remains unchanged\n');
    const queryFn: QueryFn = (request) => ({
      [Symbol.asyncIterator]: async function* () {
        const entry = join(request.options!.cwd!, plan.edit.file);
        unlinkSync(entry);
        symlinkSync(outsideFile, entry);
        throw new Error('agent failed after path swap');
      },
    });

    const result = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn,
    });

    expect(result).toMatchObject({ ok: false, reason: 'restore_failed' });
    expect(result.restoreFailures?.[0]).toMatch(/src\/main\.ts/);
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside remains unchanged\n');
  });
});

describe('Detect → Apply controller integration', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-only';
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('hands the host-validated plan into the exact apply path', async () => {
    const { root, report } = fixture();
    let detected: OnboardingPlan | undefined;

    const detect = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: (plan) => {
        detected = plan;
      },
      signal: new AbortController().signal,
      queryFn: reportQuery(report),
    });
    expect(detect.ok).toBe(true);
    expect(detected).toBeDefined();

    const plan = detected!;
    const apply = await runApply({
      cwd: root,
      plan,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: applyQuery(plan),
    });

    expect(apply).toMatchObject({
      ok: true,
      installRequired: true,
      installCommand: 'pnpm install',
    });
    expect(readFileSync(join(root, plan.edit.file), 'utf8')).toContain(plan.edit.init_block);
  });
});
