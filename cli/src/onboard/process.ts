import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { packageManagerForRepo } from './tools.js';

export interface Command {
  executable: string;
  args: string[];
}

type SpawnProcess = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    detached: true;
    shell: false;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => ChildProcess;

export interface ProcessOptions {
  command: Command;
  cwd: string;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  lineListeners?: Set<(line: string) => void>;
  flushMs?: number;
  spawnFn?: SpawnProcess;
  killFn?: (pid: number, signal?: NodeJS.Signals) => void;
}

export interface ProcessCompletion {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessHandle {
  pid: number | undefined;
  /** Settles on `close`, after stdout and stderr have drained. */
  completed: Promise<ProcessCompletion>;
  stop: () => void;
}

function manager(root: string, appDir: string): string {
  const detected = packageManagerForRepo(root, appDir);
  if (detected === null) {
    throw new Error(`No lockfile in ${appDir} identifies a package manager`);
  }
  return detected;
}

export function installCommand(root: string, appDir: string): Command {
  return { executable: manager(root, appDir), args: ['install'] };
}

/** `devScript` was already verified against the selected app manifest. */
export function devCommand(root: string, appDir: string, devScript: string): Command {
  return { executable: manager(root, appDir), args: ['run', devScript] };
}

const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** For display and copy-paste only. Execution always uses an argv array. */
export function formatCommand({ executable, args }: Command): string {
  return [executable, ...args]
    .map((value) => (
      SAFE_ARGUMENT.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
    ))
    .join(' ');
}

// Covers CSI, OSC, and single-character terminal escape sequences.
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-_]/g;
const TAIL_LINES = 8;

interface StreamReader {
  stream: NodeJS.ReadableStream | null;
  take: (chunk: Buffer | string) => void;
  finish: () => void;
}

function attachOutput(child: ChildProcess, options: ProcessOptions): () => void {
  if (options.onOutput === undefined && options.lineListeners === undefined) {
    // Piped streams must still be consumed. Otherwise a verbose installer can
    // fill the OS pipe buffer, block before exit, and leave `completed` waiting
    // forever even though nobody asked to render its output.
    const discard = (_chunk: Buffer | string): void => undefined;
    child.stdout?.on('data', discard);
    child.stderr?.on('data', discard);
    return () => {
      child.stdout?.off('data', discard);
      child.stderr?.off('data', discard);
    };
  }

  const emit = options.onOutput ?? (() => undefined);
  const tail: string[] = [];
  let cleaned = false;

  const keepTailBounded = (): void => {
    if (tail.length > TAIL_LINES) {
      tail.splice(0, tail.length - TAIL_LINES);
    }
  };
  const acceptLine = (raw: string): void => {
    const line = raw.replace(ANSI, '');
    tail.push(line);
    keepTailBounded();
    for (const listener of options.lineListeners ?? []) listener(line);
  };
  const makeReader = (stream: NodeJS.ReadableStream | null): StreamReader => {
    const decoder = new StringDecoder('utf8');
    let carry = '';
    const take = (chunk: Buffer | string): void => {
      const decoded = typeof chunk === 'string'
        ? decoder.write(Buffer.from(chunk))
        : decoder.write(chunk);
      const lines = `${carry}${decoded}`.split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) acceptLine(line);
    };
    const finish = (): void => {
      const trailing = `${carry}${decoder.end()}`;
      carry = '';
      if (trailing !== '') acceptLine(trailing);
    };
    return { stream, take, finish };
  };

  const readers = [
    makeReader(child.stdout),
    makeReader(child.stderr),
  ];
  for (const { stream, take } of readers) stream?.on('data', take);

  const flush = (): void => emit(tail.join('\n'));
  const timer = setInterval(flush, options.flushMs ?? 100);
  timer.unref();

  return () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    for (const { stream, take, finish } of readers) {
      stream?.off('data', take);
      finish();
    }
    keepTailBounded();
    flush();
  };
}

export function startProcess(options: ProcessOptions): ProcessHandle {
  const spawnFn = options.spawnFn ?? (nodeSpawn as SpawnProcess);
  const killFn = options.killFn ?? ((pid, signal) => {
    process.kill(pid, signal);
  });

  // Spawning and then killing can still run package lifecycle scripts.
  if (options.signal?.aborted === true) {
    return {
      pid: undefined,
      completed: Promise.reject(new Error('aborted before process start')),
      stop: () => undefined,
    };
  }

  const child = spawnFn(options.command.executable, options.command.args, {
    cwd: options.cwd,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cleanups: Array<() => void> = [attachOutput(child, options)];
  let stopped = false;
  const clean = (): void => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clean();
    try {
      if (child.pid !== undefined) killFn(-child.pid, 'SIGTERM');
    } catch {
      // The process may have already completed.
    }
  };

  const completed = new Promise<ProcessCompletion>((resolve, reject) => {
    child.once('error', (error) => {
      stop();
      reject(error);
    });
    // `exit` can fire before output streams drain; `close` cannot.
    child.once('close', (exitCode, signal) => {
      clean();
      stopped = true;
      resolve({ exitCode, signal });
    });
  });

  const signal = options.signal;
  if (signal?.aborted === true) {
    stop();
  } else if (signal !== undefined) {
    const onAbort = (): void => stop();
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }

  return { pid: child.pid, completed, stop };
}

export type RunResult =
  | { ran: true; ok: boolean; exitCode: number | null; signal: NodeJS.Signals | null }
  | { ran: false; copyPaste: string };

export async function runCommand(
  options: ProcessOptions & { consent?: () => Promise<boolean> },
): Promise<RunResult> {
  if (options.consent !== undefined && !(await options.consent())) {
    return { ran: false, copyPaste: formatCommand(options.command) };
  }
  const { exitCode, signal } = await startProcess(options).completed;
  return {
    ran: true,
    ok: exitCode === 0 && signal === null,
    exitCode,
    signal,
  };
}

const LOCALHOST_URL =
  /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/\S*)?)/i;

export interface DevServerHandle extends ProcessHandle {
  url: Promise<string>;
  restartCommand: string;
}

export function startDevServer(
  options: ProcessOptions & { urlTimeoutMs?: number },
): DevServerHandle {
  const lineListeners = options.lineListeners ?? new Set<(line: string) => void>();
  const handle = startProcess({ ...options, lineListeners });

  const url = new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lineListeners.delete(scan);
      finish();
    };
    const scan = (line: string): void => {
      const match = LOCALHOST_URL.exec(line);
      if (match !== null) settle(() => resolve(match[1]!));
    };

    lineListeners.add(scan);
    timer = setTimeout(() => {
      settle(() => {
        handle.stop();
        reject(new Error('the dev server printed no localhost URL'));
      });
    }, options.urlTimeoutMs ?? 30_000);
    timer.unref();

    void handle.completed
      .then(({ exitCode, signal }) => {
        const reason = signal === null ? String(exitCode) : signal;
        settle(() => reject(new Error(`the dev server exited (${reason})`)));
      })
      .catch((error: unknown) => settle(() => reject(error)));
  });
  void url.catch(() => undefined);

  return {
    ...handle,
    url,
    restartCommand: formatCommand(options.command),
  };
}
