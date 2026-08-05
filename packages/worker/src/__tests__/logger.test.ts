import { describe, it, expect } from 'vitest';
import { safeErrorMessage } from '../logger.js';

describe('safeErrorMessage', () => {
  it('returns the message of an Error', () => {
    expect(safeErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies ordinary values', () => {
    expect(safeErrorMessage('plain')).toBe('plain');
    expect(safeErrorMessage(42)).toBe('42');
    expect(safeErrorMessage(null)).toBe('null');
  });

  it('does not throw on a null-prototype object', () => {
    // String(Object.create(null)) raises TypeError. A raw String(err) inside a
    // catch would re-throw out of the handler.
    const hostile = Object.create(null) as unknown;
    expect(() => safeErrorMessage(hostile)).not.toThrow();
    expect(safeErrorMessage(hostile)).toBe('unserializable error');
  });

  it('does not throw when a message getter throws', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('nope');
      },
    });
    expect(() => safeErrorMessage(hostile)).not.toThrow();
    expect(safeErrorMessage(hostile)).toBe('unserializable error');
  });

  it('does not throw when toString throws', () => {
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };
    expect(() => safeErrorMessage(hostile)).not.toThrow();
  });
});
