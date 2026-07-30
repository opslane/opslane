// @vitest-environment node
/**
 * The /events exemption for header-less callers is only safe because a real
 * browser always attaches Origin to a POST. Every other test in this repo
 * uses Node fetch, which proves nothing about that. This drives real Chromium
 * from a local page origin and asserts the allowlist still gates it.
 *
 * Required:
 *   DATABASE_URL   — Postgres connection string
 *   INGESTION_URL  — Base URL for ingestion API (default: http://localhost:8082)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import {
  seedTenant, cleanupTenant, closePool, getPool, getConfig,
  type TestTenant,
} from './helpers.js';
import { isPlaywrightAvailable } from './browser-helpers.js';

const playwrightAvailable = await isPlaywrightAvailable();

const PAGE_BODY = '<!doctype html><meta charset="utf-8"><title>origin probe</title>';

/**
 * Serves a blank page so Chromium has a real HTTP origin to fetch from.
 *
 * `Referrer-Policy: no-referrer` is what makes these tests mean anything. The
 * middleware treats Referer as browser context too, and an http->http
 * cross-origin fetch sends BOTH headers by default — so without this, the
 * assertions below would pass on Referer alone and would keep passing even if
 * Chromium stopped sending Origin, which is the one assumption the /events
 * exemption rests on. Suppressing Referer leaves Origin as the only signal.
 */
async function startPageServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createHttpServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.end(PAGE_BODY);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing page server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

describe.skipIf(!playwrightAvailable)('real Chromium always sends Origin to /events', () => {
  let tenant: TestTenant;
  let page: { url: string; close(): Promise<void> };
  let browser: import('@playwright/test').Browser;

  /** Each test sets the allowlist it needs, so neither depends on run order. */
  async function setAllowlist(origins: string[]): Promise<void> {
    await getPool().query(
      `UPDATE projects SET allowed_origins = $2 WHERE id = $1`,
      [tenant.projectId, origins],
    );
  }

  beforeAll(async () => {
    tenant = await seedTenant('e2e/origin-allowlist-browser');
    page = await startPageServer();
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await page?.close();
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  /** Posts an /events payload from inside the page and returns the HTTP status. */
  async function postFromPage(message: string): Promise<number> {
    const tab = await browser.newPage();
    try {
      await tab.goto(page.url);
      return await tab.evaluate(
        async ([ingestionUrl, apiKey, text]) => {
          const response = await fetch(`${ingestionUrl}/api/v1/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            body: JSON.stringify({
              timestamp: new Date().toISOString(),
              platform: 'browser',
              error: {
                type: 'TypeError',
                message: text,
                stack: `TypeError: ${text}\n    at probe (http://127.0.0.1/probe.js:1:1)`,
              },
              breadcrumbs: [],
              context: {},
            }),
          });
          return response.status;
        },
        [getConfig().ingestionUrl, tenant.ingestKey, message] as const,
      );
    } finally {
      await tab.close();
    }
  }

  it('rejects a page whose origin is not on the allowlist', async () => {
    // An allowlist that deliberately excludes the page origin. A browser that
    // sent no Origin would be treated as a server SDK and admitted, so a 202
    // here would mean Chromium omitted Origin and took the exempt path.
    await setAllowlist(['https://app.allowlisted.example']);
    expect(await postFromPage('browser origin blocked')).toBe(403);
  }, 60_000);

  it('accepts the same page once its origin is allowlisted', async () => {
    await setAllowlist(['https://app.allowlisted.example', page.url]);
    expect(await postFromPage('browser origin allowed')).toBe(202);
  }, 60_000);
});
