import { posix } from 'node:path';
import type { Platform } from '../platform.js';
import type { LedgerRecorder } from '../verification-ledger.js';
import { VerificationInfraError } from './errors.js';
import type { EvidenceRecorder } from './evidence.js';
import { SandboxUnavailableError, type SandboxRuntime } from './sandbox-runtime.js';
import { runDeclaredTest, shq, type SuiteRun, type TestPlan } from './test-runner.js';

const REPO = '/home/user/repo';
const MAX_TEST_SOURCE = 30_000;

export { shq };

export interface FailFirstInput {
  sandbox: SandboxRuntime;
  platform: Platform;
  plan: TestPlan;
  baseSha: string;
  declaredTest: { testFiles: string[]; identifier: string; expectedAssertion: string } | null;
  reproductionImpossibleReason: string | null;
  recorder: LedgerRecorder;
  evidence?: EvidenceRecorder;
}

export interface FailFirstOutcome {
  redObserved: boolean;
  greenObserved: boolean;
  contractViolation: string | null;
  fixCommitSha: string | null;
  declaredTestSource: string | null;
}

/**
 * Validate a reproduction declaration. Exported for the #354 contract tests.
 * The identifier is interpolated into a shell command (via shq) and keeps the
 * conservative charset; the expected assertion is matched IN-PROCESS against
 * captured test output and therefore accepts the characters real test runners
 * emit — vitest's native failure text is `expected 'a' to be 'b'`, and
 * rejecting single quotes made red-then-green unreachable for real agents.
 */
export function validateDeclaration(
  declaration: { testFiles: string[]; identifier: string; expectedAssertion: string },
): string | null {
  if (declaration.testFiles.length < 1 || declaration.testFiles.length > 5) {
    return 'contract_invalid: expected one to five declared files';
  }
  for (const path of declaration.testFiles) {
    const normalized = posix.normalize(path);
    if (
      path.length === 0
      || path.startsWith('/')
      || normalized === '..'
      || normalized.startsWith('../')
      || path.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(path)
    ) return 'contract_invalid: test file escapes the repository';
  }
  if (
    declaration.identifier.length === 0
    || declaration.identifier.length > 300
    || /['\\\u0000-\u001f\u007f]/.test(declaration.identifier)
  ) return 'contract_invalid: identifier contains unsafe characters';
  if (
    declaration.expectedAssertion.length === 0
    || declaration.expectedAssertion.length > 500
    || /[\u0000-\u001f\u007f]/.test(declaration.expectedAssertion)
  ) return 'contract_invalid: expected assertion contains unsafe characters';
  return null;
}

function invalidContract(input: FailFirstInput): string | null {
  if (!input.declaredTest) return null;
  return validateDeclaration(input.declaredTest);
}

/** Failure signatures that mean the declared test never truly executed — the
 * file failed to load or the runner found nothing — so its red run is not
 * evidence about the bug. Anything else (an assertion losing, the buggy code
 * throwing a TypeError inside the test) is valid behavioral red: green runs
 * the same test on the fix, so an unconditionally-broken test cannot pass
 * both gates. */
const NON_EXECUTION_FAILURE = /Cannot find module|Failed to resolve import|Failed to load url|SyntaxError|Transform failed|ERR_MODULE_NOT_FOUND|ImportError|ModuleNotFoundError|collection error|No test files found|no tests? (found|ran)/i;

function isBehavioralFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return !NON_EXECUTION_FAILURE.test(message);
}

