import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE_VIEWPORT, MODEL_FRAME_BOX } from '../frames/capture.js';

describe('capture sizing', () => {
  it('renders at desktop width so responsive breakpoints match what the user saw', () => {
    expect(DEFAULT_CAPTURE_VIEWPORT).toEqual({ width: 1_440, height: 900 });
  });

  it('quarters verification pixels while preserving the replay aspect ratio', () => {
    expect(MODEL_FRAME_BOX.width / MODEL_FRAME_BOX.height)
      .toBeCloseTo(DEFAULT_CAPTURE_VIEWPORT.width / DEFAULT_CAPTURE_VIEWPORT.height, 5);
    const renderPixels = DEFAULT_CAPTURE_VIEWPORT.width * DEFAULT_CAPTURE_VIEWPORT.height;
    const modelPixels = MODEL_FRAME_BOX.width * MODEL_FRAME_BOX.height;
    expect(modelPixels).toBeCloseTo(renderPixels / 4, 5);
  });
});
