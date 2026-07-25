import { defaultApiUrl } from '../config.js';
import type { AgentStatus } from '../contract.js';
import { exitWithStatus } from '../output.js';
import type { CoreResult } from './core.js';
import { resolveRepo } from './repo.js';

export interface OnboardOptions {
  apiUrl?: string;
  repo?: string;
}

interface TtyGateOptions {
  isStdinTty: boolean;
  isStdoutTty: boolean;
  onFail: (status: AgentStatus, code: number) => void;
}

/**
 * Keep the TTY gate outside any .tsx module. That prevents the interactive
 * renderer and React runtime from loading on the machine-readable piped path.
 */
export function requireTty({
  isStdinTty,
  isStdoutTty,
  onFail,
}: TtyGateOptions): void {
  if (!isStdinTty || !isStdoutTty) onFail('tty_required', 1);
}

/**
 * Signal handling lives in the command layer. The process seam accepts an
 * AbortSignal so it remains testable and does not install process-global
 * listeners itself.
 */
export function installSignalHandlers({
  controller,
  exitFn = (code) => {
    process.exitCode = code;
  },
}: {
  controller: AbortController;
  exitFn?: (code: number) => void;
}): () => void {
  const codes = { SIGINT: 130, SIGTERM: 143 } as const;
  const handlers = Object.entries(codes).map(([signal, code]) => {
    const handler = (): void => {
      exitFn(code);
      controller.abort();
    };
    process.on(signal as NodeJS.Signals, handler);
    return () => process.removeListener(signal as NodeJS.Signals, handler);
  });

  return () => {
    for (const removeHandler of handlers) removeHandler();
  };
}

export interface OnboardCommandDeps {
  isStdinTty?: boolean;
  isStdoutTty?: boolean;
  exitWith?: (status: AgentStatus, data: Record<string, unknown>, code: number) => void;
  loadApp?: () => Promise<{
    runOnboardApp: (options: {
      cwd: string;
      repo: string;
      apiUrl: string;
      signal: AbortSignal;
    }) => Promise<CoreResult>;
  }>;
}

export async function runOnboardCommand(
  options: OnboardOptions,
  deps: OnboardCommandDeps = {},
): Promise<void> {
  // The gate and the exit both route through the injected deps, or the
  // injection would be inert and the tests would drive the real process.
  const exitWith = deps.exitWith ?? exitWithStatus;
  requireTty({
    isStdinTty: deps.isStdinTty ?? process.stdin.isTTY === true,
    isStdoutTty: deps.isStdoutTty ?? process.stdout.isTTY === true,
    onFail: (status, code) => {
      exitWith(status, {
        message:
          'opslane onboard needs an interactive terminal; run it without piping stdin or stdout.',
      }, code);
    },
  });

  const repo = resolveRepo({ repo: options.repo });
  if (!repo.ok) {
    exitWith('usage_error', { message: repo.message }, 1);
    return;
  }

  // Loaded lazily so the interactive renderer never reaches the piped path.
  const loadApp = deps.loadApp ?? (() => import('./app.js'));
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const controller = new AbortController();
  const removeHandlers = installSignalHandlers({ controller });
  try {
    const { runOnboardApp } = await loadApp();
    const result = await runOnboardApp({
      cwd: process.cwd(),
      repo: repo.repo,
      apiUrl,
      signal: controller.signal,
    });
    if (result.ok) return;
    // SIGINT already set exitCode 130; do not overwrite it.
    if (result.status === 'aborted') return;
    exitWith(
      result.status === 'unsupported' ? 'usage_error' : 'internal_error',
      { message: result.message },
      1,
    );
  } finally {
    removeHandlers();
  }
}
