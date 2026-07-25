import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  devCommand,
  formatCommand,
  installCommand,
  runCommand,
  startDevServer,
  startProcess,
} from '../process.js';

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'opslane-process-'));
  for (const [file, contents] of Object.entries(files)) {
    const absolute = join(root, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  return child;
}

const npmInstall = { executable: 'npm', args: ['install'] };

describe('command derivation', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
  ])('derives %s -> %s', (lockfile, manager) => {
    const root = repoWith({ [lockfile]: '', 'package.json': '{}' });
    expect(installCommand(root, '.')).toEqual({ executable: manager, args: ['install'] });
  });

  it('builds the dev command from the verified plan script', () => {
    const root = repoWith({ 'package-lock.json': '', 'package.json': '{}' });
    expect(devCommand(root, '.', 'dev:staging')).toEqual({
      executable: 'npm',
      args: ['run', 'dev:staging'],
    });
  });

  it('throws when no lockfile identifies a package manager', () => {
    expect(() => installCommand(repoWith({ 'package.json': '{}' }), '.')).toThrow(/lockfile/i);
  });
});

describe('formatCommand', () => {
  it('leaves ordinary argv unquoted', () => {
    expect(formatCommand({ executable: 'npm', args: ['run', 'dev'] })).toBe('npm run dev');
  });

  it('quotes spaces and shell metacharacters', () => {
    expect(formatCommand({ executable: 'npm', args: ['run', 'dev staging'] }))
      .toBe("npm run 'dev staging'");
    expect(formatCommand({ executable: 'npm', args: ['run', 'dev;echo bad'] }))
      .toBe("npm run 'dev;echo bad'");
  });

  it('escapes an embedded single quote', () => {
    expect(formatCommand({ executable: 'npm', args: ['run', "it's"] }))
      .toBe("npm run 'it'\\''s'");
  });
});

