// @vitest-environment node

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTenant,
  closePool,
  getConfig,
  getPool,
  initSession,
  postEvent,
  seedEnvironment,
  seedTenant,
  seedUserWithJWT,
  type TestTenant,
} from './helpers.js';
import { isPlaywrightAvailable } from './browser-helpers.js';

const configured = !!process.env['DATABASE_URL'] && !!process.env['INGESTION_URL'];
const playwrightAvailable = await isPlaywrightAvailable();

describe.skipIf(!configured || !playwrightAvailable)('dashboard environment filtering', () => {
  let tenant: TestTenant;
  let stagingEnvironmentId: string;
  let stagingAPIKey: string;
  let jwt: string;
  let browser: import('@playwright/test').Browser;
  let originalRollupStatus: string;

  const sharedTitle = `phase2 shared ${crypto.randomUUID()}`;
  const productionOnlyTitle = `phase2 production ${crypto.randomUUID()}`;
  const stagingOnlyTitle = `phase2 staging ${crypto.randomUUID()}`;
  const productionPage = `https://app.example.test/production-${crypto.randomUUID()}`;
  const stagingPage = `https://app.example.test/staging-${crypto.randomUUID()}`;
  // The session ledger renders the page *path* as text on the row's metadata
  // line, not the full URL as a link: the whole row is a single link to the
  // replay, so a second anchor would give one row two competing destinations.
  // Identify rows by the path the UI actually paints.
  // Mirrors SessionLedgerRow's pagePath: pathname + search, host dropped.
  const pageRowPath = (url: string): string => {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  };
  const productionPagePath = pageRowPath(productionPage);
  const stagingPagePath = pageRowPath(stagingPage);

  async function ingest(
    apiKey: string,
    message: string,
    environment?: string,
  ): Promise<string> {
    const response = await postEvent(apiKey, {
      timestamp: new Date().toISOString(),
      error: {
        type: 'TypeError',
        message,
        stack: `TypeError: ${message}\n    at dashboardPhase2 (src/phase2.ts:1:1)`,
      },
      breadcrumbs: [],
      context: {},
      ...(environment ? { environment } : {}),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { error_group_id: string };
    return body.error_group_id;
  }

  beforeAll(async () => {
    tenant = await seedTenant();
    const db = getPool();
    const staging = await seedEnvironment(tenant.projectId, 'staging');
    stagingEnvironmentId = staging.environmentId;
    stagingAPIKey = staging.apiKey;
    ({ jwt } = await seedUserWithJWT(tenant.orgId));
    const state = await db.query<{ status: string }>(
      `SELECT status FROM rollup_backfill_state WHERE id`,
    );
    originalRollupStatus = state.rows[0]!.status;

    await ingest(tenant.apiKey, sharedTitle);
    await ingest(tenant.apiKey, sharedTitle);
    await ingest(stagingAPIKey, sharedTitle, 'staging');
    await ingest(tenant.apiKey, productionOnlyTitle);
    await ingest(stagingAPIKey, stagingOnlyTitle, 'staging');

    await initSession(
      tenant.apiKey,
      `sess_phase2_prod_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      undefined,
      productionPage,
    );
    await initSession(
      stagingAPIKey,
      `sess_phase2_stage_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      undefined,
      stagingPage,
      'staging',
    );

    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    if (originalRollupStatus) {
      await getPool().query(
        `UPDATE rollup_backfill_state SET status = $1, updated_at = now() WHERE id`,
        [originalRollupStatus],
      );
    }
    await browser?.close();
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('gates readiness and filters incidents, detail chips, and sessions in real Chromium', async () => {
    const { ingestionUrl } = getConfig();
    const db = getPool();
    // Pinned, not left to Playwright's default: the session row only paints the
    // page path at >=1024px (`hidden ... lg:inline`), so the assertions below
    // are width-dependent in a way the old full-URL link assertion was not.
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await context.addCookies([{
      name: '__opslane_at',
      value: jwt,
      url: ingestionUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    await context.addInitScript(({ projectId }) => {
      localStorage.setItem('opslane_authed', '1');
      localStorage.setItem('opslane_project_id', projectId);
      localStorage.setItem('opslane_project_name', 'Phase 2 E2E');
    }, { projectId: tenant.projectId });
    const page = await context.newPage();

    try {
      await db.query(`UPDATE rollup_backfill_state SET status = 'running', updated_at = now() WHERE id`);
      await page.goto(`${ingestionUrl}/`);
      await page.getByRole('heading', { name: 'Issues' }).waitFor();
      expect(await page.getByLabel('Environment').count()).toBe(0);

      await db.query(`UPDATE rollup_backfill_state SET status = 'complete', updated_at = now() WHERE id`);
      await page.reload();
      const incidentEnvironment = page.getByLabel('Environment');
      await incidentEnvironment.waitFor();
      expect(await incidentEnvironment.locator('option').allTextContents()).toEqual([
        'All environments',
        'production',
        'staging',
      ]);

      await Promise.all([
        page.waitForResponse((response) => response.url().includes(`environment_id=${stagingEnvironmentId}`)),
        incidentEnvironment.selectOption(stagingEnvironmentId),
      ]);
      await page.getByText('across all environments').waitFor();
      await page.getByRole('link', { name: sharedTitle }).waitFor();
      await page.getByRole('link', { name: stagingOnlyTitle }).waitFor();
      await expect.poll(
        () => page.getByRole('link', { name: productionOnlyTitle }).count(),
      ).toBe(0);

      await page.getByRole('link', { name: sharedTitle }).click();
      await page.getByText(/^production · 2 ·/).waitFor();
      await page.getByText(/^staging · 1 ·/).waitFor();

      await page.goto(`${ingestionUrl}/sessions`);
      const sessionEnvironment = page.getByLabel('Environment');
      await sessionEnvironment.waitFor();
      await page.getByText(stagingPagePath, { exact: true }).waitFor();
      await expect.poll(
        () => page.getByText(productionPagePath, { exact: true }).count(),
      ).toBe(0);

      await Promise.all([
        page.waitForResponse((response) => response.url().includes(`environment_id=${tenant.environmentId}`)),
        sessionEnvironment.selectOption(tenant.environmentId),
      ]);
      await page.getByText(productionPagePath, { exact: true }).waitFor();
      await expect.poll(
        () => page.getByText(stagingPagePath, { exact: true }).count(),
      ).toBe(0);
    } finally {
      await page.close();
      await context.close();
    }
  }, 90_000);
});
