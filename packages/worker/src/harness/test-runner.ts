import type { CheckOutcome } from '@opslane/shared';
import { SandboxUnavailableError, type SandboxRuntime } from './sandbox-runtime.js';
import { scrubSecrets } from './redact.js';
import type { Platform } from '../platform.js';
import { parseJUnitXml } from './junit.js';

const SANDBOX_REPO = '/home/user/repo';
export const SUITE_RESULTS_PATH = '/tmp/opslane-suite-results.json';
export const PYTEST_RESULTS_PATH = '/tmp/opslane-junit.xml';
const SUITE_TIMEOUT_MS = 240_000;
const MAX_SUITE_OUTPUT = 4000;

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface TestPlan {
  kind: 'vitest' | 'pytest' | 'npm-script' | 'none';
  command: string | null;
}

interface PackageJsonLike {
  scripts?: Record<string, string>;
  workspaces?: unknown;
}

export function selectTestCommand(
  pkg: PackageJsonLike,
  vitestBinExists: boolean,
  packageManager: PackageManager = 'npm',
): TestPlan {
  if (pkg.workspaces) return { kind: 'none', command: null };
  if (vitestBinExists) {
    return {
      kind: 'vitest',
      command: `./node_modules/.bin/vitest run --reporter=json --outputFile=${SUITE_RESULTS_PATH}`,
    };
  }
  if (pkg.scripts?.['test']) {
    return {
      kind: 'npm-script',
      command: packageManager === 'npm' ? 'npm test' : `${packageManager} test`,
    };
  }
  return { kind: 'none', command: null };
}

export type TestStatus = 'passed' | 'failed';

export interface ParsedSuite {
  tests: Map<string, TestStatus>;
  total: number;
  failureMessages: Map<string, string>;
}

interface JsonAssertion {
  fullName?: string;
  title?: string;
  status?: string;
  failureMessages?: string[];
}

interface JsonTestFile {
  name?: string;
  assertionResults?: JsonAssertion[];
}

interface JsonReport {
  numTotalTests?: number;
  testResults?: JsonTestFile[];
}

export function parseSuiteJson(raw: string): ParsedSuite {
  const report = JSON.parse(raw) as JsonReport;
  const tests = new Map<string, TestStatus>();
  const failureMessages = new Map<string, string>();
  for (const file of report.testResults ?? []) {
    const fileName = (file.name ?? '').replace(`${SANDBOX_REPO}/`, '');
    for (const assertion of file.assertionResults ?? []) {
      const id = `${fileName}::${assertion.fullName ?? assertion.title ?? ''}`;
      if (assertion.status === 'passed') tests.set(id, 'passed');
      else if (assertion.status === 'failed') {
        tests.set(id, 'failed');
        failureMessages.set(id, (assertion.failureMessages ?? []).join('\n'));
      }
    }
  }
  return { tests, total: report.numTotalTests ?? tests.size, failureMessages };
}

export interface SuiteRun {
  outcome: CheckOutcome;
  command: string;
  tests: Map<string, TestStatus> | null;
  total: number | null;
  exitCode?: number;
  output: string;
  timedOut?: boolean;
  truncated?: boolean;
  failureMessages?: Map<string, string>;
}

export interface SuiteComparison {
  baselineFailed: string[];
  newFailures: string[];
  missingFromPost: string[];
  comparable: boolean;
}

export function compareSuiteRuns(
  baseline: SuiteRun | null,
  post: SuiteRun,
): SuiteComparison {
  if (post.tests && baseline?.tests) {
    const baselineFailed = [...baseline.tests]
      .filter(([, status]) => status === 'failed')
      .map(([id]) => id);
    const newFailures = [...post.tests]
      .filter(([id, status]) => status === 'failed' && baseline.tests?.get(id) !== 'failed')
      .map(([id]) => id);
    const missingFromPost = [...baseline.tests]
      .filter(([id]) => !post.tests?.has(id))
      .map(([id]) => id);
    return { baselineFailed, newFailures, missingFromPost, comparable: true };
  }

  const baselineFailedCoarse = baseline?.outcome === 'failed';
  const postPassed = post.outcome === 'passed';
  return {
    baselineFailed: baselineFailedCoarse ? ['<suite>'] : [],
    newFailures: !postPassed && !baselineFailedCoarse ? ['<suite>'] : [],
    missingFromPost: [],
    comparable: postPassed,
  };
}

