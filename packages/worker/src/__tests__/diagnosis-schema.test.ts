import { describe, expect, it } from 'vitest';
import { parseDiagnosis, submitDiagnosisTool } from '../diagnosis-schema.js';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    one_line_description: 'Search endpoint exceeds its 10 second budget',
    why_chain: ['User types in search box', 'Client calls /api/assets/search', 'Server does not respond in 10s'],
    reproduction_steps: ['Open the asset panel', 'Type a query with many matches'],
    cause_location: 'GET /issue-context/api/assets/search (remote service)',
    ...overrides,
  };
}

describe('submitDiagnosisTool', () => {
  it('has no field in which the model can name an outcome', () => {
    const properties = submitDiagnosisTool().input_schema.properties as Record<string, unknown>;
    for (const banned of ['fixable', 'outcome', 'reason_code', 'classification', 'assessment']) {
      expect(properties[banned]).toBeUndefined();
    }
  });

  it('requires the four diagnosis fields', () => {
    const required = (submitDiagnosisTool().input_schema as { required: string[] }).required;
    expect(required.sort()).toEqual(['cause_location', 'one_line_description', 'reproduction_steps', 'why_chain']);
  });
});

describe('parseDiagnosis', () => {
  it('parses a well-formed submission', () => {
    const diagnosis = parseDiagnosis(raw());
    expect(diagnosis?.cause_location).toBe('GET /issue-context/api/assets/search (remote service)');
    expect(diagnosis?.why_chain).toHaveLength(3);
  });

  it('returns null when cause_location is missing', () => {
    const input = raw();
    delete input['cause_location'];
    expect(parseDiagnosis(input)).toBeNull();
  });

  it('returns null when cause_location is blank', () => {
    expect(parseDiagnosis(raw({ cause_location: '   ' }))).toBeNull();
  });

  it('returns null when why_chain is empty', () => {
    expect(parseDiagnosis(raw({ why_chain: [] }))).toBeNull();
  });

  it('returns null when reproduction_steps is empty', () => {
    expect(parseDiagnosis(raw({ reproduction_steps: [] }))).toBeNull();
  });

  it('truncates an over-long summary rather than rejecting it', () => {
    const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
    const diagnosis = parseDiagnosis(raw({ one_line_description: long }));
    expect(diagnosis).not.toBeNull();
    expect(diagnosis!.one_line_description.split(/\s+/)).toHaveLength(30);
  });

  it('truncates each why_chain entry to 15 words', () => {
    const long = Array.from({ length: 30 }, (_, index) => `w${index}`).join(' ');
    const diagnosis = parseDiagnosis(raw({ why_chain: [long] }));
    expect(diagnosis!.why_chain[0]!.split(/\s+/)).toHaveLength(15);
  });

  it('drops non-string entries from why_chain rather than failing', () => {
    const diagnosis = parseDiagnosis(raw({ why_chain: ['a real step', 42, null, 'another step'] }));
    expect(diagnosis?.why_chain).toEqual(['a real step', 'another step']);
  });

  it('ignores a failing_request supplied by the model', () => {
    const diagnosis = parseDiagnosis(raw({ failing_request: { method: 'GET', url: '/made-up', count: 99 } }));
    expect(diagnosis?.failing_request).toBeUndefined();
  });

  it('returns null for a non-object', () => {
    expect(parseDiagnosis(null as unknown as Record<string, unknown>)).toBeNull();
  });
});
