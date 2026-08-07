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
  cause_locations: [{ path: 'src/retry.ts', line: 42 }],
  reasoning: 'The counter is declared outside the loop body',
  why_chain: ['Request fails', 'Retry fires', 'Counter never resets'],
  reproduction_steps: ['Trigger one failure', 'Observe unbounded retries'],
};

describe('submitDiagnosisTool', () => {
  // The schema IS the guarantee now: parseLocations no longer recovers a
  // JSON-encoded string, because a fallback that quietly repairs a broken shape
  // hides the day the guarantee stops holding. If these fail, the API is no
  // longer validating arguments and the recovery has to come back.
  it('declares itself strict, so the API validates arguments before we see them', () => {
    expect(submitDiagnosisTool().strict).toBe(true);
  });

  it('seals every object in the schema, which strict mode requires', () => {
    const objects: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const schema = node as Record<string, unknown>;
      if (schema['type'] === 'object') {
        objects.push(schema);
        Object.values((schema['properties'] ?? {}) as Record<string, unknown>).forEach(walk);
      }
      if (schema['type'] === 'array') walk(schema['items']);
    };
    walk(submitDiagnosisTool().input_schema);

    // Root, candidates_considered items, cause_locations items.
    expect(objects.length).toBe(3);
    for (const schema of objects) expect(schema['additionalProperties']).toBe(false);
  });

  it('requires every field routing depends on', () => {
    const required = (submitDiagnosisTool().input_schema as { required?: string[] }).required ?? [];
    expect(required).toEqual(expect.arrayContaining([
      'best_supported', 'evidence_strength', 'cause_kind', 'cause_locations',
      'candidates_considered', 'rejected',
    ]));
  });
});

describe('parseLocations', () => {
  it('still treats a plain path string as a single citation', () => {
    expect(parseLocations('src/App.vue:42')).toEqual([{ path: 'src/App.vue', line: 42 }]);
  });

  it('reads the structured shape the schema asks for', () => {
    expect(parseLocations([{ path: 'src/App.tsx', line: 42, note: 'null deref' }])).toEqual([
      { path: 'src/App.tsx', line: 42, note: 'null deref' },
    ]);
  });

  it('preserves order, because the first entry is the claim', () => {
    expect(parseLocations([{ path: 'a/one.ts' }, { path: 'b/two.ts' }])[0]?.path).toBe('a/one.ts');
  });

  // Four correct answers were discarded by demanding a whole-string regex match
  // on a decorated citation. A model that ignores the object schema, or the fix
  // agent's decline path, still gets its answer read.
  it.each([
    ['src/App.tsx', { path: 'src/App.tsx' }],
    ['src/App.tsx:42', { path: 'src/App.tsx', line: 42 }],
    ['src/App.tsx:106-111', { path: 'src/App.tsx', line: 106 }],
    ['packages/ui/nav.tsx:106-111 (missing overflow-y-auto)',
      { path: 'packages/ui/nav.tsx', line: 106, note: 'missing overflow-y-auto' }],
    ['src/App.tsx - the render path', { path: 'src/App.tsx', note: 'the render path' }],
  ])('splits the decorated string %j rather than discarding it', (raw, expected) => {
    expect(parseLocations([raw])).toEqual([expected]);
  });

  it('splits a decorated string even inside the structured path field', () => {
    expect(parseLocations([{ path: 'src/App.tsx:42 (bad guard)' }])).toEqual([
      { path: 'src/App.tsx', line: 42, note: 'bad guard' },
    ]);
  });

  it('accepts a bare string and drops what carries no path', () => {
    expect(parseLocations('src/App.tsx')).toEqual([{ path: 'src/App.tsx' }]);
    expect(parseLocations(['', '  ', null, { note: 'no path' }])).toEqual([]);
  });
});

describe('parseAdjudication', () => {
  it('parses a complete submission', () => {
    expect(parseAdjudication(valid)).toMatchObject({
      evidence_strength: 'suggestive',
      cause_kind: 'local_code',
      cause_locations: [{ path: 'src/retry.ts', line: 42 }],
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
