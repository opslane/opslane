import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical.js';

describe('canonicalJson', () => {
  it('ignores object key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }))
      .toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });

  it('keeps array order and drops undefined properties', () => {
    expect(canonicalJson({ a: [2, 1], u: undefined })).toBe('{"a":[2,1]}');
  });
});


it('preserves keys named __proto__ and rejects non-JSON root values', () => {
  expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe('{"__proto__":{"x":1},"a":2}');
  expect(() => canonicalJson(undefined)).toThrow(/JSON serializable/);
});