async function checkedRun(sandbox: SandboxRuntime, command: string, timeoutMs = 30_000): Promise<string> {
  const result = await sandbox.commands.run(`cd ${REPO} && ${command}`, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function counts(run: SuiteRun): Pick<Parameters<LedgerRecorder['record']>[0], 'discovered' | 'passed' | 'failed' | 'skipped' | 'truncated' | 'timedOut'> {
  const statuses = run.tests ? [...run.tests.values()] : [];
  const passed = statuses.filter((status) => status === 'passed').length;
  const failed = statuses.filter((status) => status === 'failed').length;
  return {
    discovered: run.total,
    passed: run.tests ? passed : null,
    failed: run.tests ? failed : null,
    skipped: run.total === null || !run.tests ? null : Math.max(0, run.total - passed - failed),
    truncated: run.truncated ?? false,
    timedOut: run.timedOut ?? false,
  };
}

async function instrument(input: FailFirstInput): Promise<{ commitSha: string; workdirDirty: boolean }> {
  const [commitSha, status] = await Promise.all([
    checkedRun(input.sandbox, 'git rev-parse HEAD', 10_000),
    // -uno: tracked modifications only. The declared regression test is a new
    // untracked file that is SUPPOSED to be present during repro runs; with
    // plain --porcelain its presence marked every repro entry dirty and the
    // judge read the expected state as a tampered tree.
    input.sandbox.commands.run(`cd ${REPO} && git status --porcelain -uno`, { timeoutMs: 10_000 }),
  ]);
  return { commitSha, workdirDirty: status.stdout.trim().length > 0 };
}

async function sourceAtFix(input: FailFirstInput, fixSha: string): Promise<string> {
  let source = '';
  for (const path of input.declaredTest?.testFiles ?? []) {
    let content: string;
    try {
      content = await checkedRun(input.sandbox, `git show ${shq(`${fixSha}:${path}`)}`, 10_000);
    } catch {
      content = '(unreadable)';
    }
    source += `--- ${path}${content === '(unreadable)' ? ' (unreadable)' : ''} ---\n${content}\n`;
    if (source.length > MAX_TEST_SOURCE) {
      return `${source.slice(0, MAX_TEST_SOURCE)}\n... [declared test source truncated]`;
    }
  }
  return source;
}

export async function runFailFirst(input: FailFirstInput): Promise<FailFirstOutcome> {
  if (!input.declaredTest) {
    input.recorder.finalizeNotRun(['repro_red', 'repro_green']);
    return {
      redObserved: false,
      greenObserved: false,
      contractViolation: input.reproductionImpossibleReason ? null : 'contract_missing: no reproduction declaration',
      fixCommitSha: null,
      declaredTestSource: null,
    };
  }
  const invalid = invalidContract(input);
  if (invalid) {
    input.recorder.finalizeNotRun(['repro_red', 'repro_green']);
    return { redObserved: false, greenObserved: false, contractViolation: invalid, fixCommitSha: null, declaredTestSource: null };
  }

  let originalBranch = '';
  let fixCommitSha: string | null = null;
  let redObserved = false;
  let greenObserved = false;
  let contractViolation: string | null = null;
  let declaredTestSource: string | null = null;
  try {
    originalBranch = await checkedRun(input.sandbox, 'git rev-parse --abbrev-ref HEAD');
    await checkedRun(
      input.sandbox,
      'git -c user.email=fix@opslane.dev -c user.name="Opslane Fix Agent" add -A && '
        + 'git -c user.email=fix@opslane.dev -c user.name="Opslane Fix Agent" commit -m "opslane: candidate fix" --allow-empty',
    );
    fixCommitSha = await checkedRun(input.sandbox, 'git rev-parse HEAD');
    for (const path of input.declaredTest.testFiles) {
      await checkedRun(input.sandbox, `git cat-file -e ${shq(`${fixCommitSha}:${path}`)}`, 10_000)
        .catch(() => { throw new Error('contract_invalid: declared file is absent from the fix commit'); });
    }
    declaredTestSource = await sourceAtFix(input, fixCommitSha);

    await checkedRun(input.sandbox, `git checkout -B opslane-repro ${shq(input.baseSha)}`);
    await checkedRun(input.sandbox, `git checkout ${shq(fixCommitSha)} -- ${input.declaredTest.testFiles.map(shq).join(' ')}`);
    const redInstrument = await instrument(input);
    const red = await runDeclaredTest(
      input.sandbox,
      input.plan,
      input.declaredTest.testFiles,
      input.declaredTest.identifier,
    );
    if (red.run) {
      // Signal, not a hard predicate: the agent declares before the base run
      // exists, so it can only guess the test library's failure phrasing
      // (toBe vs toHaveLength wording vetoed a genuinely red-then-green fix).
      // A gaming agent controls its own assertion text anyway, so exact-text
      // matching adds no strength; the hard predicates remain "the single
      // declared test fails on base with an assertion-class failure and
      // passes on the fix". The match still reaches the judge via the ledger
      // role. Same structural reasoning as the #354 quoting relaxation.
      const assertionMatched = Boolean(
        red.failureMessage?.includes(input.declaredTest.expectedAssertion),
      );
      input.recorder.record({
        command: red.run.command,
        ...redInstrument,
        ...counts(red.run),
      }, 'repro_red', assertionMatched);
      input.evidence?.addCheck('repro_red', red.run.outcome, {
        command: red.run.command,
        exitCode: red.run.exitCode,
        output: red.failureMessage ?? red.run.output,
      });
      redObserved = red.runnable
        && red.run.outcome === 'failed'
        && isBehavioralFailure(red.failureMessage);
      if (red.run.timedOut) contractViolation = 'infra: declared test timed out';
      else if (!redObserved) contractViolation = red.run.outcome === 'failed'
        ? 'contract_violation: the declared test failed to execute on base'
        : 'contract_violation: declared test did not fail on base';
    } else {
      contractViolation = `contract_violation: ${red.reason ?? 'declared test could not run'}`;
    }

    await checkedRun(input.sandbox, `git checkout ${shq(originalBranch)}`);
    const greenInstrument = await instrument(input);
    const green = await runDeclaredTest(
      input.sandbox,
      input.plan,
      input.declaredTest.testFiles,
      input.declaredTest.identifier,
    );
    if (green.run) {
      input.recorder.record({
        command: green.run.command,
        ...greenInstrument,
        ...counts(green.run),
      }, 'repro_green');
      input.evidence?.addCheck('repro_green', green.run.outcome, {
        command: green.run.command,
        exitCode: green.run.exitCode,
        output: green.run.output,
      });
      greenObserved = green.runnable && green.run.outcome === 'passed';
      if (!greenObserved && !contractViolation) {
        contractViolation = `contract_violation: ${green.reason ?? 'declared test did not pass with the fix'}`;
      }
    } else if (!contractViolation) {
      contractViolation = `contract_violation: ${green.reason ?? 'declared test could not run with the fix'}`;
    }
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('contract_invalid:')) contractViolation = message;
    else throw error;
  } finally {
    if (fixCommitSha && originalBranch) {
      try {
        await checkedRun(
          input.sandbox,
          `git checkout ${shq(originalBranch)} && git reset --hard ${shq(fixCommitSha)} && git clean -fd`,
        );
      } catch (error: unknown) {
        if (error instanceof SandboxUnavailableError) throw error;
        throw new VerificationInfraError(
          `Could not restore the candidate fix after fail-first verification: ${error instanceof Error ? error.message : String(error)}`,
          input.evidence?.record() ?? { version: 2, tier: null, checks: [] },
        );
      }
    }
  }
  return { redObserved, greenObserved, contractViolation, fixCommitSha, declaredTestSource };
}
