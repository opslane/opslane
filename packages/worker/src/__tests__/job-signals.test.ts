import { describe, expect, it } from 'vitest';
import { JobCompletedInTransaction, JobRescheduledError, LeaseLostError } from '../db.js';
import { isJobCompletionSignal } from '../job-signals.js';

describe('isJobCompletionSignal', () => {
  it('recognizes the two throws a handler uses after finishing its own job', () => {
    expect(isJobCompletionSignal(new JobCompletedInTransaction('j1'))).toBe(true);
    expect(isJobCompletionSignal(new JobRescheduledError('j1'))).toBe(true);
  });

  it('treats every other throw as a failure', () => {
    expect(isJobCompletionSignal(new LeaseLostError('j1'))).toBe(false);
    expect(isJobCompletionSignal(new Error('Job j1 completed in its finalizer transaction'))).toBe(false);
    expect(isJobCompletionSignal('JobCompletedInTransaction')).toBe(false);
    expect(isJobCompletionSignal(null)).toBe(false);
  });
});
