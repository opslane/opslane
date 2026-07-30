// @vitest-environment node
/**
 * Friction smoke: real rage-clicks in Chromium produce rrweb telemetry inside
 * replay chunks; the real scrubber and analyzer turn them into a rage_click
 * friction signal.
 *
 * Batch 3 does not auto-create session_analysis jobs, so this test inserts the
 * job directly. Remove that bridge when product scheduling lands.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  cleanupTenant,
  closePool,
  getActiveFrictionSignals,
  getConfig,
  insertSessionAnalysisJob,
  makeChunksScrubbable,
  pollScrubbedChunk,
  pollSessionForProject,
  pollSessionStatus,
  seedTenant,
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

describe.skipIf(hasLLMKey || !keylessWorkerRunning || !playwrightAvailable)(
  'browser smoke: rage click to friction signal',
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

    it('rage clicks on a dead button become a rage_click friction signal', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(fixture.url);

        await page.waitForFunction(
          () => (window as unknown as { __opslaneReplayReady?: boolean })
            .__opslaneReplayReady === true,
          undefined,
          { timeout: 30_000 }
        );

        await page.click('[data-testid="nav-dead"]');
        await page.waitForTimeout(500);

        for (let click = 0; click < 5; click++) {
          await page.click('[data-testid="dead-button"]');
          await page.waitForTimeout(100);
        }

        // The last click must remain unanswered for the analyzer's full window.
        await page.waitForTimeout(1_500);

        // An accepted error immediately flushes the current replay chunk.
        await page.click('[data-testid="nav-usercard"]');
        await page.click('[data-testid="edit-profile-btn"]');

        const sessionId = await pollSessionForProject(tenant.projectId);
        await makeChunksScrubbable(sessionId);
        await pollScrubbedChunk(sessionId, 120_000);

        await insertSessionAnalysisJob(tenant.projectId, sessionId);
        // Poll for 'analyzed' only: on transient faults the worker writes
        // 'analysis_failed' and rethrows, so the job retries and may still
        // succeed. A genuine failure surfaces as a poll timeout that names
        // the stuck status.
        const status = await pollSessionStatus(sessionId, ['analyzed'], 90_000);
        expect(status).toBe('analyzed');

        const signals = await getActiveFrictionSignals(sessionId);
        const rageClick = signals.find((signal) => signal.signal_type === 'rage_click');
        expect(rageClick).toBeDefined();
        expect(rageClick!.element_selector).toBe('[data-testid="dead-button"]');
      } finally {
        await page.close();
      }
    }, 300_000);
  }
);
