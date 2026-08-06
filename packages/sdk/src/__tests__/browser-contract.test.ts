// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { resolve } from 'node:path';
import { TEST_PK } from './test-keys';

// Check if Playwright browsers are available
let playwrightAvailable = false;
try {
  const pw = await import('@playwright/test');
  // Try to detect if browsers are actually installed
  if (pw.chromium) {
    playwrightAvailable = true;
  }
} catch {
  playwrightAvailable = false;
}

// Minimal interfaces for dynamically-imported modules (avoids `any`)
interface BrowserPage {
  goto(url: string): Promise<unknown>;
  click(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  close(): Promise<unknown>;
}
interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<unknown>;
}
interface ViteDevServer {
  listen(): Promise<unknown>;
  close(): Promise<unknown>;
  config: { server: { port: number } };
}

let mockServer: http.Server;
let mockPort: number;
let hangServer: http.Server;
let hangPort: number;
let receivedEvents: unknown[];
let viteServer: ViteDevServer;
let vitePort: number;
let browser: BrowserInstance;
let page: BrowserPage;

const FIXTURE_APP_DIR = resolve(__dirname, '../../../../test-fixtures/vue-app');

describe.skipIf(!playwrightAvailable)('SDK browser contract', () => {
  beforeAll(async () => {
    receivedEvents = [];

    // 1. Start mock ingestion server (with CORS for cross-origin browser requests)
    mockServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/api/v1/events') {
          try {
            const parsed = JSON.parse(body);
            if (Array.isArray(parsed)) {
              receivedEvents.push(...parsed);
            } else {
              receivedEvents.push(parsed);
            }
          } catch {
            receivedEvents.push(body);
          }
        }
        res.writeHead(202).end('{"status":"accepted"}');
      });
    });
    await new Promise<void>(r => mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      r();
    }));

    hangServer = http.createServer(() => {
      // Deliberately never respond; AbortSignal.timeout ends the request.
    });
    await new Promise<void>(r => hangServer.listen(0, () => {
      hangPort = (hangServer.address() as { port: number }).port;
      r();
    }));

    // 2. Start Vite dev server for fixture app
    const { createServer } = await import('vite');
    const vue = (await import('@vitejs/plugin-vue')).default;
    const vs = await createServer({
      root: FIXTURE_APP_DIR,
      configFile: false,
      resolve: {
        alias: {
          '@opslane/sdk': resolve(__dirname, '../index.ts'),
        },
      },
      server: { port: 0 },
      define: {
        'import.meta.env.VITE_OPSLANE_HANG_URL': JSON.stringify(`http://localhost:${hangPort}/hang`),
      },
      plugins: [
        vue(),
        {
          name: 'inject-sdk-init',
          transform(code: string, id: string) {
            if (id.endsWith('/main.ts')) {
              // Replace the existing init({...}) block with test-specific config
              return code.replace(
                /init\(\{[\s\S]*?\}\);/,
                `init({
                  endpoint: 'http://localhost:${mockPort}',
                  apiKey: '${TEST_PK}',
                  flushInterval: 200,
                  maxBatchSize: 1,
                  replay: { enabled: false },
                });`
              );
            }
          },
        },
      ],
    });
    await vs.listen();
    viteServer = vs as unknown as ViteDevServer;
    vitePort = viteServer.config.server.port!;

    // 3. Launch browser
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch() as unknown as BrowserInstance;
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await viteServer?.close();
    hangServer?.closeAllConnections();
    await new Promise<void>(r => hangServer?.close(() => r()));
    await new Promise<void>(r => mockServer?.close(() => r()));
  });

  it('captures Vue error in real browser and sends to mock server', async () => {
    receivedEvents = [];

    await page.goto(`http://localhost:${vitePort}`);
    await page.click('[data-testid="nav-usercard"]');
    await page.click('[data-testid="edit-profile-btn"]');

    // Wait for SDK to flush the error event
    await page.waitForTimeout(2000);

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);

    const event = receivedEvents[0] as Record<string, unknown>;
    const error = event.error as Record<string, unknown>;
    expect(error.type).toMatch(/TypeError|Error/);
    expect(error.message).toContain('null');
    expect(error.stack).toBeTruthy();
    expect(event.breadcrumbs).toBeInstanceOf(Array);
  }, 15_000);

  it('captures async lifecycle error', async () => {
    receivedEvents = [];

    await page.goto(`http://localhost:${vitePort}`);
    await page.click('[data-testid="nav-async"]');
    await page.click('[data-testid="start-sync-btn"]');

    await page.waitForTimeout(2000);

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
    const event = receivedEvents[0] as Record<string, unknown>;
    expect((event.error as Record<string, unknown>).message).toContain('Sync failed');
  }, 15_000);

  it('captures a timed-out fetch with its duration in a real browser', async () => {
    receivedEvents = [];

    await page.goto(`http://localhost:${vitePort}`);
    await page.click('[data-testid="nav-fetch"]');
    await page.click('[data-testid="load-slow-btn"]');
    await page.waitForTimeout(4000);

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
    const event = receivedEvents.find(
      (entry) => Array.isArray((entry as Record<string, unknown>).network_timings),
    ) as Record<string, unknown> | undefined;
    expect(event).toBeDefined();

    const timings = event!.network_timings as Array<Record<string, unknown>>;
    const hung = timings.find((timing) => String(timing.url).includes('/hang'));
    expect(hung).toBeDefined();
    expect(hung!.transport).toBe('fetch');
    expect(hung!.outcome).toBe('timeout');
    expect(hung).not.toHaveProperty('ttfb_ms');
    expect(hung!.duration_ms as number).toBeGreaterThanOrEqual(900);
  }, 20_000);
});
