import { describe, expect, it } from 'vitest';
import { parseAdjudication, parseLocations, submitDiagnosisTool } from '../diagnose-schema.js';

const valid = {
  best_supported: 'The retry loop never resets its counter',
  evidence_check: 'Read the loop and confirmed no reset',
  candidates_considered: [
    { statement: 'The retry loop never resets', kind: 'local_code' },
    { statement: 'The server rate limits', kind: 'external_system' },
  ],
  rejected: ['Server rate limiting: breadcrumb gaps are 2m+, not burst-shaped'],
  evidence_strength: 'suggestive',
  cause_kind: 'local_code',
  cause_locations: ['src/retry.ts:42'],
  reasoning: 'The counter is declared outside the loop body',
  why_chain: ['Request fails', 'Retry fires', 'Counter never resets'],
  reproduction_steps: ['Trigger one failure', 'Observe unbounded retries'],
};

describe('submitDiagnosisTool', () => {
  it('requires every field routing depends on', () => {
    const required = (submitDiagnosisTool().input_schema as { required?: string[] }).required ?? [];
    expect(required).toEqual(expect.arrayContaining([
      'best_supported', 'evidence_strength', 'cause_kind', 'cause_locations',
      'candidates_considered', 'rejected',
    ]));
  });
});

describe('parseLocations', () => {
  it('keeps an external citation intact and still extracts embedded paths', () => {
    expect(parseLocations(['GET /api/assets/search (remote service)'])).toEqual([
      'GET /api/assets/search (remote service)',
      'api/assets/search',
    ]);
  });

  it('preserves order, because the first entry is the claim', () => {
    expect(parseLocations(['a/one.ts', 'b/two.ts'])[0]).toBe('a/one.ts');
  });

  it('accepts a bare string and drops empties', () => {
    expect(parseLocations('src/App.tsx')).toEqual(['src/App.tsx']);
    expect(parseLocations(['', '  ', null])).toEqual([]);
  });
});

describe('parseAdjudication', () => {
  it('parses a complete submission', () => {
    expect(parseAdjudication(valid)).toMatchObject({
      evidence_strength: 'suggestive',
      cause_kind: 'local_code',
      cause_locations: ['src/retry.ts:42'],
    });
  });

  it('parses the candidate list, dropping malformed entries', () => {
    const parsed = parseAdjudication({
      ...valid,
      candidates_considered: [
        { statement: 'good', kind: 'local_code' },
        { statement: '', kind: 'local_code' },
        { kind: 'local_code' },
        'not an object',
      ],
    });

    expect(parsed?.candidates_considered).toEqual([{ statement: 'good', kind: 'local_code' }]);
  });

  it('defaults an unrecognised candidate kind to unknown', () => {
    const parsed = parseAdjudication({
      ...valid,
      candidates_considered: [{ statement: 'x', kind: 'gremlins' }],
    });

    expect(parsed?.candidates_considered[0]?.kind).toBe('unknown');
  });

  it('returns null without a best_supported claim', () => {
    expect(parseAdjudication({ ...valid, best_supported: '   ' })).toBeNull();
  });

  it('falls back to unknown and insufficient on unrecognised enums', () => {
    expect(parseAdjudication({ ...valid, cause_kind: 'gremlins' })?.cause_kind).toBe('unknown');
    expect(parseAdjudication({ ...valid, evidence_strength: 'certain' })?.evidence_strength).toBe('insufficient');
  });
});
