import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runOnboardCore, type CoreDeps, type CoreEvent } from '../core.js';
import type { ApplyReport } from '../engine.js';
import type { DevServerHandle, ProcessCompletion } from '../process.js';
import type { RunLog } from '../runlog.js';
import { OPSLANE_SDK_VERSION, type OnboardingPlan } from '../tools.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A real directory on disk: the controller runs plan paths through
 * `containedRepoRelative`, which resolves them with `realpathSync`.
 */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'opslane-core-'));
  mkdirSync(join(repo, 'web', 'src'), { recursive: true });
  writeFileSync(join(repo, 'web', 'package.json'), '{"scripts":{"dev":"vite"}}\n');
  writeFileSync(join(repo, 'web', 'pnpm-lock.yaml'), '');
  writeFileSync(join(repo, 'web', 'src', 'main.ts'), '');
  return repo;
}

const root = makeRepo();

function fixturePlan(): OnboardingPlan {
  return {
    app_dir: 'web',
    framework: 'vue-vite',
    package_manager: 'pnpm',
    dev_script: 'dev',
    env_prefix: 'VITE_',
    dependency: { name: '@opslane/sdk', version: OPSLANE_SDK_VERSION },
    env_vars: { api_key: 'VITE_OPSLANE_API_KEY', endpoint: 'VITE_OPSLANE_ENDPOINT' },
    edit: {
      file: 'web/src/main.ts',
      entry_hash: createHash('sha256').update('').digest('hex'),
      manifest_file: 'web/package.json',
      manifest_hash: createHash('sha256').update('').digest('hex'),
      import_line: "import { init } from '@opslane/sdk';",
      init_block: 'init({});',
      anchor: "createApp(App).mount('#app');",
      position: 'before',
      occurrence: 0,
    },
    existing_sdk: { action: 'keep', name: null },
    rationale: 'Initialize before mount.',
  };
}

const EDITED = ['web/src/main.ts', 'web/package.json'];

function fixtureReport(installRequired = true): ApplyReport {
  return {
    editedFiles: [...EDITED],
    summary: 'Wired the Opslane SDK into the app entry point.',
    installRequired,
    installCwd: 'web',
  };
}

function fakeRunLog(): RunLog {
  return {
    path: '/dev/null',
    record: async () => undefined,
    addSecret: () => undefined,
    setSessionId: async () => undefined,
    finish: async () => undefined,
  };
}

type FakeServer = DevServerHandle & { stop: ReturnType<typeof vi.fn> };

/** `stop()` settles `completed`, exactly as a real terminated child does. */
function fakeServer(): FakeServer {
  let settle: (completion: ProcessCompletion) => void = () => undefined;
  const completed = new Promise<ProcessCompletion>((resolve) => {
    settle = resolve;
  });
  const stop = vi.fn(() => settle({ exitCode: null, signal: 'SIGTERM' }));
  return {
    pid: 1234,
    url: Promise.resolve('http://localhost:5173/'),
    completed,
    stop,
    restartCommand: 'pnpm run dev',
  };
}

interface DepsOverrides extends Partial<CoreDeps> {
  plan?: OnboardingPlan;
  installRequired?: boolean;
}

function deps(overrides: DepsOverrides = {}): CoreDeps {
  const { plan, installRequired, ...rest } = overrides;
  const activePlan = plan ?? fixturePlan();
  return {
    cwd: root,
    repo: 'acme/web',
    apiUrl: 'http://localhost:8082',
    tokenPath: join(root, 'tokens.json'),
    signal: new AbortController().signal,
    loginFn: async () => undefined,
    ensureLoggedIn: async () => ({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
    }),
    ensureProvisioned: async () => ({
      apiKey: 'opk_test',
      endpoint: 'http://localhost:8082',
      orgId: 'org-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      pollToken: 'poll-1',
    }),
    runDetect: async (options) => {
      options.onPlan(activePlan);
      return { ok: true, aborted: false };
    },
    runApply: async (options) => {
      options.onReport(fixtureReport(installRequired ?? true));
      return { ok: true, aborted: false, editedFiles: [...EDITED] };
    },
    requestApproval: async () => true,
    askUser: async ({ options }) => [options[0] ?? ''],
    confirm: async () => true,
    writeEnv: async (dir) => join(dir, '.env.local'),
    runCommand: async () => ({ ran: true, ok: true, exitCode: 0, signal: null }),
    startDevServer: () => fakeServer(),
    waitForAppReporting: async () => ({
      status: 'app_reporting' as const,
      apiKey: null,
      orgId: null,
      projectId: null,
      repo: null,
      message: null,
      failureReason: null,
      retryAfterSeconds: null,
    }),
    runLog: fakeRunLog(),
    emit: () => undefined,
    ...rest,
  };
}

describe('runOnboardCore lifecycle', () => {
  it('emits exactly one terminal stage on success', async () => {
    const events: CoreEvent[] = [];
    await expect(
      runOnboardCore(deps({ emit: (event) => events.push(event) })),
    ).resolves.toMatchObject({ ok: true, status: 'completed' });
    const terminal = events.filter((event) =>
      ['done', 'failed', 'unsupported', 'aborted'].includes(event.stage),
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.stage).toBe('done');
  });

  it('emits failed as the terminal stage when a step throws', async () => {
    const events: CoreEvent[] = [];
    await runOnboardCore(
      deps({
        emit: (event) => events.push(event),
        ensureProvisioned: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(events.at(-1)!.stage).toBe('failed');
  });

  it('emits aborted, not failed, when the signal is already aborted', async () => {
    const controller = new AbortController();
    const events: CoreEvent[] = [];
    await runOnboardCore(
      deps({
        signal: controller.signal,
        emit: (event) => events.push(event),
        ensureProvisioned: async () => {
          controller.abort();
          throw new Error('cancelled');
        },
      }),
    );
    expect(events.at(-1)!.stage).toBe('aborted');
  });

  it('records the session id and registers the api key as a secret', async () => {
    const setSessionId = vi.fn(async () => undefined);
    const addSecret = vi.fn();
    await runOnboardCore(deps({ runLog: { ...fakeRunLog(), setSessionId, addSecret } }));
    expect(addSecret).toHaveBeenCalledWith('opk_test');
    expect(setSessionId).toHaveBeenCalledWith('sess-1');
  });

  it('finishes the run log exactly once, even when a step throws', async () => {
    const finish = vi.fn(async () => undefined);
    await runOnboardCore(
      deps({
        runLog: { ...fakeRunLog(), finish },
        ensureProvisioned: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('never leaks a stack trace into the result message', async () => {
    const result = await runOnboardCore(
      deps({
        ensureProvisioned: async () => {
          throw new Error('ENOENT: no such file');
        },
      }),
    );
    expect(result.message).not.toMatch(/\bat \w+ \(/);
  });
});
