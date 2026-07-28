/**
 * The onboarding controller. Every effect is injected, so the whole decision
 * tree is unit-testable with no TTY, no model, and no network. Nothing here may
 * import `ink`, read `process.stdin`, or call a model directly.
 */
import { join } from 'node:path';

import type { writeEnvLocal } from '../envfile.js';
import type { ApplyReport, runApply, runDetect } from './engine.js';
import { reduceTasks, type TaskLine } from './events.js';
import { containedRepoRelative } from './paths.js';
import type { ApprovalRequest } from './policy.js';
import type { ensureLoggedIn, ensureProvisioned } from './provision.js';
import {
  devCommand,
  formatCommand,
  installCommand,
  type runCommand,
  type startDevServer,
} from './process.js';
import { buildActionPreview, type ActionPreview } from './preview.js';
import type { RunLog } from './runlog.js';
import type { AskUserResolver, OnboardingPlan } from './tools.js';
import type { waitForAppReporting } from './wait.js';
import { uncommittedFiles } from './worktree.js';

export type Stage =
  | 'login'
  | 'provision'
  | 'detect'
  | 'awaiting-approval'
  | 'apply'
  | 'writing-env'
  | 'installing'
  | 'starting-dev'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'unsupported'
  | 'aborted';

export interface CoreEvent {
  stage: Stage;
  tasks?: TaskLine[];
  /** Settled lines the controller stopped retaining, so the view can total them. */
  droppedDone?: number;
  droppedFailed?: number;
  question?: { question: string; options: string[]; multi: boolean };
  plan?: OnboardingPlan;
  preview?: ActionPreview;
  dirty?: string[] | null;
  url?: string;
  output?: string;
  message?: string;
}

export interface CoreDeps {
  cwd: string;
  repo: string;
  apiUrl: string;
  tokenPath: string;
  signal: AbortSignal;
  loginFn: () => Promise<void>;
  ensureLoggedIn: typeof ensureLoggedIn;
  ensureProvisioned: typeof ensureProvisioned;
  runDetect: typeof runDetect;
  runApply: typeof runApply;
  requestApproval: ApprovalRequest;
  approvePlan: (preview: ActionPreview) => Promise<boolean>;
  askUser: AskUserResolver;
  confirm: (prompt: string, command: string) => Promise<boolean>;
  writeEnv: typeof writeEnvLocal;
  runCommand: typeof runCommand;
  startDevServer: typeof startDevServer;
  waitForAppReporting: typeof waitForAppReporting;
  runLog: RunLog;
  emit: (event: CoreEvent) => void;
}

export interface CoreResult {
  ok: boolean;
  status: 'completed' | 'unsupported' | 'failed' | 'aborted';
  message?: string;
  url?: string;
}

const TERMINAL = {
  completed: 'done',
  failed: 'failed',
  unsupported: 'unsupported',
  aborted: 'aborted',
} as const satisfies Record<CoreResult['status'], Stage>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Record_ = (message: unknown) => void;

/** The agent's own report and the engine's tracked edits must name the same files. */
function sameFiles(left: string[] = [], right: string[] = []): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

const MAX_TASKS = 8;

export interface BoundedTasks {
  tasks: TaskLine[];
  droppedDone: number;
  droppedFailed: number;
}

const NO_TASKS: BoundedTasks = { tasks: [], droppedDone: 0, droppedFailed: 0 };

/**
 * Keep every still-running line (a `tool_result` must still find its `tool_use`),
 * plus the most recent settled ones. Failures are NEVER dropped silently — they
 * are counted separately so the view cannot report a failure as "done".
 *
 * `running` is never truncated: dropping a running line would orphan its
 * `tool_result` and the entry would never settle. When more than MAX_TASKS tools
 * are in flight the list exceeds the cap, which is correct and transient.
 */
