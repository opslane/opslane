import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../../contract.js';
import { installSignalHandlers, requireTty, runOnboardCommand } from '../command.js';
import type { CoreResult } from '../core.js';

describe('requireTty', () => {
  it.each([
    ['stdin not a tty', { stdin: false, stdout: true }],
    ['stdout not a tty', { stdin: true, stdout: false }],
    ['neither a tty', { stdin: false, stdout: false }],
  ])('gates on %s', (_label, tty) => {
    const exits: Array<[string, number]> = [];
    requireTty({
      isStdinTty: tty.stdin,
      isStdoutTty: tty.stdout,
      onFail: (status, code) => {
        exits.push([status, code]);
      },
    });
    expect(exits).toEqual([['tty_required', 1]]);
  });

  it('passes when both are a tty', () => {
    const exits: unknown[] = [];
    requireTty({
      isStdinTty: true,
      isStdoutTty: true,
      onFail: (...args) => {
        exits.push(args);
      },
    });
    expect(exits).toEqual([]);
  });
});

describe('installSignalHandlers', () => {
  it('aborts the run controller on SIGINT and sets exit code 130', () => {
    const exits: number[] = [];
    const controller = new AbortController();
    const removeHandlers = installSignalHandlers({
      controller,
      exitFn: (code) => {
        exits.push(code);
      },
    });

    process.emit('SIGINT');

    expect(controller.signal.aborted).toBe(true);
    expect(exits).toEqual([130]);
    removeHandlers();
  });

  it('maps SIGTERM to 143, not 130', () => {
    const exits: number[] = [];
    const removeHandlers = installSignalHandlers({
      controller: new AbortController(),
      exitFn: (code) => {
        exits.push(code);
      },
    });

    process.emit('SIGTERM');

    expect(exits).toEqual([143]);
    removeHandlers();
  });

  it('removes its handlers so repeated runs do not stack', () => {
    const before = process.listenerCount('SIGINT');
    installSignalHandlers({
      controller: new AbortController(),
      exitFn: () => undefined,
    })();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('runOnboardCommand shell wiring', () => {
  it('passes the resolved repo, api url, and signal into the shell', async () => {
    const seen: unknown[] = [];
    await runOnboardCommand(
      { repo: 'acme/web' },
      {
        isStdinTty: true,
        isStdoutTty: true,
        loadApp: async () => ({
          runOnboardApp: async (options: unknown) => {
            seen.push(options);
            return { ok: true, status: 'completed' as const };
          },
        }),
      },
    );
    expect(seen[0]).toMatchObject({ repo: 'acme/web', apiUrl: expect.any(String) });
    expect((seen[0] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('exits 0 and emits nothing extra on success', async () => {
    const exits: unknown[] = [];
    await runOnboardCommand(
      { repo: 'acme/web' },
      {
        isStdinTty: true,
        isStdoutTty: true,
        exitWith: (...args) => {
          exits.push(args);
        },
        loadApp: async () => ({
          runOnboardApp: async () => ({ ok: true, status: 'completed' as const }),
        }),
      },
    );
    expect(exits).toEqual([]);
  });

  it('maps unsupported to usage_error and failed to internal_error', async () => {
    const cases = [
      ['unsupported', 'usage_error'],
      ['failed', 'internal_error'],
    ] as const satisfies ReadonlyArray<readonly [CoreResult['status'], AgentStatus]>;
    for (const [status, expected] of cases) {
      const exits: Array<[string, number]> = [];
      await runOnboardCommand(
        { repo: 'acme/web' },
        {
          isStdinTty: true,
          isStdoutTty: true,
          exitWith: (agentStatus, _data, code) => {
            exits.push([agentStatus, code]);
          },
          loadApp: async () => ({
            runOnboardApp: async () => ({ ok: false, status, message: 'x' }),
          }),
        },
      );
      expect(exits).toEqual([[expected, 1]]);
    }
  });

  it('preserves the 130 exit code a real SIGINT set', async () => {
    const exits: unknown[] = [];
    const before = process.exitCode;
    await runOnboardCommand(
      { repo: 'acme/web' },
      {
        isStdinTty: true,
        isStdoutTty: true,
        exitWith: (...args) => {
          exits.push(args);
        },
        loadApp: async () => ({
          runOnboardApp: async () => {
            process.emit('SIGINT'); // the handler sets exitCode 130 and aborts
            return { ok: false, status: 'aborted' as const };
          },
        }),
      },
    );
    expect(process.exitCode).toBe(130);
    expect(exits).toEqual([]); // nothing overwrote it
    process.exitCode = before;
  });
});