describe('startProcess', () => {
  it('resolves completion with the close result', async () => {
    const child = fakeChild();
    const handle = startProcess({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => child as never,
    });
    child.emit('close', 0, null);
    await expect(handle.completed).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it('finalizes on close rather than exit so output is drained', async () => {
    const child = fakeChild();
    const handle = startProcess({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => child as never,
    });
    child.emit('exit', 0, null);
    let settled = false;
    void handle.completed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', 0, null);
    await expect(handle.completed).resolves.toMatchObject({ exitCode: 0 });
  });

  it('reports signal termination instead of treating it as success', async () => {
    const child = fakeChild();
    const handle = startProcess({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => child as never,
    });
    child.emit('close', null, 'SIGTERM');
    await expect(handle.completed).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('rejects completion when spawn emits an error', async () => {
    const child = fakeChild();
    const handle = startProcess({
      command: { executable: 'nope', args: [] },
      cwd: '/repo',
      spawnFn: () => child as never,
    });
    child.emit('error', new Error('ENOENT'));
    await expect(handle.completed).rejects.toThrow(/ENOENT/);
  });

  it('spawns with argv, pipes, and shell disabled', () => {
    const spawnFn = vi.fn((
      _executable: string,
      _args: string[],
      _options: object,
    ) => fakeChild() as never);
    startProcess({ command: npmInstall, cwd: '/repo', spawnFn });
    const [executable, args, options] = spawnFn.mock.calls[0]!;
    expect(executable).toBe('npm');
    expect(args).toEqual(['install']);
    expect(options).toMatchObject({
      cwd: '/repo',
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('kills the whole process group on stop, idempotently', () => {
    const kills: Array<[number, string | undefined]> = [];
    const handle = startProcess({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => fakeChild() as never,
      killFn: (pid, signal) => {
        kills.push([pid, signal]);
      },
    });
    handle.stop();
    handle.stop();
    handle.stop();
    expect(kills).toEqual([[-4242, 'SIGTERM']]);
  });

  it('stops when the injected signal aborts', () => {
    const kills: number[] = [];
    const controller = new AbortController();
    startProcess({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => fakeChild() as never,
      killFn: (pid) => {
        kills.push(pid);
      },
      signal: controller.signal,
    });
    controller.abort();
    expect(kills).toEqual([-4242]);
  });

  it('never spawns when the signal is already aborted', async () => {
    const spawnFn = vi.fn(() => fakeChild() as never);
    const handle = startProcess({
      command: npmInstall,
      cwd: '/repo',
      spawnFn,
      signal: AbortSignal.abort(),
    });
    expect(spawnFn).not.toHaveBeenCalled();
    await expect(handle.completed).rejects.toThrow(/aborted/i);
  });

  it('balances its abort listeners', async () => {
    const controller = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
      added.push(listener);
      realAdd(type, listener, options);
    });
    vi.spyOn(controller.signal, 'removeEventListener')
      .mockImplementation((type, listener, options) => {
        removed.push(listener);
        realRemove(type, listener, options);
      });

    const child = fakeChild();
    const handle = startProcess({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => child as never,
      signal: controller.signal,
    });
    child.emit('close', 0, null);
    await handle.completed;
    expect(removed).toEqual(added);
  });
});

describe('process output', () => {
  it('flushes on the interval rather than once per chunk', () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const onOutput = vi.fn();
      startProcess({
        command: npmInstall,
        cwd: '/repo',
        spawnFn: () => child as never,
        onOutput,
        flushMs: 100,
      });
      for (let index = 0; index < 200; index += 1) {
        child.stdout.emit('data', Buffer.from(`line ${index}\n`));
      }
      expect(onOutput).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(onOutput).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 200; index += 1) {
        child.stdout.emit('data', Buffer.from(`more ${index}\n`));
      }
      vi.advanceTimersByTime(100);
      expect(onOutput).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers split lines without splicing stdout and stderr', () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      let last = '';
      startProcess({
        command: npmInstall,
        cwd: '/repo',
        spawnFn: () => child as never,
        onOutput: (text) => {
          last = text;
        },
        flushMs: 10,
      });
      child.stdout.emit('data', Buffer.from('out-par'));
      child.stderr.emit('data', Buffer.from('err-line\n'));
      child.stdout.emit('data', Buffer.from('tial\n'));
      vi.advanceTimersByTime(10);
      expect(last).toContain('err-line');
      expect(last).toContain('out-partial');
      expect(last).not.toContain('out-parerr-line');
    } finally {
      vi.useRealTimers();
    }
  });

  it('decodes a multi-byte character split across chunks', () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      let last = '';
      startProcess({
        command: npmInstall,
        cwd: '/repo',
        spawnFn: () => child as never,
        onOutput: (text) => {
          last = text;
        },
        flushMs: 10,
      });
      const arrow = Buffer.from('→ done\n', 'utf8');
      child.stdout.emit('data', arrow.subarray(0, 2));
      child.stdout.emit('data', arrow.subarray(2));
      vi.advanceTimersByTime(10);
      expect(last).toContain('→ done');
      expect(last).not.toContain('\uFFFD');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps only the last eight sanitized lines', () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      let last = '';
      startProcess({
        command: npmInstall,
        cwd: '/repo',
        spawnFn: () => child as never,
        onOutput: (text) => {
          last = text;
        },
        flushMs: 10,
      });
      for (let index = 0; index < 50; index += 1) {
        child.stdout.emit('data', Buffer.from(`\u001B[31mline ${index}\u001B[0m\n`));
      }
      vi.advanceTimersByTime(10);
      expect(last.split('\n')).toHaveLength(8);
      expect(last).toContain('line 49');
      expect(last).not.toContain('line 41');
      expect(last).not.toContain('\u001B');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes trailing partial lines on close', async () => {
    const child = fakeChild();
    let last = '';
    const handle = startProcess({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => child as never,
      onOutput: (text) => {
        last = text;
      },
      flushMs: 10_000,
    });
    child.stdout.emit('data', Buffer.from('no trailing newline'));
    child.emit('close', 0, null);
    await handle.completed;
    expect(last).toContain('no trailing newline');
    expect(last.split('\n').length).toBeLessThanOrEqual(8);
  });
});

describe('process wrappers', () => {
  it('reports non-zero and signal exits rather than throwing or succeeding', async () => {
    const failed = fakeChild();
    const failedResult = runCommand({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => failed as never,
    });
    failed.emit('close', 1, null);
    await expect(failedResult).resolves.toEqual({
      ran: true,
      ok: false,
      exitCode: 1,
      signal: null,
    });

    const killed = fakeChild();
    const killedResult = runCommand({
      command: npmInstall,
      cwd: '/repo',
      spawnFn: () => killed as never,
    });
    killed.emit('close', null, 'SIGTERM');
    await expect(killedResult).resolves.toMatchObject({ ok: false, signal: 'SIGTERM' });
  });

  it('does not spawn without consent and returns a quoted copy-paste command', async () => {
    const spawnFn = vi.fn();
    await expect(runCommand({
      command: { executable: 'npm', args: ['run', 'dev staging'] },
      cwd: '/repo',
      consent: async () => false,
      spawnFn: spawnFn as never,
    })).resolves.toEqual({ ran: false, copyPaste: "npm run 'dev staging'" });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('drains large child output when no renderer is attached', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      await expect(runCommand({
        command: {
          executable: process.execPath,
          args: ['-e', "process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 'x'))"],
        },
        cwd: process.cwd(),
        signal: controller.signal,
      })).resolves.toMatchObject({ ran: true, ok: true });
    } finally {
      clearTimeout(timeout);
    }
  }, 5_000);

  it.each([
    ['  \u001B[32m➜\u001B[0m  Local: http://localhost:5173/\n', 'http://localhost:5173/'],
    ['  - Local: http://localhost:3000\n', 'http://localhost:3000'],
  ])('parses a dev server URL from %j', async (banner, expected) => {
    const child = fakeChild();
    const handle = startDevServer({
      command: { executable: 'npm', args: ['run', 'dev'] },
      cwd: '/repo',
      spawnFn: () => child as never,
    });
    child.stdout.emit('data', Buffer.from(banner));
    await expect(handle.url).resolves.toBe(expected);
  });

  it('finds a URL split across chunks and reports the actual port', async () => {
    const child = fakeChild();
    const handle = startDevServer({
      command: { executable: 'npm', args: ['run', 'dev'] },
      cwd: '/repo',
      spawnFn: () => child as never,
    });
    child.stdout.emit('data', Buffer.from('Port 5173 is in use, trying another one...\n'));
    child.stdout.emit('data', Buffer.from('  Local: http://localh'));
    child.stdout.emit('data', Buffer.from('ost:5174/\n'));
    await expect(handle.url).resolves.toBe('http://localhost:5174/');
  });

  it('detects URLs even without an output renderer', async () => {
    const child = fakeChild();
    const handle = startDevServer({
      command: { executable: 'npm', args: ['run', 'dev'] },
      cwd: '/repo',
      spawnFn: () => child as never,
    });
    child.stderr.emit('data', Buffer.from('ready at http://127.0.0.1:8080\n'));
    await expect(handle.url).resolves.toBe('http://127.0.0.1:8080');
  });

  it('stops the child when no URL appears before the timeout', async () => {
    const kills: number[] = [];
    const child = fakeChild();
    const handle = startDevServer({
      command: { executable: 'npm', args: ['run', 'dev'] },
      cwd: '/repo',
      spawnFn: () => child as never,
      killFn: (pid) => {
        kills.push(pid);
      },
      urlTimeoutMs: 10,
    });
    await expect(handle.url).rejects.toThrow(/no .*URL/i);
    expect(kills).toEqual([-4242]);
  });

  it('rejects URL discovery when the child exits first', async () => {
    const child = fakeChild();
    const handle = startDevServer({
      command: { executable: 'npm', args: ['run', 'dev'] },
      cwd: '/repo',
      spawnFn: () => child as never,
    });
    child.emit('close', 1, null);
    await expect(handle.url).rejects.toThrow(/exited/i);
  });
});
