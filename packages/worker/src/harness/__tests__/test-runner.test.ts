import { describe, expect, it } from 'vitest';
import {
  SUITE_RESULTS_PATH,
  compareSuiteRuns,
  parseSuiteJson,
  planTests,
  runDeclaredTest,
  runSuite,
  selectTestCommand,
  type SuiteRun,
} from '../test-runner.js';
import { SandboxUnavailableError, type SandboxRuntime } from '../sandbox-runtime.js';

describe('selectTestCommand', () => {
  it('prefers repo-local vitest with an explicit JSON reporter and never uses npx', () => {
    const plan = selectTestCommand({}, true, 'pnpm');
    expect(plan.kind).toBe('vitest');
    expect(plan.command).toBe(
      `./node_modules/.bin/vitest run --reporter=json --outputFile=${SUITE_RESULTS_PATH}`,
    );
    expect(plan.command).not.toContain('npx');
  });

  it('falls back to the root package test script with the detected package manager', () => {
    expect(selectTestCommand({ scripts: { test: 'jest' } }, false, 'yarn')).toEqual({
      kind: 'npm-script',
      command: 'yarn test',
    });
    expect(selectTestCommand({ scripts: { test: 'jest' } }, false, 'npm')).toEqual({
      kind: 'npm-script',
      command: 'npm test',
    });
  });

  it('reports none when there is nothing to run', () => {
    expect(selectTestCommand({}, false)).toEqual({ kind: 'none', command: null });
  });

  it('does not claim root-package support for a workspace repository', () => {
    expect(selectTestCommand({ workspaces: ['packages/*'] }, true, 'pnpm')).toEqual({
      kind: 'none',
      command: null,
    });
  });
});

describe('parseSuiteJson', () => {
  it('extracts executed tests keyed by repo-relative file and full name', () => {
    const parsed = parseSuiteJson(JSON.stringify({
      numTotalTests: 3,
      testResults: [{
        name: '/home/user/repo/src/__tests__/a.test.ts',
        assertionResults: [
          { fullName: 'a > passes', status: 'passed' },
          { fullName: 'a > fails', status: 'failed' },
          { fullName: 'a > skipped', status: 'skipped' },
        ],
      }],
    }));
    expect(parsed.total).toBe(3);
    expect(parsed.tests.get('src/__tests__/a.test.ts::a > passes')).toBe('passed');
    expect(parsed.tests.get('src/__tests__/a.test.ts::a > fails')).toBe('failed');
    expect(parsed.tests.has('src/__tests__/a.test.ts::a > skipped')).toBe(false);
  });
});

const run = (
  outcome: SuiteRun['outcome'],
  tests: Array<[string, 'passed' | 'failed']> | null,
): SuiteRun => ({
  outcome,
  command: 'vitest run',
  tests: tests ? new Map(tests) : null,
  total: tests?.length ?? null,
  output: '',
});

describe('compareSuiteRuns', () => {
  it('only counts pass-to-fail as a regression and records pre-existing failures', () => {
    const comparison = compareSuiteRuns(
      run('failed', [['t1', 'passed'], ['t2', 'failed']]),
      run('failed', [['t1', 'failed'], ['t2', 'failed']]),
    );
    expect(comparison).toEqual({
      baselineFailed: ['t2'],
      newFailures: ['t1'],
      missingFromPost: [],
      comparable: true,
    });
  });

  it('counts a new post-patch failed test as a regression', () => {
    const comparison = compareSuiteRuns(
      run('passed', [['t1', 'passed']]),
      run('failed', [['t1', 'passed'], ['t2', 'failed']]),
    );
    expect(comparison.newFailures).toEqual(['t2']);
  });

  it('treats a disappearing baseline-passing test as a collection drop', () => {
    const comparison = compareSuiteRuns(
      run('passed', [['t1', 'passed'], ['t2', 'passed']]),
      run('passed', [['t1', 'passed']]),
    );
    expect(comparison.missingFromPost).toEqual(['t2']);
  });

  it('treats a disappearing baseline failure as a collection drop', () => {
    const comparison = compareSuiteRuns(
      run('failed', [['t1', 'passed'], ['t2', 'failed']]),
      run('passed', [['t1', 'passed']]),
    );
    expect(comparison.missingFromPost).toEqual(['t2']);
  });

  it('only supports a coarse comparison when the post run passed cleanly', () => {
    expect(compareSuiteRuns(run('passed', null), run('failed', null)).newFailures).toEqual(['<suite>']);
    expect(compareSuiteRuns(null, run('failed', null)).newFailures).toEqual(['<suite>']);
    expect(compareSuiteRuns(run('failed', null), run('failed', null))).toMatchObject({
      newFailures: [],
      comparable: false,
    });
    expect(compareSuiteRuns(run('failed', null), run('passed', null)).comparable).toBe(true);
  });
});

