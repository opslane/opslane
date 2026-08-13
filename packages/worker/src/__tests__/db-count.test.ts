import { describe, expect, it } from 'vitest';
import { toCount } from '../db.js';

describe('toCount', () => {
  it.each([
    ['3', 3],
    [3, 3],
    [null, null],
    [undefined, null],
    ['3.5', null],
    ['abc', null],
    ['', null],
    ['9007199254740993', null],
    [Number.NaN, null],
    ['-2', -2],
  ])('maps %j to %j', (input, want) => {
    expect(toCount(input)).toBe(want);
  });
});
