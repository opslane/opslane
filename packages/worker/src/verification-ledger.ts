export type VerificationTier = 'reproduced' | 'checked' | 'attempted';

/** One executed command, recorded by harness code only. Mirrors fix_run_ledger. */
export interface LedgerEntry {
  jobId: string;
  projectId: string;
  runId: string;
  entrySeq: number;
  command: string;
  commitSha: string;
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
