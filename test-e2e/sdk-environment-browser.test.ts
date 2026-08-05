// @vitest-environment node

import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTenant,
  closePool,
  getConfig,
  getPool,
  seedTenant,
  type TestTenant,
} from './helpers.js';
import {
  isPlaywrightAvailable,
  startFixture,
  type FixtureServer,
} from './browser-helpers.js';

const configured = !!process.env['DATABASE_URL'] && !!process.env['INGESTION_URL'];
const playwrightAvailable = await isPlaywrightAvailable();
const VUE_FIXTURE = resolve(__dirname, '../test-fixtures/vue-app');

describe.skipIf(!configured || !playwrightAvailable)('SDK environment browser contract', () => {
  let tenant: TestTenant;
  let stagingEnvironmentId: string;
  let fixture: FixtureServer;
  let browser: import('@playwright/test').Browser;

  beforeAll(async () => {
    tenant = await seedTenant();
    const vue = (await import('@vitejs/plugin-vue')).default;
    fixture = await startFixture({
      fixtureDir: VUE_FIXTURE,
      apiKey: tenant.ingestKey,
      ingestionUrl: getConfig().ingestionUrl,
      environment: 'staging',
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

  it('sends the configured name through real Chromium to session init and error ingestion', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(fixture.url);
      await page.waitForFunction(() => (
        window as Window & { __opslaneReplayReady?: boolean }
      ).__opslaneReplayReady === true);

    const session = await getPool().query<{ environment_id: string; name: string }>(
      `SELECT s.environment_id, e.name FROM sessions s JOIN environments e ON e.id = s.environment_id
       WHERE s.project_id = $1 ORDER BY s.started_at DESC LIMIT 1`,
      [tenant.projectId],
    );
    stagingEnvironmentId = session.rows[0]?.environment_id ?? '';
    expect(session.rows[0]?.name).toBe('staging');
      expect(session.rows[0]?.environment_id).toBe(stagingEnvironmentId);

      await page.click('[data-testid="nav-usercard"]');
      await page.click('[data-testid="edit-profile-btn"]');

      await expect.poll(async () => {
        const event = await getPool().query<{ environment_id: string }>(
          `SELECT environment_id FROM error_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [tenant.projectId],
        );
        return event.rows[0]?.environment_id;
      }, { timeout: 20_000, interval: 250 }).toBe(stagingEnvironmentId);
    } finally {
      await page.close();
    }
  }, 60_000);
});
