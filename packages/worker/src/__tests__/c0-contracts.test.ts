import { describe, expect, it } from 'vitest';

import {
  adjudicationWithEvidence,
  citation,
  diagnosisWithEvidence,
  incompleteOutcome,
} from './contracts/c0-diagnosis.fixture.js';
import {
  digestReceiptFields,
  receiptItem,
} from './contracts/c0-receipts.fixture.js';
import {
  attemptedTierRecord,
  checkedTierRecord,
  ledgerEntry,
  reproducedTierRecord,
} from './contracts/c0-ledger.fixture.js';

describe('C0 frozen contracts', () => {
  it('carries diagnosis evidence and the incomplete outcome', () => {
    expect(adjudicationWithEvidence.evidence).toEqual([citation]);
    expect(diagnosisWithEvidence.agentTaskBrief).toContain('auth wrapper');
    expect(incompleteOutcome).toBe('incomplete');
  });

  it('carries versioned receipt items', () => {
    expect(digestReceiptFields.schema_version).toBe(2);
    expect(digestReceiptFields.receipt_items).toEqual([receiptItem]);
  });

  it('carries verification ledger entries and every tier', () => {
    expect(ledgerEntry.notRun).toEqual(['browser smoke']);
    expect([
      reproducedTierRecord.tier,
      checkedTierRecord.tier,
      attemptedTierRecord.tier,
    ]).toEqual(['reproduced', 'checked', 'attempted']);
  });
});
