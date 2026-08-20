import { describe, expect, it } from 'vitest';
import { adjudicationFromDecline, parseAdjudication, parseLocations, seal, submitDiagnosisTool } from '../diagnose-schema.js';
import { validateAdjudicationShape } from '../verdict-validation.js';

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
  evidence: [
    { path: 'src/retry.ts', detail: 'counter is outside the loop', symptomLink: 'retries never stop' },
    { path: 'src/request.ts', detail: 'failure enters retry', symptomLink: 'starts the retry loop' },
  ],
  agent_task_brief: '## Change\nReset the retry counter after success.',
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
      const type = schema['type'];
      if (type === 'object' || (Array.isArray(type) && type.includes('object'))) {
        objects.push(schema);
        Object.values((schema['properties'] ?? {}) as Record<string, unknown>).forEach(walk);
      }
      if (type === 'array') walk(schema['items']);
    };
    walk(submitDiagnosisTool().input_schema);

    expect(objects.length).toBeGreaterThan(4);
    for (const schema of objects) {
      expect(schema['additionalProperties']).toBe(false);
      const keys = Object.keys((schema['properties'] ?? {}) as Record<string, unknown>);
      expect(schema['required']).toEqual(expect.arrayContaining(keys));
    }
  });

  it('requires every field routing depends on', () => {
    const required = (submitDiagnosisTool().input_schema as { required?: string[] }).required ?? [];
    expect(required).toEqual(expect.arrayContaining([
      'best_supported', 'evidence_strength', 'cause_kind', 'cause_locations',
      'candidates_considered', 'rejected', 'rejected_candidates',
      'evidence', 'agent_task_brief',
    ]));
  });

  it('exports the recursive strict-schema sealer', () => {
    expect(seal({ type: 'object', properties: {} })).toMatchObject({ additionalProperties: false });
  });
});

describe('grounded candidate parsing', () => {
  it('carries id, citation, and rejected_candidates through', () => {
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'external_system',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 'c1',
        citation: { path: 'src/a.ts', line: 3, quote: 'const alpha = 1' } }],
      rejected: [],
      rejected_candidates: [{ id: 'c1', evidence: 'not the cause',
        citation: { path: 'src/a.ts', line: 3, quote: 'const alpha = 1' } }],
      evidence_strength: 'suggestive', cause_locations: [], reasoning: '',
      evidence: [{ path: 'src/a.ts', detail: 'd', symptomLink: 'l' }], agent_task_brief: '',
    });
    expect(adj?.candidates_considered[0]).toMatchObject({ id: 'c1', citation: { line: 3 } });
    expect(adj?.rejected_candidates).toHaveLength(1);
  });

  it('normalizes malformed candidate grounding to undefined (validator judges sufficiency)', () => {
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'unknown',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 42,
        citation: { path: 'src/a.ts', line: 'three', quote: '' } }],
      rejected: [], rejected_candidates: [], evidence_strength: 'insufficient', cause_locations: [], reasoning: '',
      why_chain: [], reproduction_steps: [], evidence: [], agent_task_brief: '',
    });
    expect(adj?.candidates_considered[0]?.id).toBeUndefined();
    expect(adj?.candidates_considered[0]?.citation).toBeUndefined();
    expect(adj && validateAdjudicationShape(adj)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^candidate_missing_id:/),
    });
  });

  it.each([
    ['whitespace-only quote', '   '],
    ['quote over 300 characters', 'x'.repeat(301)],
  ])('rejects a local candidate with a %s at the submission boundary', (_name, quote) => {
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'external_system',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 'c1',
        citation: { path: 'src/a.ts', line: 3, quote } }],
      rejected: [], rejected_candidates: [], evidence_strength: 'suggestive', cause_locations: [], reasoning: '',
      why_chain: [], reproduction_steps: [], evidence: [], agent_task_brief: '',
    });
    expect(adj && validateAdjudicationShape(adj)).toMatchObject({
      status: 'incomplete', reason: expect.stringMatching(/^candidate_missing_citation:/),
    });
  });

  it('preserves malformed rejections as empty-field entries the validator can reject', () => {
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'external_system',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 'c1',
        citation: { path: 'src/a.ts', line: 3, quote: 'const alpha = 1' } }],
      rejected: [], rejected_candidates: [{ id: 'not-an-id', evidence: 'e', citation: null }],
      evidence_strength: 'suggestive', cause_locations: [], reasoning: '',
      why_chain: [], reproduction_steps: [], evidence: [], agent_task_brief: '',
    });
    expect(adj?.rejected_candidates).toHaveLength(1);
    expect(adj?.rejected_candidates?.[0]).toEqual({
      id: '', evidence: 'e', citation: { path: '', line: 1, quote: '' },
    });
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
      evidence: valid.evidence,
      agent_task_brief: valid.agent_task_brief,
    });
  });

  it('drops malformed citations while preserving valid siblings', () => {
    expect(parseAdjudication({
      ...valid,
      evidence: [
        { path: 'src/bad.ts' },
        { path: 'src/good.ts', detail: 'the guard is absent', symptomLink: 'null reaches render' },
      ],
    })?.evidence).toEqual([
      { path: 'src/good.ts', detail: 'the guard is absent', symptomLink: 'null reaches render' },
    ]);
  });

  it('keeps legacy submissions parseable when the new fields are absent', () => {
    const { evidence: _evidence, agent_task_brief: _brief, ...legacy } = valid;
    expect(parseAdjudication(legacy)).toMatchObject({
      evidence: undefined,
      agent_task_brief: undefined,
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

describe('structural-shape hardening (review round)', () => {
  const cite = { path: 'src/a.ts', line: 3, quote: 'const alpha = 1' };

  it('a non-array rejected_candidates fails closed as a malformed sentinel', () => {
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'external_system',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 'c1', citation: cite }],
      rejected: [], rejected_candidates: 'none',
      evidence_strength: 'suggestive', cause_locations: [], reasoning: '',
      why_chain: [], reproduction_steps: [], evidence: [], agent_task_brief: '',
    });
    expect(adj?.rejected_candidates).toHaveLength(1);
    expect(validateAdjudicationShape(adj!).status).toBe('incomplete');
  });

  it('quotes below the minimum length are dropped by the parser', () => {
    const adj = parseAdjudication({
      best_supported: 'x', evidence_check: '', cause_kind: 'unknown',
      candidates_considered: [{ statement: 's', kind: 'local_code', id: 'c1',
        citation: { path: 'src/a.ts', line: 3, quote: ';' } }],
      rejected: [], rejected_candidates: [],
      evidence_strength: 'insufficient', cause_locations: [], reasoning: '',
      why_chain: [], reproduction_steps: [], evidence: [], agent_task_brief: '',
    });
    expect(adj?.candidates_considered[0]?.citation).toBeUndefined();
  });

  it('the decline adapter keeps emitting the legacy shape (grounding gate unaffected)', () => {
    // If this ever changes, agent-fix's `() => false` quoteAt would turn every
    // local candidate ungrounded and silently disable the unrejected-local
    // gate on the decline path.
    const declined = adjudicationFromDecline({
      one_line_description: 'Cannot reproduce the failure',
      cause_kind: 'external_system',
      cause_locations: [],
      why_chain: [], reproduction_steps: [], unknowns: [],
    });
    expect(declined?.rejected_candidates).toBeUndefined();
    expect(declined?.candidates_considered).toEqual([]);
  });
});

