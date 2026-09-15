// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dashboardMockFixtures,
  isDashboardBrowserAvailable,
  startDashboardMockHarness,
  type DashboardHarness,
} from './dashboard-mock-harness.js';

const ROOT = resolve(__dirname, '..');
const DASHBOARD = resolve(ROOT, 'packages/dashboard');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) result.push(...sourceFiles(path));
    else if (['.ts', '.vue', '.css'].includes(extname(path))) result.push(path);
  }
  return result;
}

// Assertions that existed only to police the Tailwind 4 migration itself were
// retired once #130 landed. They froze source hashes, the dashboard manifest,
// the changed-path scope, the legacy-class countdown, screenshot bookkeeping,
// and a pre-migration bundle ceiling — each of which rejects normal dashboard
// work now that the migration is the baseline rather than the change under
// review. What remains here are the checks that describe the dashboard as it
// should stay: no orphaned components, no test artifacts in production, and
// the deterministic browser smoke below.
describe('dashboard V1 safeguards', () => {
  it('requires a documented production consumer for every owned component', () => {
    const matrix = read('docs/design/dashboard-v1/consumer-matrix.md');
    const ownedRoots = ['ui', 'layout', 'evidence', 'incidents', 'sessions'];
    const production = sourceFiles(resolve(DASHBOARD, 'src')).filter((path) =>
      !/\.(?:test|spec)\.ts$/.test(path) &&
      !path.includes('/__tests__/') &&
      !path.endsWith('/index.ts')
    );
    for (const root of ownedRoots) {
      for (const component of sourceFiles(resolve(DASHBOARD, 'src/components', root)).filter((path) => extname(path) === '.vue')) {
        const name = basename(component);
        expect(matrix, `${name} is absent from consumer-matrix.md`).toContain(`\`${name}\``);
        const symbol = basename(component, '.vue');
        const importPattern = new RegExp(`from ['\"][^'\"]*/${symbol}\\.vue['\"]`);
        const consumers = production.filter((path) => path !== component && importPattern.test(readFileSync(path, 'utf8')));
        expect(consumers.length, `${name} has no production consumer`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps test fixtures and design evidence out of production imports', () => {
    for (const path of sourceFiles(resolve(DASHBOARD, 'src'))) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/test-e2e|dashboard-mock-harness|docs\/design|\.omx/);
    }
  });

});

const browserAvailable = await isDashboardBrowserAvailable();

describe.skipIf(!browserAvailable)('dashboard deterministic Chromium smoke', () => {
  let harness: DashboardHarness;

  beforeAll(async () => {
    harness = await startDashboardMockHarness(dashboardMockFixtures.success);
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  const routes: Array<{ path: string; identity: RegExp }> = [
    { path: '/setup', identity: /Set up Opslane with your coding agent/i },
    { path: '/', identity: /^Issues$/i },
    { path: '/issues/incident-1', identity: /Mock incident title/i },
    { path: '/accounts', identity: /Accounts/i },
    { path: '/accounts/account-1', identity: /Mock Account/i },
    { path: '/sessions', identity: /Sessions/i },
    { path: '/sessions/session-1', identity: /Session details/i },
    { path: '/settings', identity: /Settings/i },
    { path: '/admin', identity: /System observability/i },
  ];

  for (const route of routes) {
    it(`${route.path} has one main landmark and no page-level overflow`, async () => {
      await harness.page.goto(`${harness.url}${route.path}`);
      await expect.poll(async () => harness.page.getByText(route.identity).count()).toBeGreaterThan(0);
      expect(await harness.page.locator('main').count()).toBe(1);
      await harness.page.setViewportSize({ width: 390, height: 844 });
      const layout = await harness.page.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        offenders: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.left < -1 || bounds.right > document.documentElement.clientWidth + 1;
          })
          .slice(0, 8)
          .map((element) => ({ tag: element.tagName, className: element.className, text: element.innerText.slice(0, 60) })),
      }));
      expect(layout.fits, JSON.stringify(layout, null, 2)).toBe(true);
      let activeTag = await harness.page.evaluate(() => document.activeElement?.tagName);
      for (let attempt = 0; attempt < 5 && activeTag === 'BODY'; attempt += 1) {
        await harness.page.keyboard.press('Tab');
        activeTag = await harness.page.evaluate(() => document.activeElement?.tagName);
      }
      expect(activeTag).not.toBe('BODY');
      await harness.page.setViewportSize({ width: 1440, height: 1000 });
      harness.assertClean();
    });
  }

  it('renders the session ledger fixture with decision signals and mobile-preserved chips', async () => {
    await harness.page.setViewportSize({ width: 1440, height: 1000 });
    await harness.page.goto(`${harness.url}/sessions`);
    await expect.poll(async () => harness.page.getByRole('heading', { name: 'Recorded sessions' }).count())
      .toBe(1);

    const table = harness.page.getByRole('table', { name: 'Recorded sessions' });
    // The heading renders before the session list request resolves, so wait
    // for the rows instead of counting them once.
    await expect.poll(async () => table.locator('tbody tr').count()).toBe(4);
    expect(await table.getByText('3 errors', { exact: true }).count()).toBeGreaterThan(0);
    expect(await table.getByText('2 rage clicks', { exact: true }).count()).toBeGreaterThan(0);
    expect(await table.getByText('Queued', { exact: true }).count()).toBeGreaterThan(0);
    expect(await table.getByText('Analysis failed', { exact: true }).count()).toBeGreaterThan(0);
    expect(await table.locator('tbody tr').nth(3).locator('a').count()).toBe(0);
    expect(await table.locator('tbody tr').nth(3).locator('[aria-disabled="true"]').count()).toBe(1);

    await harness.page.setViewportSize({ width: 390, height: 844 });
    expect(await table.locator('th').filter({ hasText: 'Signals' }).evaluate((element) =>
      getComputedStyle(element).display)).toBe('none');
    const mobileSignals = table.locator('tbody tr').first().locator('td').first();
    expect(await mobileSignals.getByText('3 errors', { exact: true }).count()).toBe(1);
    expect(await harness.page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await harness.page.setViewportSize({ width: 1440, height: 1000 });
    harness.assertClean();
  });

  it('wires Settings tabs to real tabpanels', async () => {
    await harness.page.goto(`${harness.url}/settings`);
    await expect.poll(async () => harness.page.locator('[role="tab"]').count()).toBeGreaterThan(0);

    const wiring = await harness.page.evaluate(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
      return tabs.map((tab) => {
        const controls = tab.getAttribute('aria-controls');
        const panel = controls ? document.getElementById(controls) : null;
        return {
          id: tab.id,
          controls,
          selected: tab.getAttribute('aria-selected'),
          tabindex: tab.getAttribute('tabindex'),
          // a panel only exists for the visible tab; when present it must be a
          // real tabpanel pointing back at its tab
          panelRole: panel?.getAttribute('role') ?? null,
          panelLabelledBy: panel?.getAttribute('aria-labelledby') ?? null,
        };
      });
    });

    expect(wiring.length).toBeGreaterThan(1);
    for (const tab of wiring) {
      expect(tab.id, 'every tab needs an id for aria-labelledby').toBeTruthy();
      expect(tab.controls, 'every tab must declare aria-controls').toBeTruthy();
    }
    // exactly one selected tab, and it owns a rendered tabpanel
    const selected = wiring.filter((tab) => tab.selected === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.tabindex).toBe('0');
    expect(selected[0]?.panelRole).toBe('tabpanel');
    expect(selected[0]?.panelLabelledBy).toBe(selected[0]?.id);
    // roving tabindex: unselected tabs are removed from the tab order
    for (const tab of wiring.filter((entry) => entry.selected !== 'true')) {
      expect(tab.tabindex).toBe('-1');
    }

    // ArrowRight moves selection and focus to the next tab
    await harness.page.locator('[role="tab"][aria-selected="true"]').focus();
    await harness.page.keyboard.press('ArrowRight');
    const moved = await harness.page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return { role: active?.getAttribute('role'), selected: active?.getAttribute('aria-selected') };
    });
    expect(moved.role).toBe('tab');
    expect(moved.selected).toBe('true');

    harness.assertClean();
  });

  it('does not fall through to a live API for an unknown request', async () => {
    const result = await harness.page.evaluate(async () => {
      try {
        await fetch('/api/v1/not-in-the-manifest');
        return 'resolved';
      } catch {
        return 'rejected';
      }
    });
    expect(result).toBe('rejected');
    expect(harness.unexpectedRequests).toContain('GET /api/v1/not-in-the-manifest');
  });
});
