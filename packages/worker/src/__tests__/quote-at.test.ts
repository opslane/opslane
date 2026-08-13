import { describe, expect, it } from 'vitest';
import { quoteWithinWindow } from '../quote-at.js';

const file = [
  'line one  ',
  'line two',
  'line three',
  'line four',
  'line five',
  'line six',
  'line seven',
  'line eight',
  'line nine',
  'needle here',
  'line eleven',
].join('\n');

describe('quoteWithinWindow', () => {
  it('finds a quote at its anchored line', () => expect(quoteWithinWindow(file, 10, 'needle here')).toBe(true));
  it('finds a quote within ±5 lines', () => expect(quoteWithinWindow(file, 6, 'needle here')).toBe(true));
  it('rejects a quote outside the window', () => expect(quoteWithinWindow(file, 1, 'needle here')).toBe(false));
  it('normalizes trailing whitespace per line', () => expect(quoteWithinWindow(file, 1, 'line one')).toBe(true));
  it('rejects whitespace-only quotes', () => expect(quoteWithinWindow(file, 1, '   ')).toBe(false));
  it('rejects an invalid line anchor', () => expect(quoteWithinWindow(file, 0, 'line one')).toBe(false));
});