describe('parser-side candidate caps (wire schema cannot carry maxItems)', () => {
  function candidate(i: number) {
    return { statement: `cause ${i}`, kind: 'unknown', id: `c${i}`, citation: null };
  }

  it('caps candidates_considered at 16', () => {
    const raw = {
      best_supported: 'cause 1',
      evidence_check: 'checked',
      candidates_considered: Array.from({ length: 24 }, (_, i) => candidate(i)),
      cause_locations: [{ path: 'src/a.ts' }],
      evidence: [{ path: 'src/a.ts', detail: 'd', symptomLink: 's' }],
    };
    const parsed = parseAdjudication(raw);
    expect(parsed?.candidates_considered).toHaveLength(16);
  });

  it('caps rejected_candidates at 16', () => {
    const raw = {
      best_supported: 'cause 1',
      evidence_check: 'checked',
      candidates_considered: [candidate(1)],
      rejected_candidates: Array.from({ length: 24 }, (_, i) => ({
        id: `c${i}`, evidence: 'e', citation: { path: 'src/a.ts', line: 1, quote: 'const enough_chars_here = 1;' },
      })),
      cause_locations: [{ path: 'src/a.ts' }],
      evidence: [{ path: 'src/a.ts', detail: 'd', symptomLink: 's' }],
    };
    const parsed = parseAdjudication(raw);
    expect(parsed?.rejected_candidates).toHaveLength(16);
  });
});

describe('truncation-orphaned rejections (wire schema cannot carry maxItems)', () => {
  function candidate(i: number) {
    return { statement: `cause ${i}`, kind: 'unknown', id: `c${i}`, citation: null };
  }
  const rejection = (id: string) => ({
    id, evidence: 'checked', citation: { path: 'src/a.ts', line: 1, quote: 'const enough_chars_here = 1;' },
  });
  const base = {
    best_supported: 'cause 1',
    evidence_check: 'checked',
    cause_locations: [{ path: 'src/a.ts' }],
    evidence: [{ path: 'src/a.ts', detail: 'd', symptomLink: 's' }],
  };

  it('drops a rejection whose candidate fell to the cap', () => {
    const parsed = parseAdjudication({
      ...base,
      candidates_considered: Array.from({ length: 20 }, (_, i) => candidate(i)),
      rejected_candidates: [rejection('c18'), rejection('c1')],
    });
    expect(parsed?.rejected_candidates?.map((r) => r.id)).toEqual(['c1']);
  });

  it('keeps an unknown-id rejection when nothing was truncated (a real model error)', () => {
    const parsed = parseAdjudication({
      ...base,
      candidates_considered: [candidate(1)],
      rejected_candidates: [rejection('c9')],
    });
    expect(parsed?.rejected_candidates?.map((r) => r.id)).toEqual(['c9']);
  });
});
