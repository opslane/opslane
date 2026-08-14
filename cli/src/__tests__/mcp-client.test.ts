import { describe, expect, it } from 'vitest';
import { buildIncidentUrl, parseIncidentId } from '../mcp/client.js';

describe('parseIncidentId', () => {
  const id = '9d4e2a71-77aa-4f83-b8f1-0123456789ab';

  it('accepts a bare uuid', () => {
    expect(parseIncidentId(id)).toBe(id);
  });

  it('extracts the uuid from a dashboard url', () => {
    expect(parseIncidentId(`https://app.example.com/issues/${id}?project=abc`)).toBe(id);
  });

  it('rejects a prefix', () => {
    expect(() => parseIncidentId('9d4e2a71')).toThrow(/full UUID/i);
  });

  it('rejects unrelated text', () => {
    expect(() => parseIncidentId('the field container one')).toThrow(/full UUID/i);
  });
});

describe('buildIncidentUrl', () => {
  it('joins without doubling slashes', () => {
    expect(buildIncidentUrl('https://api.example.com/', 'p1', 'i1'))
      .toBe('https://api.example.com/api/v1/projects/p1/incidents/i1');
  });
});