function boundTasks(tasks: TaskLine[], prev: BoundedTasks): BoundedTasks {
  const running = tasks.filter((task) => task.state === 'run');
  const settled = tasks.filter((task) => task.state !== 'run');
  const room = Math.max(0, MAX_TASKS - running.length);
  // slice(-0) is slice(0) and returns EVERYTHING — guard room === 0 explicitly.
  const keep = room === 0 ? [] : settled.slice(-room);
  const dropped = settled.slice(0, settled.length - keep.length);
  return {
    tasks: [...keep, ...running],
    droppedDone: prev.droppedDone + dropped.filter((task) => task.state === 'done').length,
    droppedFailed: prev.droppedFailed + dropped.filter((task) => task.state === 'fail').length,
  };
}

async function runFlow(deps: CoreDeps, record: Record_): Promise<CoreResult> {
  const { emit, signal } = deps;

  emit({ stage: 'login' });
  const tokens = await deps.ensureLoggedIn({
    apiUrl: deps.apiUrl,
    tokenPath: deps.tokenPath,
    loginFn: deps.loginFn,
  });

  emit({ stage: 'provision' });
  const provision = await deps.ensureProvisioned({
    apiUrl: deps.apiUrl,
    repo: deps.repo,
    token: tokens.accessToken,
  });
  // Both are required before any message is recorded in full mode: the key and
  // poll token must be redactable, and the log needs the server join key.
  deps.runLog.addSecret(provision.apiKey);
  deps.runLog.addSecret(provision.pollToken);
  await deps.runLog.setSessionId(provision.sessionId);

  let bounded = NO_TASKS;
  const emitTasks = (stage: Stage): void =>
    emit({
      stage,
      tasks: bounded.tasks,
      droppedDone: bounded.droppedDone,
      droppedFailed: bounded.droppedFailed,
    });

  emitTasks('detect');
  let plan: OnboardingPlan | undefined;
  const detect = await deps.runDetect({
    cwd: deps.cwd,
    signal,
    askUser: deps.askUser,
    onPlan: (value) => {
      plan = value;
    },
    onMessage: (message) => {
      record(message);
      bounded = boundTasks(reduceTasks(bounded.tasks, message), bounded);
      emitTasks('detect');
    },
  });

  if (detect.aborted) return { ok: false, status: 'aborted' };
  if (detect.reason === 'unsupported') {
    return {
      ok: false,
      status: 'unsupported',
      message: detect.unsupportedReason ?? 'this repository is not supported',
    };
  }
  if (!detect.ok || plan === undefined) {
    return {
      ok: false,
      status: 'failed',
      message: detect.reason ?? 'the survey did not produce a plan',
    };
  }

  if (plan.existing_sdk.action === 'migrate') {
    return {
      ok: false,
      status: 'failed',
      message:
        `Migration from ${plan.existing_sdk.name ?? 'the existing monitoring SDK'} `
        + 'is not supported yet.',
    };
  }

  const envValues = {
    [plan.env_vars.api_key]: provision.apiKey,
    [plan.env_vars.endpoint]: provision.endpoint,
  };
  const preview = buildActionPreview({ cwd: deps.cwd, plan, envValues });
  const dirty = uncommittedFiles(deps.cwd);
  emit({ stage: 'awaiting-approval', plan, preview, dirty });
  if (!(await deps.approvePlan(preview))) {
    return {
      ok: false,
      status: 'aborted',
      message: 'You did not approve the changes.',
    };
  }

  bounded = NO_TASKS; // detect's list must not carry over
  emitTasks('apply');
  let report: ApplyReport | undefined;
  const applied = await deps.runApply({
    cwd: deps.cwd,
    plan,
    signal,
    // The user approved the finite write set shown in `preview`. The Apply hook
    // hard-denies every other path before this callback can be consulted.
    requestApproval: async () => true,
    onReport: (value) => {
      report = value;
    },
    onMessage: (message) => {
      record(message);
      bounded = boundTasks(reduceTasks(bounded.tasks, message), bounded);
      emitTasks('apply');
    },
  });

  if (applied.aborted) return { ok: false, status: 'aborted' };
  if (!applied.ok || report === undefined) {
    return {
      ok: false,
      status: 'failed',
      message:
        applied.failures?.join('; ') ?? applied.reason ?? 'the wiring could not be verified',
    };
  }
  if (!sameFiles(report.editedFiles, applied.editedFiles)) {
    return {
      ok: false,
      status: 'failed',
      message: 'the agent report does not match the files the engine tracked',
    };
  }

  emit({ stage: 'writing-env' });
  const appDir = containedRepoRelative(deps.cwd, plan.app_dir); // throws if it escapes
  // NOT app_dir. Vite's `envDir` moves where .env files are read from, and both
  // monorepos in the eval corpus point it at the repository root. Writing into
  // the app directory there produces an app that installs, starts, and never
  // reports, because the bundler never reads the file.
  const envDir = join(deps.cwd, containedRepoRelative(deps.cwd, plan.env_dir));
  await deps.writeEnv(envDir, envValues);

  if (report.installRequired) {
    emit({ stage: 'installing' });
    const installRelative = containedRepoRelative(deps.cwd, report.installCwd);
    const installDir = join(deps.cwd, installRelative);
    const install = installCommand(deps.cwd, installRelative, plan.package_manager);
    const installed = await deps.runCommand({
      command: install,
      cwd: installDir,
      signal,
      // Dependency installation was named in and covered by approvePlan.
      consent: async () => true,
      onOutput: (output) => emit({ stage: 'installing', output }),
    });
    if (installed.ran && !installed.ok) {
      return {
        ok: false,
        status: 'failed',
        message:
          `${formatCommand(install)} failed (exit ${installed.exitCode ?? installed.signal}). `
          + 'Fix the install and re-run onboarding. Do not change the @opslane/sdk version.',
      };
    }
  }

  const dev = devCommand(deps.cwd, appDir, plan.dev_script, plan.package_manager);
  emit({ stage: 'starting-dev' });
  const server = deps.startDevServer({
    command: dev,
    // Starting the server was named in and covered by approvePlan. `env_dir`
    // only controls where the bundler reads env files; commands run in app_dir.
    cwd: join(deps.cwd, appDir),
    signal,
    onOutput: (output) => emit({ stage: 'starting-dev', output }),
  });
  // The poll must be cancellable independently: when the server dies, the
  // losing side of the race would otherwise keep polling for 15 minutes.
  const pollController = new AbortController();
  const onOuterAbort = (): void => pollController.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });
  // Never let the losing branch surface as an unhandled rejection.
  const serverDied = server.completed.then(
    ({ exitCode }) => {
      throw new Error(`the dev server stopped (${exitCode ?? 'signal'}) unexpectedly`);
    },
    (error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
  );
  void serverDied.catch(() => undefined);
  try {
    const url = await Promise.race([server.url, serverDied]);
    emit({ stage: 'waiting', url });
    await Promise.race([
      deps.waitForAppReporting({
        apiUrl: deps.apiUrl,
        sessionId: provision.sessionId,
        pollToken: provision.pollToken,
        signal: pollController.signal,
      }),
      serverDied,
    ]);
    return { ok: true, status: 'completed', url };
  } finally {
    pollController.abort(); // stop the poll either way
    signal.removeEventListener('abort', onOuterAbort);
    server.stop();
    await server.completed.catch(() => undefined); // teardown before the terminal event
  }
}

export async function runOnboardCore(deps: CoreDeps): Promise<CoreResult> {
  const { emit, signal } = deps;

  // Records are fire-and-forget from the caller's view but must not outlive
  // `finish`, and a rejection must never become an unhandled rejection.
  let logChain: Promise<void> = Promise.resolve();
  const record: Record_ = (message) => {
    logChain = logChain.then(() => deps.runLog.record(message)).catch(() => undefined);
  };

  let outcome: CoreResult;
  try {
    outcome = await runFlow(deps, record);
  } catch (error) {
    outcome = signal.aborted
      ? { ok: false, status: 'aborted' }
      : { ok: false, status: 'failed', message: messageOf(error) };
  } finally {
    await logChain; // drain before finishing
  }

  // Exactly one terminal event, mapped straight from the status.
  emit({ stage: TERMINAL[outcome.status], message: outcome.message, url: outcome.url });
  await deps.runLog.finish({ outcome: outcome.status }).catch(() => undefined);
  return outcome;
}
