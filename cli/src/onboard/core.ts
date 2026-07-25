/**
 * The onboarding controller. Every effect is injected, so the whole decision
 * tree is unit-testable with no TTY, no model, and no network. Nothing here may
 * import `ink`, read `process.stdin`, or call a model directly.
 */
import type { writeEnvLocal } from '../envfile.js';
import type { runApply, runDetect } from './engine.js';
import type { TaskLine } from './events.js';
import type { ApprovalRequest } from './policy.js';
import type { ensureLoggedIn, ensureProvisioned } from './provision.js';
import type { runCommand, startDevServer } from './process.js';
import type { RunLog } from './runlog.js';
import type { AskUserResolver, OnboardingPlan } from './tools.js';
import type { waitForAppReporting } from './wait.js';

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
  question?: { question: string; options: string[]; multi: boolean };
  plan?: OnboardingPlan;
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

async function runFlow(deps: CoreDeps, _record: Record_): Promise<CoreResult> {
  const { emit } = deps;

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

  return { ok: true, status: 'completed' };
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
