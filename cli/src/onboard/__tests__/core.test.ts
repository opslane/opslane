import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { runOnboardCore, type CoreDeps, type CoreEvent } from '../core.js';
import type { ApplyReport } from '../engine.js';
import type { TaskLine } from '../events.js';
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

const toolUse = (id: string, name: string): SDKMessage =>
  ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: {} }] },
  }) as unknown as SDKMessage;

const toolResult = (id: string, { isError = false } = {}): SDKMessage =>
  ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
  }) as unknown as SDKMessage;

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

  it('drains queued run-log records before finishing', async () => {
    const order: string[] = [];
    const runLog: RunLog = {
      ...fakeRunLog(),
      record: async () => {
        await delay(5);
        order.push('record');
      },
      finish: async () => {
        order.push('finish');
      },
    };
    await runOnboardCore(
      deps({
        runLog,
        runDetect: async (options) => {
          options.onMessage(toolUse('t1', 'Read'));
          options.onPlan(fixturePlan());
          return { ok: true, aborted: false };
        },
      }),
    );
    expect(order.at(-1)).toBe('finish');
    expect(order.filter((entry) => entry === 'record').length).toBeGreaterThan(0);
  });
});

describe('runOnboardCore detect stage', () => {
  it('stops with the agent explanation when the repo is unsupported', async () => {
    const d = deps({
      runDetect: async () => ({
        ok: false,
        aborted: false,
        reason: 'unsupported',
        unsupportedReason: 'this repository has no web application',
      }),
    });
    await expect(runOnboardCore(d)).resolves.toMatchObject({
      ok: false,
      status: 'unsupported',
      message: 'this repository has no web application',
    });
  });

  it('never writes env or polls when detect fails', async () => {
    const writeEnv = vi.fn<CoreDeps['writeEnv']>(async () => '/unused/.env.local');
    const waitForAppReporting = vi.fn<CoreDeps['waitForAppReporting']>();
    const d = deps({
      runDetect: async () => ({ ok: false, aborted: false, reason: 'no_plan' }),
      writeEnv,
      waitForAppReporting,
    });
    await expect(runOnboardCore(d)).resolves.toMatchObject({ ok: false, status: 'failed' });
    expect(writeEnv).not.toHaveBeenCalled();
    expect(waitForAppReporting).not.toHaveBeenCalled();
  });

  it('forwards the human answer back to the agent', async () => {
    let answer: string[] | undefined;
    const d = deps({
      askUser: async ({ options }) => [options[1]!],
      runDetect: async (options) => {
        answer = await options.askUser!({
          question: 'Which app?',
          options: ['web', 'admin'],
          multi: false,
        });
        options.onPlan(fixturePlan());
        return { ok: true, aborted: false };
      },
    });
    await runOnboardCore(d);
    expect(answer).toEqual(['admin']); // the ANSWER, not just that we asked
  });
});

describe('runOnboardCore apply stage', () => {
  it('writes no env and never polls when apply fails', async () => {
    const writeEnv = vi.fn<CoreDeps['writeEnv']>(async () => '/unused/.env.local');
    const waitForAppReporting = vi.fn<CoreDeps['waitForAppReporting']>();
    const d = deps({
      runApply: async () => ({
        ok: false,
        aborted: false,
        reason: 'verification_failed',
        failures: [
          'manifest does not contain an identity-capable Opslane SDK version (>=1.2.0)',
        ],
      }),
      writeEnv,
      waitForAppReporting,
    });
    const result = await runOnboardCore(d);
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.message).toMatch(/identity-capable/);
    expect(writeEnv).not.toHaveBeenCalled();
    expect(waitForAppReporting).not.toHaveBeenCalled();
  });

  it('rejects a report whose editedFiles disagree with the engine', async () => {
    const d = deps({
      runApply: async (options) => {
        options.onReport({
          editedFiles: ['web/src/main.ts'],
          summary: 'x',
          installRequired: true,
          installCwd: 'web',
        });
        return {
          ok: true,
          aborted: false,
          editedFiles: ['web/src/main.ts', 'web/package.json'],
        };
      },
    });
    const result = await runOnboardCore(d);
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.message).toMatch(/report.*match|reconcil/i);
  });

  it('starts the apply task list empty rather than reusing detect tasks', async () => {
    const seen: TaskLine[][] = [];
    await runOnboardCore(
      deps({
        emit: (event) => {
          if (event.stage === 'apply' && event.tasks) seen.push(event.tasks);
        },
        runDetect: async (options) => {
          options.onMessage(toolUse('t1', 'Read'));
          options.onMessage(toolUse('t2', 'Glob'));
          options.onPlan(fixturePlan());
          return { ok: true, aborted: false };
        },
      }),
    );
    expect(seen[0]).toHaveLength(0);
  });

  it('emits the plan for review before applying', async () => {
    const events: CoreEvent[] = [];
    await runOnboardCore(deps({ emit: (event) => events.push(event) }));
    expect(events.find((event) => event.stage === 'awaiting-approval')?.plan?.app_dir).toBe(
      'web',
    );
  });
});

