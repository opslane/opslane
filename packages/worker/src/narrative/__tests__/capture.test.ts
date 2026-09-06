import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { captureFrames, MODEL_FRAME_BOX } from '../frames/capture.js';

const chromiumAvailable = (() => {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
})();

describe.skipIf(!chromiumAvailable)('captureFrames', () => {
  it('captures a before/after pair and marks blocked replay assets', async () => {
    const start = 1_700_000_000_000;
    const result = await captureFrames([{ events: [
      { type: 4, data: { href: 'https://app.example.com/x', width: 1440, height: 900 }, timestamp: start },
      { type: 2, timestamp: start + 10, data: { node: { id: 1, type: 0, childNodes: [
        { id: 2, type: 2, tagName: 'link', attributes: { rel: 'stylesheet', href: 'https://evil.example/style.css' }, childNodes: [] },
        { id: 3, type: 2, tagName: 'h1', attributes: {}, childNodes: [
          { id: 4, type: 3, textContent: 'Hello' },
        ] },
      ] } } },
    ], meta: { chunked_at: start, has_full_snapshot: true, sdk_version: 'test' } }] as never, [1_000]);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]?.png.length).toBeGreaterThan(1_000);
    // PNG IHDR dimensions: the replay viewport and stored evidence stay intact.
    for (const frame of result.frames) {
      expect([frame.png.readUInt32BE(16), frame.png.readUInt32BE(20)]).toEqual([1440, 900]);
      expect([frame.modelPng.readUInt32BE(16), frame.modelPng.readUInt32BE(20)])
        .toEqual([MODEL_FRAME_BOX.width, MODEL_FRAME_BOX.height]);
    }
    expect(result.assetsMissing).toBe(true);
  }, 60_000);
});
