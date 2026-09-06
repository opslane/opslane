import { describe, expect, it } from 'vitest';
import { TRACE_POLICY, tracePolicyFor } from '../trace-policy.js';

describe('tracePolicyFor', () => {
  it('turns tracing off for the four job types that never call a model', () => {
    expect(tracePolicyFor('session_analysis')).toEqual({ mode: 'off' });
    expect(tracePolicyFor('stack_resolve')).toEqual({ mode: 'off' });
    expect(tracePolicyFor('ci_watch')).toEqual({ mode: 'off' });
    expect(tracePolicyFor('score_sync')).toEqual({ mode: 'off' });
  });

  it('traces error_fix, which dispatches to the investigation path despite its name', () => {
    expect(tracePolicyFor('error_fix')).toEqual({ mode: 'full' });
  });

  it('keeps fix at full tracing because score_sync reads its trace_url', () => {
    expect(tracePolicyFor('fix')).toEqual({ mode: 'full' });
  });

  it('traces every other model-calling job type', () => {
    for (const jobType of [
      'investigate', 'session_narrate', 'session_verify_frames',
      'issue_inquiry', 'product_context', 'route_map', 'digest_write',
    ] as const) {
      expect(tracePolicyFor(jobType)).toEqual({ mode: 'full' });
    }
  });

  it('defaults an unknown job type to full tracing rather than silently dropping it', () => {
    expect(tracePolicyFor('not_a_real_job' as never)).toEqual({ mode: 'full' });
  });

  it('covers every member of the JobType union', () => {
    expect(Object.keys(TRACE_POLICY)).toHaveLength(13);
  });
});