/**
 * Mirrors the guard in sandbox-repo.ts: a vanished sandbox must not read as
 * "file absent". Otherwise planTests finds no runner, returns `{kind:'none'}`,
 * and the suite gate records skipped_no_runner for a machine that is simply
 * gone. Other read failures (permissions, transport) still return false.
 */
async function fileExists(sandbox: SandboxRuntime, path: string): Promise<boolean> {
  try {
    await sandbox.files.read(path);
    return true;
  } catch (err: unknown) {
    if (err instanceof SandboxUnavailableError) throw err;
    return false;
  }
}

export async function planTests(
  sandbox: SandboxRuntime,
  platform: Platform = 'javascript',
): Promise<TestPlan> {
  if (platform === 'python') {
    return { kind: 'pytest', command: `python -m pytest --junit-xml=${PYTEST_RESULTS_PATH}` };
  }
  let pkg: PackageJsonLike = {};
  try {
    pkg = JSON.parse(await sandbox.files.read(`${SANDBOX_REPO}/package.json`)) as PackageJsonLike;
  } catch (err: unknown) {
    // Same asymmetry as runBuildGate: a dead machine must not read as a repo
    // that simply has no package.json.
    if (err instanceof SandboxUnavailableError) throw err;
    // A repository without a root package.json has no supported Phase-1 runner.
  }
  if (pkg.workspaces || await fileExists(sandbox, `${SANDBOX_REPO}/pnpm-workspace.yaml`)) {
    return { kind: 'none', command: null };
  }
  const packageManager: PackageManager = await fileExists(sandbox, `${SANDBOX_REPO}/pnpm-lock.yaml`)
    ? 'pnpm'
    : await fileExists(sandbox, `${SANDBOX_REPO}/yarn.lock`)
      ? 'yarn'
      : 'npm';
  return selectTestCommand(
    pkg,
    await fileExists(sandbox, `${SANDBOX_REPO}/node_modules/.bin/vitest`),
    packageManager,
  );
}

function bound(raw: string): string {
  return scrubSecrets(raw).slice(-MAX_SUITE_OUTPUT);
}

export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface CommandFailureLike {
  message?: string;
  exitCode?: number | null;
  stdout?: unknown;
  stderr?: unknown;
}

