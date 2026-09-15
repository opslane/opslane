// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dashboardMockFixtures,
  isDashboardBrowserAvailable,
  startDashboardMockHarness,
  type DashboardHarness,
} from './dashboard-mock-harness.js';

const browserAvailable = await isDashboardBrowserAvailable();
const captureEnabled = process.env['CAPTURE_DASHBOARD_SCREENSHOTS'] === '1';
const outputDirectory = resolve(__dirname, '../docs/design/dashboard-v1/screenshots/after');

describe.skipIf(!browserAvailable || !captureEnabled)('dashboard approved-fixture screenshot capture', () => {
  let successHarness: DashboardHarness;
  let signedOutHarness: DashboardHarness;
  let callbackHarness: DashboardHarness;
  let emptyHarness: DashboardHarness;
  let errorHarness: DashboardHarness;

  beforeAll(async () => {
    [successHarness, signedOutHarness, callbackHarness, emptyHarness, errorHarness] = await Promise.all([
      startDashboardMockHarness(dashboardMockFixtures.success),
      startDashboardMockHarness(dashboardMockFixtures.signedOut),
      startDashboardMockHarness({
        name: 'auth-callback-loading-mock',
        authenticated: false,
        responses: {
          'GET /api/v1/auth/me': { delayMs: 10_000, body: {} },
        },
      }),
      startDashboardMockHarness(dashboardMockFixtures.empty),
      startDashboardMockHarness(dashboardMockFixtures.incidentsError),
    ]);
    await Promise.all([
      successHarness.page.emulateMedia({ reducedMotion: 'reduce' }),
      signedOutHarness.page.emulateMedia({ reducedMotion: 'reduce' }),
      callbackHarness.page.emulateMedia({ reducedMotion: 'reduce' }),
      emptyHarness.page.emulateMedia({ reducedMotion: 'reduce' }),
      errorHarness.page.emulateMedia({ reducedMotion: 'reduce' }),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([
      successHarness?.close(), signedOutHarness?.close(), callbackHarness?.close(),
      emptyHarness?.close(), errorHarness?.close(),
    ]);
  });

  type HarnessName = 'success' | 'signed-out' | 'callback' | 'empty' | 'error';
  const routes: Array<{ path: string; fixture: string; identity: RegExp; harness: HarnessName }> = [
    { path: '/login', fixture: 'login-password-mock', identity: /Sign in to Opslane/i, harness: 'signed-out' },
    { path: '/reset-password?token=mock-token', fixture: 'reset-password-mock', identity: /Choose a new password/i, harness: 'signed-out' },
    { path: '/auth/complete', fixture: 'auth-callback-loading-mock', identity: /Completing sign in/i, harness: 'callback' },
    { path: '/invite/accept?token=mock-token', fixture: 'invitation-accepted-mock', identity: /Organization invitation/i, harness: 'success' },
    { path: '/setup', fixture: 'setup-waiting-mock', identity: /Set up Opslane with your coding agent/i, harness: 'success' },
    { path: '/', fixture: 'activity-success-mock', identity: /^Issues$/i, harness: 'success' },
    { path: '/issues/incident-1', fixture: 'incident-pr-created-mock', identity: /Mock incident title/i, harness: 'success' },
    { path: '/accounts', fixture: 'accounts-success-mock', identity: /^Accounts$/i, harness: 'success' },
    { path: '/accounts/account-1', fixture: 'account-detail-success-mock', identity: /Mock Account/i, harness: 'success' },
    { path: '/sessions', fixture: 'sessions-success-mock', identity: /^Recorded sessions$/i, harness: 'success' },
    { path: '/sessions/session-1', fixture: 'session-detail-success-mock', identity: /Session details/i, harness: 'success' },
    { path: '/settings', fixture: 'settings-success-mock', identity: /^Settings$/i, harness: 'success' },
    { path: '/admin', fixture: 'admin-success-mock', identity: /System observability/i, harness: 'success' },
    // Zero-incident and failed-load ledgers: the two branches a success-only
    // fixture set can never reach, and where the slot/prop regressions hid.
    { path: '/', fixture: 'activity-empty-mock', identity: /No issues yet/i, harness: 'empty' },
    { path: '/', fixture: 'activity-error-mock', identity: /Unable to load issues/i, harness: 'error' },
  ];
  const viewports = [
    { width: 1440, height: 1000 },
    { width: 1180, height: 1000 },
    { width: 390, height: 844 },
  ];

  for (const route of routes) {
    for (const viewport of viewports) {
      it(`captures ${route.fixture} at ${viewport.width}x${viewport.height}`, async () => {
        const harness = route.harness === 'success' ? successHarness
          : route.harness === 'signed-out' ? signedOutHarness
            : route.harness === 'empty' ? emptyHarness
              : route.harness === 'error' ? errorHarness
                : callbackHarness;
        await harness.page.setViewportSize(viewport);
        await harness.page.goto(`${harness.url}${route.path}`);
        await expect.poll(async () => harness.page.getByText(route.identity).count()).toBeGreaterThan(0);
        await harness.page.evaluate(async () => { await document.fonts.ready; });
        await harness.page.screenshot({
          path: resolve(outputDirectory, `${route.fixture}-${viewport.width}x${viewport.height}.png`),
          fullPage: false,
          animations: 'disabled',
        });
        if (route.harness === 'error') {
          // The 500 is the point of this fixture. Drain only that exact console
          // message so any *other* error still fails the capture.
          const expected = harness.consoleErrors.filter((message) =>
            message.includes('the server responded with a status of 500'));
          for (const message of expected) {
            harness.consoleErrors.splice(harness.consoleErrors.indexOf(message), 1);
          }
        }
        if (route.harness === 'callback') {
          const expectedNavigationAborts = harness.failedResources.filter((failure) =>
            failure.includes('/api/v1/auth/me: net::ERR_ABORTED'));
          for (const failure of expectedNavigationAborts) {
            harness.failedResources.splice(harness.failedResources.indexOf(failure), 1);
          }
        }
        harness.assertClean();
      });
    }
  }

  it('writes a checksum manifest and browsable gallery for every capture', () => {
    const files = routes.flatMap((route) => viewports.map((viewport) => {
      const name = `${route.fixture}-${viewport.width}x${viewport.height}.png`;
      const path = resolve(outputDirectory, name);
      return {
        name,
        route: route.path,
        fixture: route.fixture,
        width: viewport.width,
        height: viewport.height,
        bytes: statSync(path).size,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      };
    })).sort((left, right) => left.name.localeCompare(right.name));

    writeFileSync(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      fixtureDisclosure: 'All captures use deterministic test-only mock data from test-e2e/dashboard-mock-harness.ts.',
      captureCommand: 'CAPTURE_DASHBOARD_SCREENSHOTS=1 pnpm --filter @opslane/test-e2e exec vitest run dashboard-screenshots.test.ts',
      browser: 'Chromium',
      referenceComparison: 'not performed; no approved reference images exist',
      files,
    }, null, 2)}\n`);

    const cards = routes.map((route) => {
      const images = viewports.map((viewport) => {
        const name = `${route.fixture}-${viewport.width}x${viewport.height}.png`;
        return `<a href="./${name}"><img src="./${name}" alt="${route.fixture} at ${viewport.width} by ${viewport.height}"><span>${viewport.width}×${viewport.height}</span></a>`;
      }).join('');
      return `<section><h2>${route.fixture}</h2><p><code>${route.path}</code></p><div class="shots">${images}</div></section>`;
    }).join('');
    writeFileSync(resolve(outputDirectory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opslane dashboard screenshots</title><style>body{margin:0;background:#f4f1ea;color:#25221d;font:15px system-ui,sans-serif}header{padding:32px;position:sticky;top:0;background:#f4f1eaeF;border-bottom:1px solid #c8c0b4;z-index:1}main{padding:32px;display:grid;gap:48px}section{border-bottom:1px solid #c8c0b4;padding-bottom:40px}h1,h2{margin:0 0 8px}.shots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-items:start}.shots a{color:inherit;text-decoration:none;font-weight:600}.shots img{display:block;width:100%;height:auto;margin-bottom:8px;border:1px solid #a69d90;background:white}@media(max-width:800px){.shots{grid-template-columns:1fr}header,main{padding:20px}}</style></head><body><header><h1>Opslane dashboard — routed screens</h1><p>Deterministic Chromium captures with mock-labelled data.</p></header><main>${cards}</main></body></html>`);

    expect(files).toHaveLength(routes.length * viewports.length);
  });
});