function fakeSandbox(opts: {
  files?: Record<string, string>;
  onRun?: (command: string) => { exitCode?: number; stdout?: string; stderr?: string; throwMsg?: string };
}): SandboxRuntime {
  return {
    id: 'fake-sandbox',
    createdAt: 0,
    lifetimeMs: 1_800_000,
    unavailable: false,
    commands: {
      run: async (command: string) => {
        const behavior = opts.onRun?.(command);
        if (behavior?.throwMsg) {
          throw Object.assign(new Error(behavior.throwMsg), {
            stderr: behavior.stderr,
            stdout: behavior.stdout,
          });
        }
        return {
          exitCode: behavior?.exitCode ?? 0,
          stdout: behavior?.stdout ?? '',
          stderr: behavior?.stderr ?? '',
        };
      },
    },
    files: {
      read: async (path: string) => {
        const content = opts.files?.[path];
        if (content === undefined) throw new Error('not found');
        return content;
      },
      write: async () => undefined,
    },
    kill: async () => undefined,
  };
}

const vitestReport = (statuses: Array<'passed' | 'failed'>): string => JSON.stringify({
  numTotalTests: statuses.length,
  testResults: [{
    name: '/home/user/repo/src/a.test.ts',
    assertionResults: statuses.map((status, index) => ({ fullName: `t${index}`, status })),
  }],
});

describe('planTests', () => {
  it('picks Vitest when the root repo-local binary exists', async () => {
    const sandbox = fakeSandbox({ files: {
      '/home/user/repo/package.json': '{"scripts":{"test":"vitest"}}',
      '/home/user/repo/node_modules/.bin/vitest': '#!/bin/sh',
      '/home/user/repo/pnpm-lock.yaml': '',
    } });
    expect((await planTests(sandbox)).kind).toBe('vitest');
  });

  it('reports none for a root package with no runner', async () => {
    const sandbox = fakeSandbox({ files: { '/home/user/repo/package.json': '{}' } });
    expect((await planTests(sandbox)).kind).toBe('none');
  });

  it('reports none for pnpm workspaces instead of running a hoisted root binary', async () => {
    const sandbox = fakeSandbox({ files: {
      '/home/user/repo/package.json': '{"scripts":{"test":"vitest"}}',
      '/home/user/repo/node_modules/.bin/vitest': '#!/bin/sh',
      '/home/user/repo/pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      '/home/user/repo/pnpm-lock.yaml': '',
    } });
    expect(await planTests(sandbox)).toEqual({ kind: 'none', command: null });
  });
});

