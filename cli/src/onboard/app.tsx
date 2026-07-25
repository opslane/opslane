/**
 * The Ink shell: the only file that wires real terminal I/O into the pure
 * controller. It owns the three interactive callbacks and the production
 * dependency factory.
 *
 * The prompt state lives OUTSIDE React on purpose. Login prints the
 * authorization URL to stdout (`login.ts`), and Ink owns the screen, so the
 * shell unmounts Ink for the duration of login and renders again afterwards.
 * A remount must not restart the run, so the run and its queue outlive the view.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { render, type Instance } from 'ink';
import React, { useEffect, useReducer } from 'react';

import { defaultTokenPath } from '../auth.js';
import { writeEnvLocal } from '../envfile.js';
import { login } from '../login.js';
import {
  runOnboardCore,
  type CoreDeps,
  type CoreEvent,
  type CoreResult,
} from './core.js';
import { runApply, runDetect } from './engine.js';
import type { ApprovalRequest } from './policy.js';
import { runCommand, startDevServer } from './process.js';
import { ensureLoggedIn, ensureProvisioned } from './provision.js';
import { createRunLog } from './runlog.js';
import type { AskUserResolver } from './tools.js';
import { Tui } from './tui.js';
import { waitForAppReporting } from './wait.js';

const YES = 'Yes';
const NO = 'No';

export interface ShellUi {
  requestApproval: ApprovalRequest;
  askUser: AskUserResolver;
  confirm: (prompt: string, command: string) => Promise<boolean>;
  emit: (event: CoreEvent) => void;
  loginFn: () => Promise<void>;
}

/**
 * The three prompt kinds resolve different types. Settling everything with
 * `false` would hand a question's caller a boolean, so each entry carries its
 * own settle type: `false` for approvals and confirmations, `[]` for questions.
 */
type Pending =
  | { id: number; kind: 'boolean'; title: string; resolve: (value: boolean) => void }
  | {
      id: number;
      kind: 'question';
      title: string;
      question: { question: string; options: string[]; multi: boolean };
      resolve: (value: string[]) => void;
    };

export interface OnboardShell {
  ui: ShellUi;
  getEvent: () => CoreEvent;
  getPrompt: () => Pending | undefined;
  answer: (value: string[]) => void;
  subscribe: (listener: () => void) => () => void;
  /** Resolve every parked prompt. Called on abort and on teardown. */
  settleAll: () => void;
}

function approvalTitle(
  toolName: string,
  input: Record<string, unknown>,
  options?: { [key: string]: unknown },
): string {
  const supplied = options?.['title'];
  if (typeof supplied === 'string' && supplied !== '') return supplied;
  const filePath = input['file_path'];
  return typeof filePath === 'string'
    ? `Allow ${toolName} ${filePath}?`
    : `Allow ${toolName}?`;
}

export function createOnboardShell({
  signal,
  loginFn = async () => undefined,
}: {
  signal: AbortSignal;
  loginFn?: () => Promise<void>;
}): OnboardShell {
  let event: CoreEvent = { stage: 'login' };
  const queue: Pending[] = [];
  const listeners = new Set<() => void>();
  let nextId = 0;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const settle = (entry: Pending): void => {
    if (entry.kind === 'question') entry.resolve([]);
    else entry.resolve(false);
  };

  const settleAll = (): void => {
    if (queue.length === 0) return;
    for (const entry of queue.splice(0)) settle(entry);
    notify();
  };
  signal.addEventListener('abort', settleAll, { once: true });

  const enqueue = (entry: Pending): void => {
    queue.push(entry);
    notify();
    if (signal.aborted) settleAll();
  };

  /** Remove one entry without disturbing the rest of the queue. */
  const drop = (entry: Pending): void => {
    const index = queue.indexOf(entry);
    if (index === -1) return;
    queue.splice(index, 1);
    settle(entry);
    notify();
  };

  const ui: ShellUi = {
    requestApproval: (toolName, input, options) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted || options?.signal?.aborted === true) {
          resolve(false);
          return;
        }
        const entry: Pending = {
          id: (nextId += 1),
          kind: 'boolean',
          title: approvalTitle(toolName, input, options),
          resolve,
        };
        enqueue(entry);
        // The SDK cancels individual approvals; that must not settle the rest.
        options?.signal?.addEventListener('abort', () => drop(entry), { once: true });
      }),
    confirm: (prompt, command) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }
        enqueue({
          id: (nextId += 1),
          kind: 'boolean',
          title: `${prompt}  ${command}`,
          resolve,
        });
      }),
    askUser: (request) =>
      new Promise<string[]>((resolve) => {
        if (signal.aborted) {
          resolve([]);
          return;
        }
        enqueue({
          id: (nextId += 1),
          kind: 'question',
          title: request.question,
          question: { ...request },
          resolve,
        });
      }),
    emit: (next) => {
      event = next;
      notify();
    },
    loginFn,
  };

  return {
    ui,
    getEvent: () => event,
    getPrompt: () => queue[0],
    answer: (value) => {
      const head = queue.shift();
      notify();
      if (head === undefined) return;
      if (head.kind === 'question') head.resolve(value);
      else head.resolve(value[0] === YES);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settleAll,
  };
}

