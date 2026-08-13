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

  // The ±WINDOW boundary, exactly. slice() arithmetic mixing 1-based anchors
  // with 0-based indexes is where an off-by-one would silently widen or narrow
  // the window without any interior test failing.
  it('accepts a quote exactly WINDOW lines below the anchor', () =>
    expect(quoteWithinWindow(file, 5, 'needle here')).toBe(true));
  it('rejects a quote WINDOW+1 lines below the anchor', () =>
    expect(quoteWithinWindow(file, 4, 'needle here')).toBe(false));
  it('accepts a quote exactly WINDOW lines above the anchor', () =>
    expect(quoteWithinWindow(file, 15, 'needle here')).toBe(true));
  it('rejects a quote WINDOW+1 lines above the anchor', () =>
    expect(quoteWithinWindow(file, 16, 'needle here')).toBe(false));

  // A verbatim quote copied out of a CRLF file must still ground: the haystack
  // is normalized per line, so the needle has to be normalized the same way.
  it('matches a single-line quote against a CRLF file', () =>
    expect(quoteWithinWindow('alpha line\r\nbeta line\r\ngamma line', 2, 'beta line')).toBe(true));
  it('matches a multi-line CRLF quote against an LF window', () =>
    expect(quoteWithinWindow('alpha line\nbeta line\ngamma line', 2, 'alpha line\r\nbeta line')).toBe(true));
  it('matches a multi-line quote whose interior lines carry trailing whitespace', () =>
    expect(quoteWithinWindow('alpha line\nbeta line\ngamma line', 2, 'alpha line   \nbeta line')).toBe(true));
});
