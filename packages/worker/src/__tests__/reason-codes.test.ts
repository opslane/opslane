import { describe, it, expect } from 'vitest';
import type { PersistedDecision } from '../db.js';
import {
  DEFAULT_REMEDIATION,
  INCOMPLETE_REASON_MESSAGES,
  buildReason,
  incompleteReason,
  isIncompleteReasonCode,
  reasonCodeForDecision,
} from '../reason-codes.js';
import type { IncompleteReasonCode } from '../reason-codes.js';

// Compile-time exhaustiveness is enforced by the Record<ReasonCode, string> type;
// this asserts message quality at runtime.
const ALL_CODES = Object.keys(DEFAULT_REMEDIATION);

describe('DEFAULT_REMEDIATION registry', () => {
  it('has an actionable remediation for every reason code', () => {
    expect(ALL_CODES.length).toBeGreaterThanOrEqual(22); // 21 original + low_confidence_fix
    for (const [code, remediation] of Object.entries(DEFAULT_REMEDIATION)) {
      expect(remediation.length, `${code} remediation too short`).toBeGreaterThanOrEqual(20);
      expect(remediation, `${code} has placeholder text`).not.toMatch(/TODO|FIXME|tbd/i);
    }
  });
});

describe('dependency_install_failed', () => {
  it('has its own remediation rather than reusing another code\'s copy', () => {
    const remediation = DEFAULT_REMEDIATION.dependency_install_failed;
    expect(remediation).toMatch(/install/i);
    const others = Object.entries(DEFAULT_REMEDIATION)
      .filter(([code]) => code !== 'dependency_install_failed')
      .map(([, copy]) => copy);
    expect(others).not.toContain(remediation);
  });

  it('builds a complete customer-facing reason contract', () => {
    const r = buildReason('dependency_install_failed');
    expect(r.reason_code).toBe('dependency_install_failed');
    expect(r.reason_message.length).toBeGreaterThanOrEqual(20);
    expect(r.remediation).toBe(DEFAULT_REMEDIATION.dependency_install_failed);
  });
});

describe('buildReason', () => {
  it('fills remediation from the registry when omitted', () => {
    const r = buildReason('budget_exhausted', 'Agent ran out of budget');
    expect(r.reason_code).toBe('budget_exhausted');
    expect(r.reason_message).toBe('Agent ran out of budget');
    expect(r.remediation).toBe(DEFAULT_REMEDIATION.budget_exhausted);
  });

  it('lets the caller override remediation', () => {
    const r = buildReason('tests_failed', 'msg', 'custom remediation here, long enough');
    expect(r.remediation).toBe('custom remediation here, long enough');
  });

  it('falls back to the registry message when no message is given', () => {
    const r = buildReason('low_confidence_fix');
    expect(r.reason_message.length).toBeGreaterThanOrEqual(20);
    expect(r.remediation).toBe(DEFAULT_REMEDIATION.low_confidence_fix);
  });
});

describe('reasonCodeForDecision cause kinds', () => {
  const base = {
    outcome: 'not_actionable',
    basis: 'cause_outside_codebase',
    confidence: 'low',
  } as const satisfies PersistedDecision;

  it('maps an external-system cause to unfixable_third_party', () => {
    expect(reasonCodeForDecision({ ...base, causeKind: 'external_system' })).toBe('unfixable_third_party');
  });

  it('keeps a data-or-input cause mapped to unfixable_infra', () => {
    expect(reasonCodeForDecision({ ...base, causeKind: 'data_or_input' })).toBe('unfixable_infra');
  });

  it('keeps a legacy row without causeKind mapped to unfixable_infra', () => {
    expect(reasonCodeForDecision(base)).toBe('unfixable_infra');
  });
});

describe('incomplete fix reasons', () => {
  it('has fixed copy for exactly the incomplete codes', () => {
    expect(Object.keys(INCOMPLETE_REASON_MESSAGES).sort()).toEqual([
      'budget_exhausted',
      'worker_runtime_error',
    ]);
  });

  it('builds every incomplete reason from fixed copy and the default remediation', () => {
    for (const code of Object.keys(INCOMPLETE_REASON_MESSAGES) as IncompleteReasonCode[]) {
      expect(incompleteReason(code)).toEqual({
        reason_code: code,
        reason_message: INCOMPLETE_REASON_MESSAGES[code],
        remediation: DEFAULT_REMEDIATION[code],
      });
    }
  });

  it('pins the copy a reader sees', () => {
    expect(incompleteReason('budget_exhausted').reason_message).toBe(
      'The fix attempt stopped before it produced a result: it reached its turn or spend limit, or a model call failed.',
    );
    expect(incompleteReason('worker_runtime_error').reason_message).toBe(
      'The fix attempt stopped on an internal error before it produced a result.',
    );
  });

  it('recognizes only incomplete codes', () => {
    expect(isIncompleteReasonCode('budget_exhausted')).toBe(true);
    expect(isIncompleteReasonCode('worker_runtime_error')).toBe(true);
    expect(isIncompleteReasonCode('verification_infra_error')).toBe(false);
    expect(isIncompleteReasonCode('low_confidence_fix')).toBe(false);
    expect(isIncompleteReasonCode('toString')).toBe(false);
    expect(isIncompleteReasonCode(undefined)).toBe(false);
    expect(isIncompleteReasonCode(null)).toBe(false);
  });
});
