import { describe, expect, it } from 'vitest';
import {
  createLedgerRecorder,
  deriveTierRecord,
  detectLedgerAnomalies,
  reproChecksNotRun,
  declaredIdentifierGrounded,
} from '../verification-ledger.js';
import { validateDeclaration } from '../harness/fail-first.js';

const tierInput = {
  declaredTest: { identifier: 'keeps selection', expectedAssertion: 'selection remains' },
  reproductionImpossibleReason: null,
  redObserved: true,
  greenObserved: true,
  suiteNewFailures: [] as string[],
  suiteDiscovered: 4,
  buildPassed: true,
  qualityConfirmed: true,
};

describe('deriveTierRecord', () => {
  it('grades a red-then-green attempt with a clean suite as reproduced', () => {
    expect(deriveTierRecord(tierInput).tier).toBe('reproduced');
  });

  it('never promotes a declared test that passed on base', () => {
    expect(deriveTierRecord({ ...tierInput, redObserved: false }).tier).toBe('attempted');
  });

  it('grades an honestly unreproducible but otherwise clean attempt as checked', () => {
    expect(deriveTierRecord({
      ...tierInput,
      declaredTest: null,
      reproductionImpossibleReason: 'browser event loop unavailable',
      redObserved: false,
      greenObserved: false,
    }).tier).toBe('checked');
  });

  it('requires a non-empty comparable suite for reproduced', () => {
    expect(deriveTierRecord({ ...tierInput, suiteDiscovered: 0 }).tier).toBe('attempted');
    expect(deriveTierRecord({ ...tierInput, suiteNewFailures: ['new failure'] }).tier).toBe('attempted');
  });
});

describe('LedgerRecorder', () => {
  it('assigns sequence numbers and puts not-run checks on the final entry', () => {
    const recorder = createLedgerRecorder('job-1', 'project-1');
    const base = {
      command: 'pnpm test', commitSha: 'abc', workdirDirty: false,
      discovered: 1, passed: 1, failed: 0, skipped: 0,
      truncated: false, timedOut: false,
    };
    recorder.record(base, 'suite_baseline');
    recorder.record({ ...base, command: 'pnpm build' }, 'build');
    recorder.finalizeNotRun(['repro_red', 'repro_green']);

    expect(recorder.entries().map((entry) => entry.entrySeq)).toEqual([1, 2]);
    expect(recorder.entries()[0]?.notRun).toEqual([]);
    expect(recorder.entries()[1]?.notRun).toEqual(['repro_red', 'repro_green']);
    expect(recorder.roles()).toEqual([
      { entrySeq: 1, role: 'suite_baseline' },
      { entrySeq: 2, role: 'build' },
    ]);
  });
});

describe('detectLedgerAnomalies', () => {
  it('reports only the frozen mechanical triggers', () => {
    const recorder = createLedgerRecorder('job-1', 'project-1');
    recorder.record({
      command: 'test', commitSha: 'abc', workdirDirty: false,
      discovered: 1, passed: 0, failed: 1, skipped: 0,
      truncated: true, timedOut: false,
    }, 'repro_red');
    expect(detectLedgerAnomalies({
      entries: recorder.entries(),
      declaredTest: tierInput.declaredTest,
      declaredTestFiles: ['src/helper.ts'],
      diff: '',
      testSource: '',
    })).toEqual(expect.arrayContaining([
      'ledger_output_truncated',
      'declared_test_identifier_not_found',
      'declared_file_not_test_material: src/helper.ts',
    ]));
  });
});

