import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE_VIEWPORT } from '../frames/capture.js';

describe('DEFAULT_CAPTURE_VIEWPORT', () => {
  it('quarters verification pixels while preserving the replay aspect ratio', () => {
    expect(DEFAULT_CAPTURE_VIEWPORT).toEqual({ width: 720, height: 450 });
    expect(DEFAULT_CAPTURE_VIEWPORT.width / DEFAULT_CAPTURE_VIEWPORT.height).toBeCloseTo(1.6, 5);
  });
});
