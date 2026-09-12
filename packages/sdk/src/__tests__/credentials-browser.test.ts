// @vitest-environment node
import { expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { TEST_PK } from './test-keys';

it('never sends an HttpOnly application cookie through a same-origin proxy', async () => {
  const requests: Array<{ url: string; cookie?: string; authorization?: string }> = [];
  const server = await createServer({
    root: resolve(__dirname, '../..'), configFile: false,
    server: { port: 0, watch: null },
    plugins: [{
      name: 'credentials-contract',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/opslane/api/v1/')) {
            requests.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
            req.resume();
            res.setHeader('Content-Type', 'application/json');
            res.end('{"recording":true}');
          } else if (req.url === '/credentials-contract') {
            res.setHeader('Set-Cookie', 'app_session=secret; HttpOnly; Path=/; SameSite=Lax');
            res.setHeader('Content-Type', 'text/html');
            res.end(`<script type="module">
              import { loadConfig } from '/src/config.ts';
              import { enqueueEvent, flushEvents, flushOnUnload } from '/src/transport.ts';
              import { registerSession } from '/src/replay.ts';
              import { uploadChunk, flushInline } from '/src/chunk-upload.ts';
              loadConfig({ apiKey: '${TEST_PK}', endpoint: '/opslane', errorThrottleMs: 0 });
              const event = { timestamp: new Date().toISOString(), error: { type: 'Error', message: 'cookies', stack: '' }, breadcrumbs: [], context: { url: location.href, user_agent: navigator.userAgent }, sdk_version: 'test' };
              enqueueEvent(event); await flushEvents();
              enqueueEvent(event); flushOnUnload();
              await registerSession('cookie-test');
              const events = [{ type: 4, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } }];
              await uploadChunk('cookie-test', 0, events, true);
              await flushInline('cookie-test', 1, events);
              window.done = true;
            </script>`);
          } else next();
        });
      },
    }],
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    await page.goto(`http://localhost:${address.port}/credentials-contract`);
    await page.waitForFunction(() => (window as unknown as { done?: boolean }).done);
    expect((await page.context().cookies()).find(cookie => cookie.name === 'app_session')?.httpOnly).toBe(true);
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.cookie).toBeUndefined();
      expect(request.authorization).toBeUndefined();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}, 30_000);
