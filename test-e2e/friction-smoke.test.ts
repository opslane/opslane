// @vitest-environment node
/**
 * Friction smoke: real rage-clicks in Chromium produce rrweb telemetry inside
 * replay chunks; the real scrubber and analyzer classify the session active
 * and hand it to the narrative stage. Session narratives are the friction
 * detector now, and narration needs a model key, so the keyless lane proves
 * the handoff: a session_narratives reservation exists and a session_narrate
 * job is enqueued. The narrative itself is covered by friction-incidents.
 *
 * Batch 3 does not auto-create session_analysis jobs, so this test inserts the
 * job directly. Remove that bridge when product scheduling lands.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  cleanupTenant,
  closePool,
  getConfig,
  getPool,
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
  'browser smoke: friction session reaches the narrative stage',
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

    it('an active session with rage clicks gets a narrative reservation and a narrate job', async () => {
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

        const narrative = await getPool().query(
          `SELECT status FROM session_narratives WHERE session_id = $1 AND project_id = $2`,
          [sessionId, tenant.projectId],
        );
        expect(narrative.rows[0]).toBeDefined();

        const narrateJob = await getPool().query(
          `SELECT status FROM error_group_jobs
           WHERE project_id = $1 AND session_id = $2 AND job_type = 'session_narrate'`,
          [tenant.projectId, sessionId],
        );
        expect(narrateJob.rows[0]).toBeDefined();
      } finally {
        await page.close();
      }
    }, 300_000);
  }
);