function failureExitCode(error: unknown): number | undefined {
  const failure = error as CommandFailureLike;
  if (typeof failure.exitCode === 'number') return failure.exitCode;
  const match = String(failure.message ?? '').match(/exited with code (\d+)/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function failureOutput(error: unknown): string {
  const failure = error as CommandFailureLike;
  const detail = [failure.stderr, failure.stdout]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n');
  return detail || (error instanceof Error ? error.message : String(error));
}

export async function runSuite(
  sandbox: SandboxRuntime,
  plan: TestPlan,
): Promise<SuiteRun> {
  if (plan.kind === 'none' || !plan.command) {
    return {
      outcome: 'skipped_no_runner',
      command: '',
      tests: null,
      total: null,
      output: 'No test runner detected',
    };
  }

  // Cleanup gets its OWN catch. Folding it into the suite try would let an
  // ordinary `rm` failure be reported as the customer's tests failing; leaving
  // it uncaught (the previous code) let a dead sandbox throw past every
  // classifier and surface as worker_runtime_error.
  const cleanupCommand = `rm -f ${plan.kind === 'pytest' ? PYTEST_RESULTS_PATH : SUITE_RESULTS_PATH}`;
  try {
    await sandbox.commands.run(cleanupCommand, { timeoutMs: 10_000 });
  } catch (error: unknown) {
    // EVERY cleanup failure is infrastructure, not a verdict. Continuing would
    // let the parser read a results file left by a previous run and report it
    // as this patch's outcome — a stale-evidence false positive.
    //
    // Report the cleanup command, not plan.command: evidence is customer-facing,
    // and pairing "npm test" with an `rm` failure reads as the suite failing.
    const detail = error instanceof Error ? error.message : String(error);
    return {
      outcome: 'infra_error',
      command: cleanupCommand,
      tests: null,
      total: null,
      output: bound(scrubSecrets(detail)),
    };
  }

  let rawOutput = '';
  let exitCode = 0;
  try {
    const result = await sandbox.commands.run(
      `cd ${SANDBOX_REPO} && ${plan.command}`,
      { timeoutMs: SUITE_TIMEOUT_MS },
    );
    exitCode = result.exitCode;
    rawOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: null,
        total: null,
        output: bound(scrubSecrets(error.message)),
      };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const output = failureOutput(error);
    if (/timed out|timeout/i.test(errorMessage)) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: null,
        total: null,
        output: bound(output),
        timedOut: true,
      };
    }
    exitCode = failureExitCode(error) ?? 1;
    rawOutput = output;
  }
  const output = bound(rawOutput);
  const exitedNonZero = exitCode !== 0;

  if (plan.kind === 'pytest') {
    if (exitCode > 1) {
      return { outcome: 'infra_error', command: plan.command, tests: null, total: null, exitCode, output };
    }
    const parsed = await sandbox.files.read(PYTEST_RESULTS_PATH)
      .then(parseJUnitXml)
      .catch(() => ({ outcome: 'infra_error' as const, tests: new Map<string, TestStatus>(), total: 0 }));
    const outcome = exitCode === 1 && parsed.outcome === 'passed'
      ? 'infra_error'
      : parsed.outcome;
    return {
      outcome,
      command: plan.command,
      tests: parsed.tests,
      total: parsed.total,
      exitCode,
      output,
    };
  }

  if (plan.kind === 'vitest') {
    let parsed: ParsedSuite | null = null;
    try {
      parsed = parseSuiteJson(await sandbox.files.read(SUITE_RESULTS_PATH));
    } catch {
      // A missing/unparseable report means the runner did not produce comparable evidence.
    }
    if (!parsed) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: null,
        total: null,
        exitCode,
        output,
      };
    }
    if (parsed.total === 0 || parsed.tests.size === 0) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: parsed.tests,
        total: parsed.total,
        exitCode,
        output: `Zero executed tests. ${output}`.trim(),
      };
    }
    const anyFailed = [...parsed.tests.values()].some((status) => status === 'failed');
    if (exitedNonZero && !anyFailed) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: parsed.tests,
        total: parsed.total,
        exitCode,
        output: `Runner exited nonzero without a failed assertion. ${output}`.trim(),
      };
    }
    return {
      outcome: anyFailed ? 'failed' : 'passed',
      command: plan.command,
      tests: parsed.tests,
      total: parsed.total,
      exitCode,
      output,
      failureMessages: parsed.failureMessages,
    };
  }

  return {
    outcome: exitedNonZero ? 'failed' : 'passed',
    command: plan.command,
    tests: null,
    total: null,
    exitCode,
    output,
  };
}

export async function runDeclaredTest(
  sandbox: SandboxRuntime,
  plan: TestPlan,
  testFiles: string[],
  identifier: string,
): Promise<{ runnable: boolean; reason?: string; run?: SuiteRun; failureMessage?: string }> {
  if (plan.kind === 'none' || !plan.command) return { runnable: false, reason: 'no_test_runner' };
  if (plan.kind === 'npm-script') return { runnable: false, reason: 'npm_script_not_filterable' };
  if (plan.kind === 'pytest' && !identifier.includes('::')) {
    return { runnable: false, reason: 'pytest_identifier_not_node_id' };
  }

  const filtered: TestPlan = plan.kind === 'pytest'
    ? {
      kind: 'pytest',
      command: `python -m pytest ${shq(identifier)} --junit-xml=${PYTEST_RESULTS_PATH}`,
    }
    : {
      kind: 'vitest',
      command: `${plan.command} ${testFiles.map(shq).join(' ')} -t ${shq(identifier)}`,
    };
  const run = await runSuite(sandbox, filtered);
  if (!run.tests) return { runnable: false, reason: 'declared_test_report_unavailable', run };
  const match = [...run.tests.keys()].find((id) =>
    id === identifier || id.endsWith(`::${identifier}`) || id.includes(identifier));
  if (!match) return { runnable: false, reason: 'declared_test_not_reported', run };
  return {
    runnable: true,
    run,
    failureMessage: run.failureMessages?.get(match) ?? run.output,
  };
}
