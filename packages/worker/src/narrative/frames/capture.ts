import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { chromium, type Browser, type Page } from 'playwright-core';
import { logger } from '../../logger.js';

/**
 * The box the model's copy of a frame is fitted into. Half the default replay
 * viewport, which is where the token saving comes from. Tests import this
 * rather than repeating the numbers.
 */
export const MODEL_FRAME_BOX = { width: 720, height: 450 } as const;

/**
 * The viewport the replay is RENDERED at. Deliberately not the model box: a
 * 720px-wide viewport trips responsive breakpoints, so the frames would show a
 * layout the user never saw, in a tool whose job is judging what they saw. The
 * token saving comes from downscaling the captured pixels instead, which costs
 * the same tokens and keeps the layout honest.
 */
export const DEFAULT_CAPTURE_VIEWPORT = { width: 1_440, height: 900 } as const;

export interface CapturedFrame {
  offsetMs: number;
  pair: 'a' | 'b';
  png: Buffer;
  /** Smaller model input; retain the original PNG as reviewable evidence. */
  modelPng: Buffer;
}

const require = createRequire(import.meta.url);

/**
 * Shrink one captured frame to the model's box. Falls back to the full-size
 * screenshot rather than failing the whole session: a frame that costs more
 * tokens is worth far more than a session that loses its verification.
 */
async function modelCopyOf(page: Page, png: Buffer): Promise<Buffer> {
  let encoded: string;
  try {
    // Resize the captured pixels, never the replay viewport: changing the
    // viewport can reflow the page and change the evidence being judged.
    encoded = await page.evaluate(async ({ base64, box }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      try {
        const scale = Math.min(1, box.width / bitmap.width, box.height / bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('frame resize canvas unavailable');
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png').split(',')[1] ?? '';
      } finally {
        bitmap.close();
      }
    }, { base64: png.toString('base64'), box: MODEL_FRAME_BOX });
  } catch (error: unknown) {
    logger.warn('Frame resize failed; sending the full-size frame', {
      error: error instanceof Error ? error.message : String(error),
    });
    return png;
  }
  // The string crosses back out of a page that renders customer DOM, and
  // Node's base64 decoder drops invalid characters instead of throwing, so a
  // truncated or substituted return would otherwise reach the model as a
  // plausible-looking corrupt PNG on a billed call.
  const resized = Buffer.from(encoded, 'base64');
  if (!isPngWithin(resized, MODEL_FRAME_BOX)) {
    logger.warn('Frame resize returned an unusable image; sending the full-size frame', {
      bytes: resized.length,
    });
    return png;
  }
  return resized;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A real PNG whose IHDR dimensions fit the box we asked for. */
function isPngWithin(candidate: Buffer, box: { width: number; height: number }): boolean {
  if (candidate.length < 24 || !candidate.subarray(0, 8).equals(PNG_MAGIC)) return false;
  const width = candidate.readUInt32BE(16);
  const height = candidate.readUInt32BE(20);
  return width > 0 && height > 0 && width <= box.width && height <= box.height;
}

export async function captureFrames(
  envelopes: SessionChunkEnvelope[],
  offsetsMs: number[],
  opts: {
    viewport?: { width: number; height: number };
    wallClockBudgetMs?: number;
  } = {},
): Promise<{ frames: CapturedFrame[]; assetsMissing: boolean }> {
  const viewport = opts.viewport ?? { ...DEFAULT_CAPTURE_VIEWPORT };
  const deadline = Date.now() + (opts.wallClockBudgetMs ?? 120_000);
  const offsets = offsetsMs.slice(0, 3);
  const harness = readFileSync(new URL('./harness.html', import.meta.url), 'utf8');
  const rrwebEntry = require.resolve('rrweb');
  const rrwebBundle = readFileSync(join(dirname(rrwebEntry), 'rrweb.umd.min.cjs'), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/rrweb.umd.min.cjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(rrwebBundle);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(harness);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback server failed to bind');
  const origin = `http://127.0.0.1:${address.port}`;

  let browser: Browser | null = null;
  let assetsMissing = false;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport });
    await page.route('**/*', async (route) => {
      let requestOrigin = '';
      try {
        requestOrigin = new URL(route.request().url()).origin;
      } catch {
        // Invalid URLs are treated as external and aborted.
      }
      if (requestOrigin === origin) {
        await route.continue();
        return;
      }
      const resourceType = route.request().resourceType();
      if (['stylesheet', 'font', 'image'].includes(resourceType)) assetsMissing = true;
      await route.abort();
    });
    await page.goto(`${origin}/`);
    const events = envelopes.flatMap((envelope) => envelope.events);
    await page.evaluate((replayEvents) => {
      return (window as unknown as { initReplayer(events: unknown[]): boolean })
        .initReplayer(replayEvents);
    }, events);
    await page.waitForTimeout(1_500);

    const frames: CapturedFrame[] = [];
    for (const offsetMs of offsets) {
      for (const [pair, additionalMs] of [['a', 0], ['b', 2_000]] as const) {
        if (Date.now() > deadline) throw new Error('frame capture wall-clock budget exceeded');
        await page.evaluate((seekMs) => {
          return (window as unknown as { seekTo(ms: number): boolean }).seekTo(seekMs);
        }, offsetMs + additionalMs);
        await page.waitForTimeout(1_200);
        const png = await page.screenshot();
        frames.push({ offsetMs, pair, png, modelPng: await modelCopyOf(page, png) });
      }
    }
    return { frames, assetsMissing };
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
