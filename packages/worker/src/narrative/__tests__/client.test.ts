import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '../client.js';

describe('extractJsonObject', () => {
  it.each([
    ['{"a":1}', '{"a":1}'],
    ['```json\n{"a":1}\n```', '{"a":1}'],
    ['Here you go: {"a":{"b":2}} done', '{"a":{"b":2}}'],
    ['no json here', ''],
  ])('extracts a complete outer object from %s', (input, expected) => {
    expect(extractJsonObject(input)).toBe(expected);
  });

  it('handles braces inside JSON strings', () => {
    expect(extractJsonObject('before {"a":"}"} after')).toBe('{"a":"}"}');
  });
});