describe('runOnboardCore env write', () => {
  it('writes both env vars into the plan app dir', async () => {
    const writes: Array<[string, Record<string, string>]> = [];
    await runOnboardCore(
      deps({
        writeEnv: async (dir, vars) => {
          writes.push([dir, vars]);
          return join(dir, '.env.local');
        },
      }),
    );
    expect(writes[0]).toEqual([
      join(root, 'web'),
      {
        VITE_OPSLANE_API_KEY: 'opk_test',
        VITE_OPSLANE_ENDPOINT: 'http://localhost:8082',
      },
    ]);
  });

  it('refuses an app_dir that escapes the repo', async () => {
    const writeEnv = vi.fn<CoreDeps['writeEnv']>(async () => '/unused/.env.local');
    const d = deps({ plan: { ...fixturePlan(), app_dir: '../outside' }, writeEnv });
    await expect(runOnboardCore(d)).resolves.toMatchObject({ ok: false, status: 'failed' });
    expect(writeEnv).not.toHaveBeenCalled();
  });
});

describe('runOnboardCore install', () => {
  it('skips the install when the report says it is not required', async () => {
    const runCommand = vi.fn<CoreDeps['runCommand']>();
    await runOnboardCore(deps({ installRequired: false, runCommand }));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('asks for consent and skips the install when declined, then still starts the dev server', async () => {
    const startDevServer = vi.fn<CoreDeps['startDevServer']>(() => fakeServer());
    let consentAsked = false;
    const d = deps({
      startDevServer,
      // Decline ONLY the install. Task 8 adds a dev-server prompt through the
      // same `confirm`; a blanket false would decline that too.
      confirm: async (prompt) => !prompt.toLowerCase().includes('install'),
      runCommand: async (options) => {
        consentAsked = true;
        return (await options.consent!())
          ? { ran: true, ok: true, exitCode: 0, signal: null }
          : { ran: false, copyPaste: 'pnpm install' };
      },
    });
    await expect(runOnboardCore(d)).resolves.toMatchObject({
      ok: true,
      status: 'completed',
    });
    expect(consentAsked).toBe(true);
    expect(startDevServer).toHaveBeenCalledTimes(1);
  });

  it('stops on a failed install rather than continuing', async () => {
    const startDevServer = vi.fn<CoreDeps['startDevServer']>();
    const d = deps({
      runCommand: async () => ({ ran: true, ok: false, exitCode: 1, signal: null }),
      startDevServer,
    });
    const result = await runOnboardCore(d);
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.message).toMatch(/install/i);
    expect(startDevServer).not.toHaveBeenCalled();
  });
});

describe('runOnboardCore dev server', () => {
  it('asks before starting the dev server and stops if declined', async () => {
    const startDevServer = vi.fn<CoreDeps['startDevServer']>();
    const d = deps({
      confirm: async (prompt) => !prompt.includes('dev server'),
      startDevServer,
    });
    const result = await runOnboardCore(d);
    expect(startDevServer).not.toHaveBeenCalled();
    expect(result.message).toMatch(/dev server/i);
  });

  it('emits the URL it parsed', async () => {
    const events: CoreEvent[] = [];
    await runOnboardCore(deps({ emit: (event) => events.push(event) }));
    expect(events.find((event) => event.url)?.url).toBe('http://localhost:5173/');
  });

  it('fails fast when the dev server dies instead of waiting out the poll', async () => {
    const waitForAppReporting = vi.fn<CoreDeps['waitForAppReporting']>(
      () => new Promise(() => undefined), // never settles
    );
    const d = deps({
      startDevServer: () => ({
        ...fakeServer(),
        completed: Promise.resolve({ exitCode: 1, signal: null }),
      }),
      waitForAppReporting,
    });
    const result = await runOnboardCore(d);
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.message).toMatch(/dev server (exited|stopped)/i);
  });

  it('stops the dev server when the wait fails', async () => {
    const server = fakeServer();
    const d = deps({
      startDevServer: () => server,
      waitForAppReporting: async () => {
        throw new Error('timed out waiting for your app to report');
      },
    });
    await expect(runOnboardCore(d)).resolves.toMatchObject({ ok: false, status: 'failed' });
    expect(server.stop).toHaveBeenCalled();
  });
});