// #354: the contract must accept vitest's native assertion text. Vitest prints
// string-equality failures WITH single quotes ("expected 'a' to be 'b'"); the
// assertion is matched in-process against captured output (never interpolated
// into a shell command), so quotes are harmless there. Rejecting them made
// tier `reproduced` unreachable for any real agent (CP5 verify, 3/3 runs).
describe('validateDeclaration (#354)', () => {
  const base = { testFiles: ['src/selection.test.ts'], identifier: 'preserves selection', expectedAssertion: 'x' };

  it('accepts a vitest-style assertion containing single quotes', () => {
    expect(validateDeclaration({ ...base, expectedAssertion: "AssertionError: expected 'a' to be 'b'" })).toBeNull();
  });

  it('accepts backslashes in the assertion (matched in-process, not shelled)', () => {
    expect(validateDeclaration({ ...base, expectedAssertion: 'expected "C:\\tmp" to exist' })).toBeNull();
  });

  it('still rejects control characters in the assertion', () => {
    expect(validateDeclaration({ ...base, expectedAssertion: 'boom\u0007' })).toMatch(/unsafe characters/);
  });

  it('still rejects unsafe identifiers (shell-adjacent field, rule unchanged)', () => {
    expect(validateDeclaration({ ...base, identifier: "preserves 'selection'" })).toMatch(/identifier/);
  });
});

// #354 secondary: a declared-but-never-run repro pair must land in the
// not-run list — the final finalize must be computed from what actually
// recorded, not from whether a declaration existed.
describe('reproChecksNotRun (#354)', () => {
  it('reports both repro checks when neither recorded', () => {
    const recorder = createLedgerRecorder('job-1', 'project-1');
    expect(reproChecksNotRun(recorder.roles())).toEqual(['repro_red', 'repro_green']);
  });

  it('reports only the missing half', () => {
    const recorder = createLedgerRecorder('job-1', 'project-1');
    recorder.record({
      command: 'vitest -t x', commitSha: 'abc', workdirDirty: false,
      discovered: 1, passed: 0, failed: 1, skipped: 0, truncated: false, timedOut: false,
    }, 'repro_red');
    expect(reproChecksNotRun(recorder.roles())).toEqual(['repro_green']);
  });

  it('reports nothing when red and green both ran', () => {
    const recorder = createLedgerRecorder('job-1', 'project-1');
    const row = {
      command: 'vitest -t x', commitSha: 'abc', workdirDirty: false,
      discovered: 1, passed: 0, failed: 1, skipped: 0, truncated: false, timedOut: false,
    };
    recorder.record(row, 'repro_red');
    recorder.record({ ...row, failed: 0, passed: 1 }, 'repro_green');
    expect(reproChecksNotRun(recorder.roles())).toEqual([]);
  });
});

// The runner's -t filter matches the RUNTIME title (nested describe titles +
// the it/test title), which never appears verbatim in source. An agent that
// declares the exact runtime title must not be flagged as fabricating: that
// exact case voided an otherwise judge-approved fix in the slice-9 live run.
describe('declaredIdentifierGrounded', () => {
  const material = [
    "describe('rebuildSelection', () => {",
    "  it('keeps the selected option when the list is reordered', () => {",
    '});',
  ].join('\n');

  it('grounds a verbatim identifier', () => {
    expect(declaredIdentifierGrounded('keeps the selected option when the list is reordered', material)).toBe(true);
  });

  it('grounds a describe-composed runtime title by its it() suffix', () => {
    expect(declaredIdentifierGrounded(
      'rebuildSelection keeps the selected option when the list is reordered', material,
    )).toBe(true);
  });

  it('rejects a fabricated identifier', () => {
    expect(declaredIdentifierGrounded('rebuildSelection preserves identity across renders', material)).toBe(false);
  });

  it('rejects grounding through a too-short title suffix', () => {
    const shortMaterial = "it('works', () => {})";
    expect(declaredIdentifierGrounded('anything at all that ends with works', shortMaterial)).toBe(false);
  });

  it('grounds a pytest node id by its function name', () => {
    expect(declaredIdentifierGrounded(
      'tests/test_selection.py::test_rebuild_keeps_identity',
      'def test_rebuild_keeps_identity():\n    assert rebuild("a") == "a"',
    )).toBe(true);
  });
});