describe('runSuite taxonomy', () => {
  const plan = {
    kind: 'vitest' as const,
    command: `./node_modules/.bin/vitest run --reporter=json --outputFile=${SUITE_RESULTS_PATH}`,
  };

  it('passes a clean run with parseable executed results', async () => {
    const result = await runSuite(fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: vitestReport(['passed', 'passed']) },
    }), plan);
    expect(result).toMatchObject({ outcome: 'passed', total: 2, exitCode: 0 });
  });

  it('classifies a nonzero run with failed assertions as failed', async () => {
    const result = await runSuite(fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: vitestReport(['passed', 'failed']) },
      onRun: (command) => command.includes('vitest')
        ? { throwMsg: 'Command exited with code 1' }
        : {},
    }), plan);
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 1 });
  });

  it('classifies timeouts and runner crashes without results as infra_error', async () => {
    const timeout = await runSuite(fakeSandbox({
      onRun: (command) => command.includes('vitest')
        ? { throwMsg: 'Command timed out after 240000ms' }
        : {},
    }), plan);
    expect(timeout.outcome).toBe('infra_error');

    const crash = await runSuite(fakeSandbox({
      onRun: (command) => command.includes('vitest')
        ? { throwMsg: 'Command exited with code 137' }
        : {},
    }), plan);
    expect(crash.outcome).toBe('infra_error');
  });

  it('keeps a timeout classified as infra_error when the process also emitted stderr', async () => {
    const timeout = await runSuite(fakeSandbox({
      onRun: (command) => command.includes('vitest')
        ? { throwMsg: 'Command timed out after 240000ms', stderr: 'partial assertion output' }
        : {},
    }), plan);
    expect(timeout.outcome).toBe('infra_error');
  });

  it('rejects zero-test and all-skipped collection as infra_error', async () => {
    const zero = await runSuite(fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: JSON.stringify({ numTotalTests: 0, testResults: [] }) },
    }), plan);
    expect(zero.outcome).toBe('infra_error');

    const skipped = await runSuite(fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: JSON.stringify({
        numTotalTests: 2,
        testResults: [{
          name: '/home/user/repo/src/a.test.ts',
          assertionResults: [
            { fullName: 't1', status: 'skipped' },
            { fullName: 't2', status: 'skipped' },
          ],
        }],
      }) },
    }), plan);
    expect(skipped.outcome).toBe('infra_error');
  });

  it('treats a nonzero exit without a failed assertion as infra_error', async () => {
    const result = await runSuite(fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: vitestReport(['passed', 'passed']) },
      onRun: (command) => command.includes('vitest')
        ? { throwMsg: 'Command exited with code 1' }
        : {},
    }), plan);
    expect(result.outcome).toBe('infra_error');
  });

  it('skips a none plan without claiming evidence', async () => {
    const result = await runSuite(fakeSandbox({}), { kind: 'none', command: null });
    expect(result.outcome).toBe('skipped_no_runner');
  });

  it('classifies a vanished sandbox during the SUITE COMMAND as infra_error', async () => {
    // Cleanup succeeds; only the suite command hits the dead machine.
    // Deliberately an npm-script plan: a vitest plan reaches infra_error anyway
    // because the results file is missing, so it cannot tell the new typed
    // branch apart from the pre-existing unparseable-report path.
    const run = await runSuite(
      fakeSandbox({
        onRun: (command) => {
          if (command.startsWith('rm -f')) return { exitCode: 0 };
          throw new SandboxUnavailableError('Sandbox is probably not running anymore');
        },
      }),
      { kind: 'npm-script', command: 'npm test' },
    );
    expect(run.outcome).toBe('infra_error');
  });

  it('classifies a vanished sandbox during PRE-RUN CLEANUP as infra_error', async () => {
    // `rm -f <results path>` used to sit outside the try, so a dead sandbox
    // threw straight past every classifier and out of runSuite entirely.
    const run = await runSuite(
      fakeSandbox({
        onRun: (command) => {
          if (command.startsWith('rm -f')) {
            throw new SandboxUnavailableError('Sandbox is probably not running anymore');
          }
          return { exitCode: 0 };
        },
      }),
      { kind: 'vitest', command: './node_modules/.bin/vitest run' },
    );
    expect(run.outcome).toBe('infra_error');
  });

  it('treats an ordinary cleanup failure as infra_error, never a failed suite', async () => {
    // A failed `rm` must never read as the customer's tests failing, and must
    // not continue — a stale results file would be parsed as this run's result.
    const run = await runSuite(
      fakeSandbox({
        onRun: (command) => {
          if (command.startsWith('rm -f')) throw new Error('rm: permission denied');
          return { exitCode: 0, stdout: '{"testResults":[],"numTotalTests":0}' };
        },
      }),
      { kind: 'npm-script', command: 'npm test' },
    );
    expect(run.outcome).toBe('infra_error');
  });
});

