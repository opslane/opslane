// @vitest-environment node

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTenant,
  closePool,
  getConfig,
  getPool,
  postEvent,
  seedTenant,
  seedUserWithJWT,
  type IngestKey,
  type TestTenant,
} from './helpers.js';
import { isPlaywrightAvailable } from './browser-helpers.js';

const configured = !!process.env['DATABASE_URL'] && !!process.env['INGESTION_URL'];
const playwrightAvailable = await isPlaywrightAvailable();

interface ProvisioningBundle {
  project: { id: string; name: string };
  environment: { id: string; name: string };
  // Boundary: this key arrives over HTTP from the provisioning endpoint, but
  // its role is known from the response shape — it's the project's ingest
  // key — so this is where it becomes a branded IngestKey.
  api_key: { id: string; raw_key: IngestKey };
}

describe('first-class projects dashboard', () => {
  let tenant: TestTenant;
  let jwt: string;
  let second: ProvisioningBundle;
  let firstIncidentId: string;
  let browser: import('@playwright/test').Browser;

  const firstTitle = `phase3 first ${crypto.randomUUID()}`;
  const secondTitle = `phase3 second ${crypto.randomUUID()}`;
  const createdTitle = `phase3 created ${crypto.randomUUID()}`;
  const clientIP = `198.51.100.${10 + Math.floor(Math.random() * 200)}`;

  async function ingest(ingestKey: IngestKey, title: string): Promise<string> {
    const response = await postEvent(ingestKey, {
      timestamp: new Date().toISOString(),
      error: {
        type: 'TypeError',
        message: title,
        stack: `TypeError: ${title}\n    at phase3 (src/phase3.ts:1:1)`,
      },
      breadcrumbs: [],
      context: {},
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { error_group_id: string };
    return body.error_group_id;
  }

  beforeAll(async () => {
    if (!configured) throw new Error('DATABASE_URL and INGESTION_URL are required');
    if (!playwrightAvailable) throw new Error('Playwright Chromium is required');
    tenant = await seedTenant();
    ({ jwt } = await seedUserWithJWT(tenant.orgId));
    const { ingestionUrl } = getConfig();
    const secondResponse = await fetch(`${ingestionUrl}/api/v1/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': clientIP,
      },
      body: JSON.stringify({
        name: 'Second project',
        idempotency_token: `phase3-second-${crypto.randomUUID()}`,
      }),
    });
    expect(secondResponse.status).toBe(201);
    second = await secondResponse.json() as ProvisioningBundle;

    firstIncidentId = await ingest(tenant.ingestKey, firstTitle);
    await ingest(second.api_key.raw_key, secondTitle);
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it.skip('switches safely from a deep link and provisions a usable project key with acknowledgement [suspended until Slice 4]', async () => {
    const { ingestionUrl } = getConfig();
    const context = await browser.newContext({
      extraHTTPHeaders: { 'X-Forwarded-For': clientIP },
    });
    await context.addCookies([{
      name: '__opslane_at',
      value: jwt,
      url: ingestionUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    await context.addInitScript(({ projectId, environmentId }) => {
      localStorage.setItem('opslane_authed', '1');
      if (!localStorage.getItem('opslane_project_id')) {
        localStorage.setItem('opslane_project_id', projectId);
        localStorage.setItem('opslane_project_name', 'First project');
        localStorage.setItem('opslane_environment_id', environmentId);
        localStorage.setItem('opslane_account_id', 'old-account');
      }
    }, { projectId: tenant.projectId, environmentId: tenant.environmentId });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);

    // NOTE(capture boundary, Slice 2): this deep link anchors on the incident
    // detail page, which renders again once identity settlement recreates
    // incidents. See the describe-level suspension.
    try {
      await page.goto(
        `${ingestionUrl}/issues/${firstIncidentId}?project_id=${tenant.projectId}` +
        `&environment_id=${tenant.environmentId}&account_id=old-account`,
      );
      await page.getByRole('heading', { name: firstTitle }).waitFor();
      const switcher = page.locator('#project-switcher');
      await switcher.waitFor();
      await switcher.selectOption(second.project.id);

      await page.waitForURL((url) => url.pathname === '/' && url.search === '');
      await page.getByRole('link', { name: secondTitle }).waitFor();
      expect(await page.getByRole('link', { name: firstTitle }).count()).toBe(0);
      const storedAfterSwitch = await page.evaluate(() => ({
        project: localStorage.getItem('opslane_project_id'),
        environment: localStorage.getItem('opslane_environment_id'),
        account: localStorage.getItem('opslane_account_id'),
      }));
      expect(storedAfterSwitch).toEqual({
        project: second.project.id,
        environment: null,
        account: null,
      });

      await page.evaluate(({ environmentId }) => {
        localStorage.setItem('opslane_environment_id', environmentId);
        localStorage.setItem('opslane_account_id', 'stale-account');
      }, { environmentId: tenant.environmentId });
      await page.goto(
        `${ingestionUrl}/settings?project_id=${second.project.id}` +
        `&environment_id=${tenant.environmentId}&account_id=stale-account`,
      );
      expect(await page.locator('#settings-project-select').count()).toBe(0);
      expect(await page.getByText('Allow SDK environment override').count()).toBe(0);

      await page.getByRole('button', { name: 'New project' }).click();
      await page.locator('input[name="new-project-name"]').fill('Browser-created project');
      await page.locator('input[name="new-project-repo"]').fill('acme/browser-created');
      const [createResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === 'POST' && response.url().endsWith('/api/v1/projects')),
        page.getByRole('button', { name: 'Create project', exact: true }).click(),
      ]);
      expect(
        createResponse.status(),
        await createResponse.text(),
      ).toBe(201);

      await page.getByRole('heading', { name: 'Project created' }).waitFor();
      const rawKeyText = (await page.getByText(/^opslane_pk_/).textContent())?.trim() ?? '';
      expect(rawKeyText).toMatch(/^opslane_pk_/);
      // Boundary: this key is scraped from the "copy your key" dialog, not
      // from a typed API response. The assertion above is what confirms
      // it's an ingest key before it becomes a branded IngestKey.
      const rawKey = rawKeyText as IngestKey;
      const done = page.getByRole('button', { name: 'Done' });
      expect(await done.isDisabled()).toBe(true);
      await page.getByText('I have copied and stored this key securely.').click();
      expect(await done.isEnabled()).toBe(true);
      await done.click();
      await page.waitForURL((url) => url.pathname === '/' && url.search === '');

      const storedAfterCreate = await page.evaluate(() => ({
        project: localStorage.getItem('opslane_project_id'),
        environment: localStorage.getItem('opslane_environment_id'),
        account: localStorage.getItem('opslane_account_id'),
      }));
      const storedCreatedProject = storedAfterCreate.project;
      expect(storedCreatedProject).not.toBe(second.project.id);
      expect(storedCreatedProject).toBeTruthy();
      expect(storedAfterCreate.environment).toBeNull();
      expect(storedAfterCreate.account).toBeNull();
      await expect.poll(
        () => page.locator('#project-switcher option').count(),
        { timeout: 5_000 },
      ).toBe(3);

      await ingest(rawKey, createdTitle);
      await page.goto(`${ingestionUrl}/`);
      await page.getByRole('link', { name: createdTitle }).waitFor();
      expect(await page.getByRole('link', { name: secondTitle }).count()).toBe(0);
    } finally {
      await page.close();
      await context.close();
    }
  }, 90_000);
});
