// @vitest-environment node
/**
 * Browser smoke: a real Chromium drives the fixture apps with the real SDK
 * pointed at the real keyless stack. This covers real browser payload capture,
 * ingestion grouping, and the worker's deterministic terminal state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
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

    // Capture boundary (Slice 2): ingest stores observations without creating
    // incidents or investigations; this flow returns when settlement (Slice 4)
    // hands accepted work to the investigator (Slice 9).
    it.skip('real Vue SDK error reaches needs_human with missing_llm_key [suspended until Slice 9]', async () => {
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

    // Capture boundary (Slice 2): see the Vue smoke above.
    it.skip('React error-boundary error reaches needs_human with missing_llm_key [suspended until Slice 9]', async () => {
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
