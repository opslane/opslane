import { randomUUID } from 'node:crypto';

export type VerificationTier = 'reproduced' | 'checked' | 'attempted';

/** One executed command, recorded by harness code only. Mirrors fix_run_ledger. */
export interface LedgerEntry {
  jobId: string;
  projectId: string;
  runId: string;
  entrySeq: number;
  command: string;
  commitSha: string;
  /** True when TRACKED files differ from the commit (git status -uno): the
   * tamper signal. Untracked files — install artifacts, the declared
   * regression test — do not set it; repro runs legitimately carry them. */
  workdirDirty: boolean;
  discovered: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  truncated: boolean;
  timedOut: boolean;
  notRun: string[];
}

/** The mechanical grade of one fix attempt, derived from ledger entries. */
export interface TierRecord {
  tier: VerificationTier;
  /** The declared expected-failure contract, when tier is 'reproduced'. */
  declaredTest: { identifier: string; expectedAssertion: string } | null;
  /** Why reproduction was declared impossible, when tier is 'checked'. */
  reproductionImpossibleReason: string | null;
}

export type LedgerRole =
  | 'suite_baseline'
  | 'repro_red'
  | 'repro_green'
  | 'suite_post_patch'
  | 'build';

export interface LedgerRecorder {
  runId: string;
  record(
    entry: Omit<LedgerEntry, 'jobId' | 'projectId' | 'runId' | 'entrySeq' | 'notRun'>,
    role: LedgerRole,
    assertionMatched?: boolean,
  ): void;
  finalizeNotRun(checks: string[]): void;
  entries(): LedgerEntry[];
  roles(): Array<{ entrySeq: number; role: LedgerRole; assertionMatched?: boolean }>;
}

export function createLedgerRecorder(jobId: string, projectId: string): LedgerRecorder {
  const runId = randomUUID();
  const recorded: LedgerEntry[] = [];
  const recordedRoles: Array<{ entrySeq: number; role: LedgerRole; assertionMatched?: boolean }> = [];
  return {
    runId,
    record(entry, role, assertionMatched) {
      const entrySeq = recorded.length + 1;
      recorded.push({ jobId, projectId, runId, entrySeq, ...entry, notRun: [] });
      recordedRoles.push({
        entrySeq,
        role,
        ...(assertionMatched === undefined ? {} : { assertionMatched }),
      });
    },
    finalizeNotRun(checks) {
      for (const entry of recorded) entry.notRun = [];
      const last = recorded.at(-1);
      if (last) last.notRun = [...checks];
    },
    entries: () => recorded.map((entry) => ({ ...entry, notRun: [...entry.notRun] })),
    roles: () => recordedRoles.map((role) => ({ ...role })),
  };
}

export function deriveTierRecord(args: {
  declaredTest: { identifier: string; expectedAssertion: string } | null;
  reproductionImpossibleReason: string | null;
  redObserved: boolean;
  greenObserved: boolean;
  suiteNewFailures: string[] | null;
  suiteDiscovered: number | null;
  buildPassed: boolean | null;
  qualityConfirmed: boolean | null;
}): TierRecord {
  const cleanSuite = Array.isArray(args.suiteNewFailures) && args.suiteNewFailures.length === 0;
  const reproduced = Boolean(
    args.declaredTest
    && args.redObserved
    && args.greenObserved
    && cleanSuite
    && args.suiteDiscovered !== null
    && args.suiteDiscovered > 0,
  );
  const checked = Boolean(
    !reproduced
    && !args.declaredTest
    && args.reproductionImpossibleReason
    && cleanSuite
    && args.buildPassed === true
    && args.qualityConfirmed === true,
  );
  return {
    tier: reproduced ? 'reproduced' : checked ? 'checked' : 'attempted',
    declaredTest: args.declaredTest,
    reproductionImpossibleReason: args.reproductionImpossibleReason,
  };
}

/**
 * Whether a declared test identifier is grounded in the submitted test
 * material. A verbatim match is the simple case, but a runner-facing runtime
 * title is composed from nested describe titles plus the it/test title
 * ("rebuildSelection keeps the selected option ..."), so the full name never
 * appears as one substring in source. An agent that declares the exact
 * runtime title — precisely what the `-t` filter needs — must not be flagged
 * as fabricating, so the declaration is also grounded when some it/test
 * string literal in the material is the suffix of the declared identifier,
 * or when a pytest node id's function name appears in the material.
 */
export function declaredIdentifierGrounded(identifier: string, material: string): boolean {
  if (material.includes(identifier)) return true;
  const literalPattern = /\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1).)+?)\1/g;
  for (const match of material.matchAll(literalPattern)) {
    const title = match[2]!.replace(/\\(['"`\\])/g, '$1');
    // A short title suffix grounds too easily ("works" would bless almost any
    // fabricated name); require enough length to be distinctive.
    if (title.length >= 8 && identifier.endsWith(title)) return true;
  }
  const pytestName = identifier.split('::').pop() ?? '';
  if (/^test_[A-Za-z0-9_]+(\[.*\])?$/.test(pytestName)) {
    const bareName = pytestName.replace(/\[.*\]$/, '');
    if (material.includes(bareName)) return true;
  }
  return false;
}

const TEST_MATERIAL_PATTERNS = [
  /\.(test|spec)\./i,
  /(^|\/)__tests__\//i,
  /(^|\/)tests?\//i,
  /(conftest|fixture)/i,
];

export function detectLedgerAnomalies(args: {
  entries: LedgerEntry[];
  declaredTest: { identifier: string; expectedAssertion: string } | null;
  declaredTestFiles: string[];
  diff: string;
  testSource: string | null;
}): string[] {
  const anomalies: string[] = [];
  if (args.entries.some((entry) => entry.truncated)) anomalies.push('ledger_output_truncated');
  if (args.entries.some((entry) => entry.timedOut)) anomalies.push('ledger_command_timed_out');
  if (
    args.declaredTest
    && !declaredIdentifierGrounded(args.declaredTest.identifier, `${args.diff}\n${args.testSource ?? ''}`)
  ) {
    anomalies.push('declared_test_identifier_not_found');
  }
  for (const path of args.declaredTestFiles) {
    if (!TEST_MATERIAL_PATTERNS.some((pattern) => pattern.test(path))) {
      anomalies.push(`declared_file_not_test_material: ${path}`);
    }
  }
  return anomalies;
}


/**
 * The repro checks absent from a run's recorded roles — the data-driven input
 * to the final not-run list. A declared test whose contract was rejected (or
 * whose red run never executed) must surface here rather than vanish from
 * both the executed rows and the not-run list (#354).
 */
export function reproChecksNotRun(
  roles: Array<{ entrySeq: number; role: LedgerRole; assertionMatched?: boolean }>,
): string[] {
  const ran = new Set(roles.map((entry) => entry.role));
  return (['repro_red', 'repro_green'] as const).filter((check) => !ran.has(check));
}
