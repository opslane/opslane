import { describe, expect, it } from 'vitest';
import type { Adjudication } from '@opslane/shared';
import { parseAdjudication } from '../../diagnose-schema.js';

describe('adjudication grounding contract', () => {
  it('accepts the new grounded shape', () => {
    const adj: Adjudication = {
      best_supported: 'External bridge failure',
      evidence_check: 'checked',
      candidates_considered: [
        {
          id: 'c1',
          statement: 'afterEach calls changeWindowTitle',
          kind: 'local_code',
          citation: { path: 'src/router/index.ts', line: 12, quote: 'router.afterEach' },
        },
      ],
      rejected: [],
      rejected_candidates: [
        {
          id: 'c1',
          evidence: 'The hook only tracks page views',
          citation: { path: 'src/router/index.ts', line: 12, quote: 'router.afterEach' },
        },
      ],
      evidence_strength: 'suggestive',
      cause_kind: 'external_system',
      cause_locations: [],
      reasoning: 'r',
      why_chain: [],
      reproduction_steps: [],
    };
    expect(adj.rejected_candidates?.[0]?.citation.line).toBe(12);
  });

  it('still accepts an unchanged old-shape literal (additivity for producers)', () => {
    const legacy: Adjudication = {
      best_supported: 'x',
      evidence_check: '',
      candidates_considered: [{ statement: 's', kind: 'local_code' }],
      rejected: ['s: ruled out'],
      evidence_strength: 'insufficient',
      cause_kind: 'unknown',
      cause_locations: [],
      reasoning: '',
      why_chain: [],
      reproduction_steps: [],
    };
    expect(legacy.rejected).toHaveLength(1);
  });

  it('a persisted old-JSON row survives the real decoder (additivity for rows)', () => {
    const adj = parseAdjudication(JSON.parse(
      '{"best_supported":"x","evidence_check":"","candidates_considered":[{"statement":"s","kind":"local_code"}],' +
      '"rejected":["s: ruled out"],"evidence_strength":"insufficient","cause_kind":"unknown","cause_locations":[],' +
      '"reasoning":"","why_chain":[],"reproduction_steps":[],"evidence":[{"path":"a","detail":"d","symptomLink":"l"}],' +
      '"agent_task_brief":""}',
    ) as Record<string, unknown>);
    expect(adj?.candidates_considered[0]?.id).toBeUndefined();
    expect(adj?.candidates_considered[0]?.statement).toBe('s');
    expect(adj?.rejected_candidates).toBeUndefined();
    expect(adj?.rejected).toEqual(['s: ruled out']);
  });
});
