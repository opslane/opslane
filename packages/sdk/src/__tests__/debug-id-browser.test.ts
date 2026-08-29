// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
  type Page,
} from '@playwright/test';
import vue from '@vitejs/plugin-vue';
import { build, preview, type PreviewServer } from 'vite';
import { opslaneVitePlugin } from '../../vite-plugin/index.js';

const fixtureRoot = resolve(__dirname, '../../../../test-fixtures/vue-app');
const buildRoot = mkdtempSync(join(tmpdir(), 'opslane-debug-browser-'));
const outDir = join(buildRoot, 'dist');

let ingestServer: http.Server;
let pageServer: http.Server;
let previewServer: PreviewServer;
let ingestOrigin: string;
let assetOrigin: string;
let pageOrigin: string;
let receivedEvents: Array<Record<string, unknown>> = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => {
      resolvePort((server.address() as { port: number }).port);
    });
  });
}

function close(server: http.Server | undefined): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server) return resolveClose();
    server.close(() => resolveClose());
  });
}

// Match the event to the interaction that produced it. Clearing the buffer is
// not enough on its own: an event the previous case triggered can still be in
// flight, land in the freshly cleared buffer, and be read as this case's
// result. That misread is silent, because a stale event is a perfectly valid
// event — it just answers the wrong question, and the frames it carries belong
// to the wrong error.
async function waitForEvent(
  page: Page,
  message: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const match = receivedEvents.find(
      (event) =>
        (event.error as { message?: string } | undefined)?.message === message,
    );
    if (match) return match;
    await page.waitForTimeout(100);
  }
  throw new Error(
    `timed out waiting for an ingested browser event with message ${JSON.stringify(message)}; ` +
      `saw ${JSON.stringify(receivedEvents.map((event) => (event.error as { message?: string } | undefined)?.message))}`,
  );
}

function images(event: Record<string, unknown>): Array<Record<string, string>> {
  return (
    (event.debug_meta as { images?: Array<Record<string, string>> } | undefined)
      ?.images ?? []
  );
}

async function exercise(
  page: Page,
  origin: string,
  selector: string,
  message: string,
): Promise<{ event: Record<string, unknown>; originalStack: string }> {
  receivedEvents = [];
  await page.goto(origin);
  await page.click(selector);
  const event = await waitForEvent(page, message);
  const originalStack = await page.evaluate(
    () =>
      (
        window as Window & {
          __opslaneLastCapturedStack?: string;
        }
      ).__opslaneLastCapturedStack ?? '',
  );
  return { event, originalStack };
}

describe('production debug-ID browser matrix', () => {
  beforeAll(async () => {
    ingestServer = http.createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-API-Key',
      );
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (request.url === '/api/v1/events') {
          receivedEvents.push(JSON.parse(body) as Record<string, unknown>);
        }
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end('{"status":"accepted"}');
      });
    });
    ingestOrigin = `http://127.0.0.1:${await listen(ingestServer)}`;

    const injectTestConfig = {
      name: 'opslane-debug-id-browser-config',
      transform(code: string, id: string) {
        if (!id.endsWith('/src/main.ts')) return;
        return code.replace(
          /init\(\{[\s\S]*?\}\);/,
          `init({
            endpoint: '${ingestOrigin}',
            apiKey: 'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
            flushInterval: 50,
            maxBatchSize: 1,
            replay: { enabled: false },
          });`,
        );
      },
    };
    await build({
      root: fixtureRoot,
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: {
          '@opslane/sdk': resolve(__dirname, '../index.ts'),
        },
      },
      define: {
        'import.meta.env.VITE_OPSLANE_ENDPOINT': JSON.stringify(ingestOrigin),
      },
      plugins: [
        vue(),
        injectTestConfig,
        opslaneVitePlugin({ logLevel: 'silent' }),
      ],
      worker: {
        format: 'es',
        plugins: () => [
          opslaneVitePlugin({ logLevel: 'silent' }),
        ],
      },
      build: {
        outDir,
        emptyOutDir: true,
      },
    });

    previewServer = await preview({
      root: fixtureRoot,
      configFile: false,
      logLevel: 'silent',
      build: { outDir },
      preview: {
        host: '127.0.0.1',
        port: 0,
        headers: { 'Access-Control-Allow-Origin': '*' },
      },
    });
    const previewAddress = previewServer.httpServer.address() as {
      port: number;
    };
    assetOrigin = `http://127.0.0.1:${previewAddress.port}`;

    const html = readFileSync(join(outDir, 'index.html'), 'utf8').replaceAll(
      '"/assets/',
      `"${assetOrigin}/assets/`,
    );
    pageServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(html);
    });
    pageOrigin = `http://127.0.0.1:${await listen(pageServer)}`;
  }, 60_000);

  afterAll(async () => {
    previewServer?.httpServer.close();
    await close(pageServer);
    await close(ingestServer);
    rmSync(buildRoot, { recursive: true, force: true });
  });

  it(
    'matches eager, lazy, worker, CDN, third-party, and unsupported frames in all engines',
    async () => {
      const engines: Array<[string, BrowserType]> = [
        ['chromium', chromium],
        ['firefox', firefox],
        ['webkit', webkit],
      ];
      const completed = new Set<string>();

      for (const [name, engine] of engines) {
        const browser = await engine.launch();
        const page = await browser.newPage();
        try {
          const eager = await exercise(
            page,
            assetOrigin,
            '[data-testid="debug-id-eager"]',
            'debug-id eager chunk',
          );
          expect(images(eager.event)).toHaveLength(1);
          expect(
            (eager.event.error as Record<string, unknown>).stack,
          ).toBe(eager.originalStack);
          expect(eager.originalStack).toContain(
            images(eager.event)[0].code_file,
          );

          const lazy = await exercise(
            page,
            assetOrigin,
            '[data-testid="debug-id-lazy"]',
            'debug-id lazy module init',
          );
          expect(images(lazy.event)).toHaveLength(1);
          expect(
            (lazy.event.error as Record<string, unknown>).stack,
          ).toBe(lazy.originalStack);

          const worker = await exercise(
            page,
            assetOrigin,
            '[data-testid="debug-id-worker-capture"]',
            'debug-id worker capture',
          );
          expect(images(worker.event)).toHaveLength(1);
          expect(
            (worker.event.error as Record<string, unknown>).stack,
          ).toBe(worker.originalStack);

          const forwarded = await exercise(
            page,
            assetOrigin,
            '[data-testid="debug-id-worker-forward"]',
            'debug-id worker forwarded',
          );
          expect(images(forwarded.event)).toEqual([]);

          const cdn = await exercise(
            page,
            pageOrigin,
            '[data-testid="debug-id-eager"]',
            'debug-id eager chunk',
          );
          expect(images(cdn.event)).toHaveLength(1);
          expect(images(cdn.event)[0].code_file).toContain(assetOrigin);

          const thirdParty = await exercise(
            page,
            assetOrigin,
            '[data-testid="debug-id-third-party"]',
            'debug-id third party',
          );
          expect(images(thirdParty.event)).toEqual([]);

          const unparseable = await exercise(
            page,
            assetOrigin,
            '[data-testid="debug-id-unparseable"]',
            'debug-id unparseable',
          );
          expect(images(unparseable.event)).toEqual([]);
          completed.add(name);
        } finally {
          await page.close();
          await browser.close();
        }
      }

      expect(completed).toEqual(new Set(['chromium', 'firefox', 'webkit']));
    },
    120_000,
  );
});
