import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { chromium, type Browser } from 'playwright-core';

export interface CapturedFrame {
  offsetMs: number;
  pair: 'a' | 'b';
  png: Buffer;
}

const require = createRequire(import.meta.url);

export async function captureFrames(
  envelopes: SessionChunkEnvelope[],
  offsetsMs: number[],
  opts: {
    viewport?: { width: number; height: number };
    wallClockBudgetMs?: number;
  } = {},
): Promise<{ frames: CapturedFrame[]; assetsMissing: boolean }> {
  const viewport = opts.viewport ?? { width: 1_440, height: 900 };
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
        frames.push({ offsetMs, pair, png: await page.screenshot() });
      }
    }
    return { frames, assetsMissing };
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