export function OnboardApp({ shell }: { shell: OnboardShell }): React.JSX.Element {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const unsubscribe = shell.subscribe(bump);
    bump(); // catch anything emitted between render and subscribe
    return unsubscribe;
  }, [shell]);

  const event = shell.getEvent();
  const prompt = shell.getPrompt();
  const question =
    prompt === undefined
      ? undefined
      : prompt.kind === 'question'
        ? prompt.question
        : { question: prompt.title, options: [YES, NO], multi: false };

  return (
    <Tui
      // A fresh prompt gets a fresh Select, so no keystroke lands on the last one.
      key={prompt?.id ?? 'idle'}
      {...event}
      tasks={event.tasks ?? []}
      question={question}
      onAnswer={(value) => shell.answer(value)}
    />
  );
}

export interface RunOnboardAppOptions {
  cwd: string;
  repo: string;
  apiUrl: string;
  signal: AbortSignal;
  /** Overridable so tests never write to the real `~/.opslane/logs`. */
  logDir?: string;
  runCore?: (deps: CoreDeps) => Promise<CoreResult>;
}

async function productionDeps(
  options: RunOnboardAppOptions,
  ui: ShellUi,
): Promise<CoreDeps> {
  const full = process.env['OPSLANE_ONBOARD_LOG'] === 'full';
  if (full) {
    // Full mode records agent messages, which can contain repository source.
    // Say so before writing any of it.
    console.error(
      'OPSLANE_ONBOARD_LOG=full: this run records full agent messages, '
        + 'including file contents, to ~/.opslane/logs. Secrets are redacted; source is not.',
    );
  }
  return {
    cwd: options.cwd,
    repo: options.repo,
    apiUrl: options.apiUrl,
    signal: options.signal,
    tokenPath: defaultTokenPath(),
    loginFn: ui.loginFn,
    ensureLoggedIn,
    ensureProvisioned,
    runDetect,
    runApply,
    writeEnv: writeEnvLocal,
    runCommand,
    startDevServer,
    waitForAppReporting,
    requestApproval: ui.requestApproval,
    askUser: ui.askUser,
    confirm: ui.confirm,
    runLog: await createRunLog({
      dir: options.logDir ?? join(homedir(), '.opslane', 'logs'),
      runId: randomUUID(),
      mode: full ? 'full' : 'metadata',
    }),
    emit: ui.emit,
  };
}

export async function runOnboardApp(options: RunOnboardAppOptions): Promise<CoreResult> {
  const runCore = options.runCore ?? runOnboardCore;
  let instance: Instance | undefined;

  const shell: OnboardShell = createOnboardShell({
    signal: options.signal,
    // Login prints the authorization URL, so give stdout back for its duration.
    // The run and its prompt queue live outside React, so remounting the view
    // resumes the same run rather than starting a second one.
    loginFn: async () => {
      instance?.clear();
      instance?.unmount();
      instance = undefined;
      await login({
        apiUrl: options.apiUrl,
        clientId: process.env['OPSLANE_CLIENT_ID'] ?? 'opslane-cli',
      });
      instance = render(<OnboardApp shell={shell} />);
    },
  });

  const deps = await productionDeps(options, shell.ui);
  instance = render(<OnboardApp shell={shell} />);
  try {
    return await runCore(deps);
  } finally {
    shell.settleAll();
    instance?.unmount();
  }
}
