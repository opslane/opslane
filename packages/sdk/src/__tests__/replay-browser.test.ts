// @vitest-environment node
//
// Real-browser chunked session capture contract.
// Drives a real Chromium (Playwright) running the Vue fixture with the LOCAL SDK
// (rrweb capture), triggers an early error, and captures the normal gzipped chunk
// uploaded immediately for that error. The current SDK must not call /replays/*.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { TEST_PK } from './test-keys';

let playwrightAvailable = false;
try {
  const pw = await import('@playwright/test');
  if (pw.chromium) playwrightAvailable = true;
} catch {
  playwrightAvailable = false;
}

interface BrowserPage {
  goto(url: string): Promise<unknown>;
  click(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  close(): Promise<unknown>;
}
interface BrowserInstance { newPage(): Promise<BrowserPage>; close(): Promise<unknown>; }
interface ViteDevServer { listen(): Promise<unknown>; close(): Promise<unknown>; config: { server: { port: number } }; }

let mockServer: http.Server;
let mockPort: number;
let capturedChunk: { events: unknown[]; meta: Record<string, unknown> } | null;
let capturedChunkQuery: string;
let capturedChunkHeaders: http.IncomingHttpHeaders;
let chunkUploadCount: number;
let sessionInitBody: Record<string, unknown> | null;
let legacyReplayRequestCount: number;
let viteServer: ViteDevServer;
let vitePort: number;
let browser: BrowserInstance;
let page: BrowserPage;

const FIXTURE_APP_DIR = resolve(__dirname, '../../../../test-fixtures/vue-app');

describe.skipIf(!playwrightAvailable)('rrweb replay capture (real browser)', () => {
  beforeAll(async () => {
    capturedChunk = null;
    capturedChunkQuery = '';
    capturedChunkHeaders = {};
    chunkUploadCount = 0;
    sessionInitBody = null;
    legacyReplayRequestCount = 0;

    mockServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

      const bodyParts: Buffer[] = [];
      req.on('data', (part: Buffer) => { bodyParts.push(part); });
      req.on('end', () => {
        const url = req.url ?? '';
        const rawBody = Buffer.concat(bodyParts);
        const body = rawBody.toString('utf8');
        if (url === '/api/v1/events') {
          res.writeHead(202, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ event_id: 'evt_test', group_id: 'grp_test', error_group_id: 'grp_test' }));
          return;
        }
        if (url === '/api/v1/sessions/init') {
          try { sessionInitBody = JSON.parse(body); } catch { sessionInitBody = null; }
          res.writeHead(200, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ recording: true, chunk_interval_ms: 30000, max_chunk_bytes: 5242880 }));
          return;
        }
        // Single-call chunk upload (#194). The body is the gzip: no multipart
        // and no presigned form. Requiring a second request here would recreate
        // the browser-to-R2 bug.
        const path = url.split('?')[0] ?? '';
        const chunkMatch = /^\/api\/v1\/sessions\/([^/]+)\/chunks\/(\d+)$/.exec(path);
        if (chunkMatch && req.method === 'POST') {
          chunkUploadCount += 1;
          capturedChunkQuery = url.includes('?') ? url.slice(url.indexOf('?')) : '';
          capturedChunkHeaders = req.headers;
          try {
            capturedChunk = JSON.parse(gunzipSync(rawBody).toString('utf8')) as typeof capturedChunk;
          } catch {
            capturedChunk = null;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ status: 'committed' }));
          return;
        }
        if (url.startsWith('/api/v1/replays')) legacyReplayRequestCount += 1;
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>(r => mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port; r();
    }));

    const { createServer } = await import('vite');
    const vue = (await import('@vitejs/plugin-vue')).default;
    const vs = await createServer({
      root: FIXTURE_APP_DIR,
      configFile: false,
      resolve: { alias: { '@opslane/sdk': resolve(__dirname, '../index.ts') } },
      server: { port: 0 },
      plugins: [
        vue(),
        {
          name: 'inject-sdk-init',
          transform(code: string, id: string) {
            if (id.endsWith('/main.ts')) {
              return code.replace(/init\(\{[\s\S]*?\}\);/, `init({
                endpoint: 'http://localhost:${mockPort}',
                apiKey: '${TEST_PK}',
                flushInterval: 200,
                maxBatchSize: 1,
                replay: { enabled: true },
              });`);
            }
          },
        },
      ],
    });
    await vs.listen();
    viteServer = vs as unknown as ViteDevServer;
    vitePort = viteServer.config.server.port!;

    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch() as unknown as BrowserInstance;
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await viteServer?.close();
    await new Promise<void>(r => mockServer?.close(() => r()));
  });

  it('flushes a self-contained chunk for an early error in one request', async () => {
    await page.goto(`http://localhost:${vitePort}`);
    // Generate some DOM activity (rrweb incremental events) then trigger the bug.
    await page.click('[data-testid="nav-usercard"]');
    await page.click('[data-testid="edit-profile-btn"]');
    // Wait for the event flush and direct gzip chunk upload.
    await page.waitForTimeout(2500);

    expect(sessionInitBody?.session_id).toEqual(expect.any(String));
    expect(capturedChunk, 'an error-flushed chunk was uploaded through the session protocol').toBeTruthy();
    const chunk = capturedChunk!;
    expect(Array.isArray(chunk.events)).toBe(true);
    expect(chunk.events.length).toBeGreaterThan(1);
    expect(typeof chunk.meta.sdk_version).toBe('string');
    expect(chunk.meta.has_full_snapshot).toBe(true);
    expect(typeof chunk.meta.chunked_at).toBe('number');

    // Each chunk is independently playable: viewport Meta then FullSnapshot.
    const types = (chunk.events as Array<{ type: number; timestamp: number }>).map((event) => event.type);
    expect(types.slice(0, 2)).toEqual([4, 2]);
    const ts = (chunk.events as Array<{ timestamp: number }>).map((event) => event.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(capturedChunkQuery).toBe('?has_full_snapshot=1');
    expect(capturedChunkHeaders['content-type']).toBe('application/gzip');
    expect(capturedChunkHeaders['x-api-key']).toBe(TEST_PK);
    expect(chunkUploadCount).toBe(1);
    expect(legacyReplayRequestCount).toBe(0);
  }, 20_000);
});
