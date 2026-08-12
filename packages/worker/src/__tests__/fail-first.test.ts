import { describe, expect, it } from 'vitest';
import {
  createLedgerRecorder,
  deriveTierRecord,
  detectLedgerAnomalies,
} from '../verification-ledger.js';

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