describe('runDeclaredTest', () => {
  it('runs one Vitest identifier and returns its assertion failure', async () => {
    const report = JSON.stringify({
      numTotalTests: 1,
      testResults: [{
        name: '/home/user/repo/src/a.test.ts',
        assertionResults: [{
          fullName: 'selection remains stable',
          status: 'failed',
          failureMessages: ['expected selection to remain stable'],
        }],
      }],
    });
    const commands: string[] = [];
    const result = await runDeclaredTest(fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: report },
      onRun: (command) => {
        commands.push(command);
        return command.includes('vitest') ? { exitCode: 1 } : {};
      },
    }), {
      kind: 'vitest',
      command: `./node_modules/.bin/vitest run --reporter=json --outputFile=${SUITE_RESULTS_PATH}`,
    }, ['src/a.test.ts'], 'selection remains stable');

    expect(result).toMatchObject({
      runnable: true,
      failureMessage: 'expected selection to remain stable',
      run: { outcome: 'failed' },
    });
    expect(commands.some((command) => command.includes("'src/a.test.ts'") && command.includes("-t 'selection remains stable'"))).toBe(true);
  });

  it('refuses an unfilterable package script', async () => {
    await expect(runDeclaredTest(
      fakeSandbox({}),
      { kind: 'npm-script', command: 'npm test' },
      ['test/a.test.js'],
      'regression',
    )).resolves.toEqual({ runnable: false, reason: 'npm_script_not_filterable' });
  });

  it('requires a pytest node id', async () => {
    await expect(runDeclaredTest(
      fakeSandbox({}),
      { kind: 'pytest', command: 'python -m pytest' },
      ['tests/test_a.py'],
      'test_regression',
    )).resolves.toEqual({ runnable: false, reason: 'pytest_identifier_not_node_id' });
  });
});

describe('planTests against an unavailable sandbox', () => {
  it('propagates sandbox death instead of reporting no test runner', async () => {
    // fileExists returning false for a dead machine makes the repo look like it
    // has no runner, and the suite gate then records skipped_no_runner — the
    // same silent misclassification as the build gate's path D.
    const dead: SandboxRuntime = {
      id: 'dead', createdAt: 0, lifetimeMs: 1_800_000, unavailable: true,
      commands: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      files: {
        read: async () => { throw new SandboxUnavailableError('Sandbox is probably not running anymore'); },
        write: async () => undefined,
      },
      kill: async () => undefined,
    };

    await expect(planTests(dead, 'javascript')).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it('propagates a death that happens AFTER package.json is read', async () => {
    // Without this case the suite passes even if fileExists still swallows
    // sandbox death: the package.json read throws first and short-circuits.
    // Mirrors the equivalent guard in sandbox-repo.test.ts.
    let reads = 0;
    const diesLater: SandboxRuntime = {
      id: 'dies-later', createdAt: 0, lifetimeMs: 1_800_000, unavailable: true,
      commands: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      files: {
        read: async (path: string) => {
          reads++;
          if (path.endsWith('package.json')) return JSON.stringify({ scripts: {} });
          throw new SandboxUnavailableError('Sandbox is probably not running anymore');
        },
        write: async () => undefined,
      },
      kill: async () => undefined,
    };

    await expect(planTests(diesLater, 'javascript')).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(reads).toBeGreaterThan(1);
  });
});
