// @vitest-environment node
/**
 * Browser smoke: a real Chromium drives the fixture apps with the real SDK
 * pointed at the real keyless stack. This covers real browser payload capture,
 * ingestion grouping, and the worker's deterministic terminal state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyPatches } from '../cli/src/init.js';
import { getSnippet } from '../cli/src/snippet.js';
import type { FilePatch } from '../cli/src/codemods/types.js';
import {
  cleanupTenant,
  closePool,
  getConfig,
  listIncidents,
  pollUntilTerminal,
  seedTenant,
  type Incident,
  type TestTenant,
} from './helpers.js';
import {
  isPlaywrightAvailable,
  startFixture,
  type FixtureServer,
} from './browser-helpers.js';

const hasLLMKey = !!process.env['ANTHROPIC_API_KEY'];
const keylessWorkerRunning = process.env['E2E_WORKER_NO_KEY'] === '1';
const playwrightAvailable = await isPlaywrightAvailable();

const VUE_FIXTURE = resolve(__dirname, '../test-fixtures/vue-app');
const REACT_FIXTURE = resolve(__dirname, '../test-fixtures/react-app');
const CODEMOD_REACT_FIXTURE = resolve(__dirname, '../test-fixtures/codemod-react');
const SDK_SOURCE = resolve(__dirname, '../packages/sdk/src/index.ts');
const CODEMOD_TEST_API_KEY =
  'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

async function pollIncidentMatching(
  tenant: TestTenant,
  predicate: (incident: Incident) => boolean,
  timeoutMs = 60_000
): Promise<Incident> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const incidents = await listIncidents(tenant.userSession, tenant.projectId);
    const hit = incidents.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`No matching incident within ${timeoutMs}ms`);
}

describe.skipIf(hasLLMKey || !keylessWorkerRunning || !playwrightAvailable)(
  'browser smoke: Vue error to needs_human',
  () => {
    let tenant: TestTenant;
    let fixture: FixtureServer;
    let browser: import('@playwright/test').Browser;

    beforeAll(async () => {
      tenant = await seedTenant();
      const vue = (await import('@vitejs/plugin-vue')).default;
      fixture = await startFixture({
        fixtureDir: VUE_FIXTURE,
        apiKey: tenant.ingestKey,
        ingestionUrl: getConfig().ingestionUrl,
        entryPattern: /\/main\.ts$/,
        plugins: [vue()],
      });
      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch();
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      await fixture?.close();
      if (tenant) await cleanupTenant(tenant.orgId);
      await closePool();
    });

    it('real Vue SDK error reaches needs_human with missing_llm_key', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(fixture.url);
        await page.click('[data-testid="nav-usercard"]');
        await page.click('[data-testid="edit-profile-btn"]');

        const incident = await pollIncidentMatching(
          tenant,
          (candidate) => candidate.title.toLowerCase().includes('null')
        );
        expect(incident.status).toBeTruthy();

        const terminal = await pollUntilTerminal(
          tenant.userSession,
          tenant.projectId,
          incident.id,
          ['needs_human'],
          90_000
        );
        expect(terminal.status).toBe('needs_human');
        expect(terminal.reason?.reason_code).toBe('missing_llm_key');
        expect(terminal.reason?.reason_message).toBeTruthy();
        expect(terminal.reason?.remediation).toBeTruthy();
      } finally {
        await page.close();
      }
    }, 180_000);
  }
);

describe.skipIf(!playwrightAvailable)('browser smoke: patched codemod delivers an event', () => {
  it('applies the React codemod and posts a browser error to the configured endpoint', async () => {
    let receivedBody = '';
    let resolveEvent: (() => void) | undefined;
    const eventReceived = new Promise<void>((resolveEventPromise) => { resolveEvent = resolveEventPromise; });
    const ingestion = createHttpServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (request.url === '/api/v1/events') {
          receivedBody = Buffer.concat(chunks).toString('utf8');
          resolveEvent?.();
          response.statusCode = 202;
          response.end(JSON.stringify({ status: 'accepted' }));
          return;
        }
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'replay disabled in codemod smoke' }));
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      ingestion.once('error', reject);
      ingestion.listen(0, '127.0.0.1', resolveListen);
    });
    const address = ingestion.address();
    if (!address || typeof address === 'string') throw new Error('missing ingestion address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const fixtureCopy = await mkdtemp(join(tmpdir(), 'opslane-codemod-browser-'));
    const cacheDir = await mkdtemp(join(tmpdir(), 'opslane-codemod-vite-'));
    await cp(CODEMOD_REACT_FIXTURE, fixtureCopy, { recursive: true });

    const snippet = await getSnippet({
      cwd: fixtureCopy,
      framework: 'react-vite',
      apiKey: CODEMOD_TEST_API_KEY,
      apiUrl: endpoint,
    });
    const patches: FilePatch[] = snippet.patches.map((patch) => ({
      filePath: patch.file_path,
      action: patch.action as FilePatch['action'],
      content: patch.content,
      insertAfter: patch.insert_after,
      insertContent: patch.insert_content,
    }));
    await applyPatches(fixtureCopy, patches);
    await writeFile(join(fixtureCopy, '.env.local'), `${snippet.env.var}=${snippet.env.value}\n`);

    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    const vite = await createServer({
      root: fixtureCopy,
      configFile: false,
      cacheDir,
      logLevel: 'error',
      plugins: [react()],
      resolve: {
        alias: [
          { find: '@opslane/sdk', replacement: SDK_SOURCE },
          { find: 'react-dom', replacement: resolve(REACT_FIXTURE, 'node_modules/react-dom') },
          { find: 'react', replacement: resolve(REACT_FIXTURE, 'node_modules/react') },
        ],
      },
      server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
    });
    await vite.listen();
    const viteAddress = vite.httpServer?.address();
    if (!viteAddress || typeof viteAddress === 'string') throw new Error('missing Vite address');
    const port = viteAddress.port;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5_000);
      await page.goto(`http://127.0.0.1:${port}`);
      await page.click('#trigger-error');
      await Promise.race([
        eventReceived,
        new Promise((_, reject) => setTimeout(() => reject(new Error('event was not captured')), 15_000)),
      ]);
      expect(receivedBody).toContain('codemod browser event');
      await page.close();
    } finally {
      await browser.close();
      await vite.close();
      await new Promise<void>((resolveClose, reject) => ingestion.close((error) => error ? reject(error) : resolveClose()));
      await rm(fixtureCopy, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(hasLLMKey || !keylessWorkerRunning || !playwrightAvailable)(
  'browser smoke: React error to needs_human',
  () => {
    let tenant: TestTenant;
    let fixture: FixtureServer;
    let browser: import('@playwright/test').Browser;

    beforeAll(async () => {
      tenant = await seedTenant();
      const react = (await import('@vitejs/plugin-react')).default;
      fixture = await startFixture({
        fixtureDir: REACT_FIXTURE,
        apiKey: tenant.ingestKey,
        ingestionUrl: getConfig().ingestionUrl,
        entryPattern: /\/main\.tsx$/,
        plugins: [react()],
      });
      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch();
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      await fixture?.close();
      if (tenant) await cleanupTenant(tenant.orgId);
      await closePool();
    });

    it('React error-boundary error reaches needs_human with missing_llm_key', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(fixture.url);
        await page.click('[data-testid="nav-profile"]');
        await page.click('[data-testid="load-profile-btn"]');
        await page.waitForSelector('[data-testid="boundary-fallback"]');

        const incident = await pollIncidentMatching(
          tenant,
          (candidate) => {
            const title = candidate.title.toLowerCase();
            return title.includes('displayname') || title.includes('null');
          }
        );
        const terminal = await pollUntilTerminal(
          tenant.userSession,
          tenant.projectId,
          incident.id,
          ['needs_human'],
          90_000
        );
        expect(terminal.status).toBe('needs_human');
        expect(terminal.reason?.reason_code).toBe('missing_llm_key');
      } finally {
        await page.close();
      }
    }, 180_000);
  }
);
