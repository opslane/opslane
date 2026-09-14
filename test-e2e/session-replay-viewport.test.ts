// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dashboardMockFixtures,
  isDashboardBrowserAvailable,
  startDashboardMockHarness,
  type DashboardHarness,
  type DashboardMockFixture,
} from './dashboard-mock-harness.js';

const STARTED_AT_MS = Date.parse('2026-07-22T20:02:00Z');
const PAGE_URL = 'https://example.test/app';
const RECORDED = { width: 1156, height: 800 };
const RESIZED = { width: 1300, height: 820 };
const RESIZE_AT_S = 4;
const LAST_EVENT_AT_S = 8;
const LAST_EVENT_MS = STARTED_AT_MS + LAST_EVENT_AT_S * 1_000;

// A minimal but real rrweb 2 stream: Meta, a FullSnapshot of an empty page, a
// mid-session viewport resize, and a trailing mouse move so the replay has a
// duration to seek across.
const recording = [
  { type: 4, timestamp: STARTED_AT_MS, data: { href: PAGE_URL, ...RECORDED } },
  {
    type: 2,
    timestamp: STARTED_AT_MS + 1,
    data: {
      initialOffset: { top: 0, left: 0 },
      node: {
        type: 0,
        id: 1,
        childNodes: [
          { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
          {
            type: 2,
            id: 3,
            tagName: 'html',
            attributes: {},
            childNodes: [
              { type: 2, id: 4, tagName: 'head', attributes: {}, childNodes: [] },
              { type: 2, id: 5, tagName: 'body', attributes: {}, childNodes: [] },
            ],
          },
        ],
      },
    },
  },
  { type: 3, timestamp: STARTED_AT_MS + RESIZE_AT_S * 1_000, data: { source: 4, ...RESIZED } },
  {
    type: 3,
    timestamp: LAST_EVENT_MS,
    data: { source: 1, positions: [{ x: 10, y: 10, id: 5, timeOffset: 0 }] },
  },
];

const fixture: DashboardMockFixture = {
  ...dashboardMockFixtures.success,
  name: 'dashboard-session-replay-viewport-mock',
  responses: {
    'GET /api/v1/projects/project-1/sessions/session-1': {
      body: {
        id: 'session-1',
        started_at: new Date(STARTED_AT_MS).toISOString(),
        last_chunk_at: new Date(LAST_EVENT_MS).toISOString(),
        status: 'analyzed',
        chunk_count: 1,
        playable_chunk_count: 1,
        bytes_stored: 2_048,
        error_count: 0,
        rage_click_count: 0,
        dead_click_count: 0,
        form_abandon_count: 0,
        page_url: PAGE_URL,
        chunks: [{
          seq: 0,
          decoded_size_bytes: 2_048,
          has_full_snapshot: true,
          first_event_ms: STARTED_AT_MS,
          last_event_ms: LAST_EVENT_MS,
        }],
      },
    },
    'GET /api/v1/projects/project-1/sessions/session-1/chunks/0': { body: { events: recording } },
  },
};

const browserAvailable = await isDashboardBrowserAvailable();

// ReplayPlayer fits a recording by scaling `.replayer-wrapper`, so the rrweb
// iframe must keep the recorded viewport width. The dashboard's base reset
// (`iframe { max-width: 100% }`) once capped it at the container width, which
// reflowed responsive apps and dropped scroll positions inside containers (#495).
describe.skipIf(!browserAvailable)('session replay viewport in Chromium', () => {
  let harness: DashboardHarness;

  beforeAll(async () => {
    harness = await startDashboardMockHarness(fixture);
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  const replayedWidth = () => harness.page.evaluate(() =>
    document.querySelector<HTMLIFrameElement>('.replay-container iframe')?.contentWindow?.innerWidth ?? null);

  // The iframe keeps its recorded layout width, so the wrapper transform alone
  // must shrink it to the container: its rendered width matches the container.
  const renderedOverflow = () => harness.page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.replay-container');
    const iframe = container?.querySelector('iframe');
    if (!container || !iframe) return null;
    return Math.round(Math.abs(iframe.getBoundingClientRect().width - container.clientWidth));
  });

  const seekTo = (seconds: number) => harness.page.locator('input[type="range"]').evaluate((input, value) => {
    (input as HTMLInputElement).value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, seconds);

  it('keeps the recorded viewport width in a narrower container, across a mid-session resize', async () => {
    await harness.page.goto(`${harness.url}/sessions/session-1`);
    await harness.page.locator('.replay-container iframe').waitFor();

    const containerWidth = await harness.page.locator('.replay-container').evaluate((element) => element.clientWidth);
    expect(containerWidth).toBeGreaterThan(0);
    expect(containerWidth).toBeLessThan(RECORDED.width);

    await expect.poll(replayedWidth).toBe(RECORDED.width);
    await expect.poll(renderedOverflow).toBeLessThanOrEqual(1);

    await seekTo(RESIZE_AT_S + 1);
    await expect.poll(replayedWidth).toBe(RESIZED.width);
    await expect.poll(renderedOverflow).toBeLessThanOrEqual(1);

    await seekTo(1);
    await expect.poll(replayedWidth).toBe(RECORDED.width);

    harness.assertClean();
  });

  it('opens a deep link past a mid-session resize at the resized viewport width', async () => {
    const citedMs = STARTED_AT_MS + (RESIZE_AT_S + 2) * 1_000;
    await harness.page.goto(`${harness.url}/sessions/session-1?t=${citedMs}`);
    await harness.page.locator('.replay-container iframe').waitFor();

    await expect.poll(replayedWidth).toBe(RESIZED.width);
    await expect.poll(renderedOverflow).toBeLessThanOrEqual(1);

    harness.assertClean();
  });
});
