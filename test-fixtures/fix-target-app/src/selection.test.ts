import { describe, expect, it } from 'vitest';
import { rebuildSelection } from './selection.js';

describe('rebuildSelection', () => {
  it('keeps the selected option when it remains first', () => {
    expect(rebuildSelection('a', [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ])).toBe('a');
  });

  it('clears selection when the list is empty', () => {
    expect(rebuildSelection('a', [])).toBeNull();
  });
});
