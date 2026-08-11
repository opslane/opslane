import type {
  LedgerEntry,
  TierRecord,
  VerificationTier,
} from '../../verification-ledger.js';

export const reproducedTier: VerificationTier = 'reproduced';
export const checkedTier: VerificationTier = 'checked';
export const attemptedTier: VerificationTier = 'attempted';

export const reproducedTierRecord: TierRecord = {
  tier: reproducedTier,
  declaredTest: {
    identifier: 'src/auth-wrapper.test.ts:keeps the fallback visible',
    expectedAssertion: 'The fallback remains until the async component resolves.',
  },
  reproductionImpossibleReason: null,
};

export const checkedTierRecord: TierRecord = {
  tier: checkedTier,
  declaredTest: null,
  reproductionImpossibleReason: 'The production identity provider cannot run locally.',
};

export const attemptedTierRecord: TierRecord = {
  tier: attemptedTier,
  declaredTest: null,
  reproductionImpossibleReason: null,
};

export const ledgerEntry: LedgerEntry = {
  jobId: 'job-1',
  projectId: 'project-1',
  runId: 'run-1',
  entrySeq: 1,
  command: 'pnpm test -- auth-wrapper.test.ts',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  workdirDirty: true,
  discovered: 2,
  passed: 1,
  failed: 1,
  skipped: 0,
  truncated: false,
  timedOut: false,
  notRun: ['browser smoke'],
};
