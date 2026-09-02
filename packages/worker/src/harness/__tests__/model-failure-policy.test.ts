import { describe, expect, it } from 'vitest';
import { classifyModelFailure, deadLetterClassForStop } from '../model-failure-policy.js';

describe('classifyModelFailure', () => {
  it('treats a request-construction 4xx as deterministic', () => {
    expect(classifyModelFailure({ status: 400, detail: 'tools.0.input_schema: maxItems' })).toBe('deterministic');
    expect(classifyModelFailure({ status: 401, detail: 'invalid x-api-key' })).toBe('deterministic');
  });

  it('treats 408, 429, 5xx, and no status as transient', () => {
    for (const status of [408, 429, 500, 529, undefined]) {
      expect(classifyModelFailure({
        ...(status === undefined ? {} : { status }), detail: 'x',
      })).toBe('transient');
    }
  });

  it('recognises an oversized prompt', () => {
    expect(classifyModelFailure({ status: 400, detail: 'prompt is too long: 210000 tokens' }))
      .toBe('oversized');
  });
});

describe('deadLetterClassForStop', () => {
  it('maps caps to limit and agent misbehaviour to agent', () => {
    expect(deadLetterClassForStop('turns_exhausted')).toBe('limit');
    expect(deadLetterClassForStop('budget')).toBe('limit');
    expect(deadLetterClassForStop('truncated')).toBe('limit');
    expect(deadLetterClassForStop('no_tool_call')).toBe('agent');
    expect(deadLetterClassForStop('no_evidence')).toBe('agent');
  });
});
