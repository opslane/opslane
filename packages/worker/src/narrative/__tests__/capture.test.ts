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
  it('captures four requested moments for a confirmation batch', async () => {
    const start = 1_700_000_000_000;
    const result = await captureFrames([{ events: [
      { type: 4, data: { href: 'https://app.example.com/x', width: 1440, height: 900 }, timestamp: start },
      { type: 2, timestamp: start + 10, data: { node: { id: 1, type: 0, childNodes: [
        { id: 2, type: 2, tagName: 'p', attributes: {}, childNodes: [{ id: 3, type: 3, textContent: 'Saved' }] },
      ] } } },
    ], meta: { chunked_at: start, has_full_snapshot: true, sdk_version: 'test' } }] as never, [1000, 2000, 3000, 4000, 5000], { maxOffsets: 4 });
    expect(result.frames.map((f) => f.offsetMs)).toEqual([1000, 1000, 2000, 2000, 3000, 3000, 4000, 4000]);
  }, 60_000);

  it('renders a late event the same whether the recording is sent in one batch or one event per call', async () => {
    const start = 1_700_000_000_000;
    const recording = [{ events: [
      { type: 4, data: { href: 'https://app.example.com/x', width: 1440, height: 900 }, timestamp: start },
      { type: 2, timestamp: start + 10, data: { node: { id: 1, type: 0, childNodes: [
        { id: 2, type: 2, tagName: 'html', attributes: {}, childNodes: [
          { id: 3, type: 2, tagName: 'body', attributes: {}, childNodes: [
            { id: 4, type: 2, tagName: 'p', attributes: {}, childNodes: [{ id: 5, type: 3, textContent: 'Early text' }] },
          ] },
        ] },
      ] } } },
      { type: 3, timestamp: start + 3_000, data: { source: 0, texts: [], attributes: [], removes: [], adds: [
        { parentId: 3, nextId: null, node: { id: 6, type: 2, tagName: 'h1', attributes: {}, childNodes: [] } },
        { parentId: 6, nextId: null, node: { id: 7, type: 3, textContent: 'Late text from the last batch' } },
      ] } },
    ], meta: { chunked_at: start, has_full_snapshot: true, sdk_version: 'test' } }] as never;
    const whole = await captureFrames(recording, [100, 5_000], { replayBatchMaxChars: 10_000_000 });
    const split = await captureFrames(recording, [100, 5_000], { replayBatchMaxChars: 1 });
    // Frames: [100a, 100b, 5000a, 5000b]; the late mutation lands between them.
    expect(whole.frames[2]!.png.equals(whole.frames[0]!.png)).toBe(false);
    expect(split.frames[2]!.png.equals(whole.frames[2]!.png)).toBe(true);
  }, 90_000);

});
