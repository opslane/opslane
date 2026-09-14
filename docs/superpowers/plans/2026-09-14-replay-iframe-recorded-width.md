# Replay iframe keeps its recorded width — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the dashboard's global `max-width: 100%` reset from capping the rrweb replay iframe, so replays render at the recorded viewport width and follow scrolling inside containers.

**Architecture:** `ReplayPlayer.vue` fits a recording by scaling `.replayer-wrapper` with a CSS transform (#413). rrweb sizes its iframe with `width`/`height` attributes (`handleResize` in rrweb 2.1.1, fired for Meta and for `IncrementalSource.ViewportResize` in both sync seeks and live playback). `packages/dashboard/src/styles/base.css` applies `iframe { max-width: 100% }` inside `@layer base`, which caps that attribute width at the container. Add `max-width: none` to the component's existing scoped `:deep(iframe)` rule. Unlayered scoped styles outrank `@layer base` regardless of specificity, so no `!important`. Two tests pin it: a fast Vitest check on the compiled SFC CSS (runs in `pnpm test`), and a Chromium test on the built dashboard that asserts the replayed `innerWidth` (runs in CI's e2e lane, where it is pinned by name).

**Tech Stack:** Vue 3 SFC (`vue/compiler-sfc`), Vitest 3, rrweb 2.1.1, Playwright Chromium through `test-e2e/dashboard-mock-harness.ts`, Tailwind 4 cascade layers.

**Spec:** GitHub issue #495 ("Session replay renders narrower than the recording, so scrolling apps show only the top of the page").

## Global Constraints

- Do not edit `base.css`. The global reset is correct for every other iframe/img/svg/canvas in the dashboard.
- Keep the wrapper-transform design from #413. Do not give the iframe a CSS `width`; rrweb owns width through attributes and updates it on resize.
- No new dependencies. `vue/compiler-sfc` ships with `vue`; `@playwright/test` and `vite` are already test-e2e dependencies.
- Vitest tests in `packages/*` live in `__tests__` (repo AGENTS.md). test-e2e tests sit flat in `test-e2e/`.
- The dashboard's TypeScript `lib` is ES2020: no `Array.prototype.at`.
- rrweb's `.replayer-mouse-tail` canvas is also capped by the reset, but `ReplayPlayer` hard-codes `mouseTail: false`, so no canvas exists. Out of scope.

## File Structure

- Modify: `packages/dashboard/src/components/ReplayPlayer.vue` (the `.replay-container :deep(iframe)` rule in `<style scoped>`).
- Create: `packages/dashboard/src/components/__tests__/replay-player-iframe-style.test.ts` (compiled-CSS pin).
- Create: `test-e2e/session-replay-viewport.test.ts` (Chromium pin against the built dashboard).
- Modify: `.github/workflows/ci.yml` (add the new browser test to `E2E_REQUIRED_PATTERNS`).

## Acceptance criteria (from #495)

- AC1: A replayed recording's iframe `contentWindow.innerWidth` equals the recorded Meta width at any container width.
- AC2: A recording whose app scrolls inside an element shows the recorded scroll positions when seeking and playing.
- AC3: Click positions stay aligned with the scaled page.
- AC4: A component test pins the iframe style so a global reset cannot cap it again.

Coverage: Task 1 pins the declaration (AC4, fast lane). Task 2 pins the computed result in a real browser, including a mid-session resize and a backward seek (AC1 and AC4 against any future cascade change). Task 3 proves AC1–AC3 with a real rrweb recording of a responsive, container-scrolling app, fix versus pre-fix build.

---

### Task 1: Uncap the replay iframe and pin the compiled style

**Files:**
- Create: `packages/dashboard/src/components/__tests__/replay-player-iframe-style.test.ts`
- Modify: `packages/dashboard/src/components/ReplayPlayer.vue` (end of file, `<style scoped>`)

**Interfaces:**
- Consumes: nothing.
- Produces: scoped rule `.replay-container :deep(iframe) { border: 0; max-width: none; }`, compiled as `.replay-container[data-v-…] iframe`. Tasks 2 and 3 exercise it in a browser.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/src/components/__tests__/replay-player-iframe-style.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileStyle, parse } from 'vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

const FILENAME = fileURLToPath(new URL('../ReplayPlayer.vue', import.meta.url));
const SCOPE_ID = 'data-v-replay';

function compiledStyles(): string {
  const { descriptor, errors } = parse(readFileSync(FILENAME, 'utf8'), { filename: FILENAME });
  expect(errors).toEqual([]);
  return descriptor.styles
    .map((style) => {
      const result = compileStyle({ source: style.content, filename: FILENAME, id: SCOPE_ID, scoped: style.scoped });
      expect(result.errors).toEqual([]);
      return result.code;
    })
    .join('\n');
}

function declarationsFor(css: string, selector: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations: string[] = [];
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    for (const declaration of rule[2].split(';')) {
      const normalized = declaration.trim().replace(/\s*:\s*/, ': ');
      if (normalized) declarations.push(normalized);
    }
  }
  return declarations;
}

/**
 * rrweb sizes the replay iframe with width/height attributes set to the recorded
 * viewport, and ReplayPlayer fits it by scaling `.replayer-wrapper`. The
 * dashboard's base reset (`iframe { max-width: 100% }`) would cap the iframe at
 * the container width instead, so the replayed app reflows to a narrower layout
 * and its recorded scroll positions stop applying (#495). The computed result is
 * pinned in a real browser by test-e2e/session-replay-viewport.test.ts.
 */
describe('ReplayPlayer iframe style', () => {
  it('lifts the global max-width cap off the rrweb iframe', () => {
    const maxWidths = declarationsFor(compiledStyles(), `.replay-container[${SCOPE_ID}] iframe`)
      .filter((declaration) => declaration.startsWith('max-width:'));
    expect(maxWidths.length).toBeGreaterThan(0);
    expect(maxWidths[maxWidths.length - 1]).toBe('max-width: none');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @opslane/dashboard exec vitest run src/components/__tests__/replay-player-iframe-style.test.ts`
Expected: FAIL — `expected 0 to be greater than 0` (the iframe rule declares only `border: 0`).

- [ ] **Step 3: Write the minimal implementation**

In `packages/dashboard/src/components/ReplayPlayer.vue`, replace:

```css
.replay-container :deep(iframe) {
  border: 0;
}
```

with:

```css
/* rrweb sizes the iframe to the recorded viewport through width/height
   attributes. The dashboard's base reset caps iframes at max-width: 100%, which
   would shrink it to the container, reflow the replayed app, and lose recorded
   scroll positions. The wrapper transform above already does the fitting. */
.replay-container :deep(iframe) {
  border: 0;
  max-width: none;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @opslane/dashboard exec vitest run src/components/__tests__/replay-player-iframe-style.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the dashboard gate**

Run: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`
Expected: `vue-tsc` clean (the test file is inside the dashboard `tsconfig` `include`), Vite build succeeds, all dashboard tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/components/ReplayPlayer.vue packages/dashboard/src/components/__tests__/replay-player-iframe-style.test.ts
git commit -m "fix(dashboard): keep the replay iframe at the recorded width"
```

---

### Task 2: Pin the replayed viewport width in Chromium

The Task 1 test proves the declaration exists. It cannot catch a stronger rule elsewhere (an unlayered or `!important` reset) re-capping the iframe. This test loads the built dashboard's session page with a synthetic rrweb stream and reads the replayed document's `innerWidth`. It was dry-run during planning: on the pre-fix build it fails with `expected 840 to be 1156` (840px is the replay container at the harness's 1440×1000 viewport); with the fix it passes in ~1s.

**Files:**
- Create: `test-e2e/session-replay-viewport.test.ts`
- Modify: `.github/workflows/ci.yml` (`E2E_REQUIRED_PATTERNS` block in the "Enforce zero unexpected skips" step)

**Interfaces:**
- Consumes: Task 1's fix in `packages/dashboard/dist` (rebuild after Task 1). `startDashboardMockHarness(fixture)`, `dashboardMockFixtures.success`, `isDashboardBrowserAvailable()`, and `DashboardHarness` from `test-e2e/dashboard-mock-harness.ts`. Fixture `responses` are keyed `"METHOD /path"` and override the harness defaults (the default session detail has `chunks: []`, which would leave the page polling).
- Produces: the Vitest test name `session replay viewport in Chromium > keeps the recorded viewport width in a narrower container, across a mid-session resize`, pinned in CI.

- [ ] **Step 1: Write the test**

Create `test-e2e/session-replay-viewport.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dashboardMockFixtures,
  isDashboardBrowserAvailable,
  startDashboardMockHarness,
  type DashboardHarness,
} from './dashboard-mock-harness.js';

const STARTED_AT_MS = Date.parse('2026-07-22T20:02:00Z');
const RECORDED = { width: 1156, height: 800 };
const RESIZED = { width: 1300, height: 820 };
const RESIZE_AT_S = 4;
const LAST_EVENT_AT_S = 8;

// A minimal but real rrweb 2 stream: Meta, a FullSnapshot of an empty page, a
// mid-session viewport resize, and a trailing mouse move so the replay has a
// duration to seek across.
const recording = [
  { type: 4, timestamp: STARTED_AT_MS, data: { href: 'https://example.test/app', ...RECORDED } },
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
    timestamp: STARTED_AT_MS + LAST_EVENT_AT_S * 1_000,
    data: { source: 1, positions: [{ x: 10, y: 10, id: 5, timeOffset: 0 }] },
  },
];

const fixture = {
  ...dashboardMockFixtures.success,
  name: 'dashboard-session-replay-viewport-mock',
  responses: {
    'GET /api/v1/projects/project-1/sessions/session-1': {
      body: {
        id: 'session-1',
        started_at: '2026-07-22T20:02:00Z',
        last_chunk_at: '2026-07-22T20:02:08Z',
        status: 'analyzed',
        chunk_count: 1,
        playable_chunk_count: 1,
        bytes_stored: 2_048,
        error_count: 0,
        rage_click_count: 0,
        dead_click_count: 0,
        form_abandon_count: 0,
        page_url: 'https://example.test/app',
        chunks: [{
          seq: 0,
          decoded_size_bytes: 2_048,
          has_full_snapshot: true,
          first_event_ms: STARTED_AT_MS,
          last_event_ms: STARTED_AT_MS + LAST_EVENT_AT_S * 1_000,
        }],
      },
    },
    'GET /api/v1/projects/project-1/sessions/session-1/chunks/0': { body: { events: recording } },
  },
} as const;

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

    await seekTo(RESIZE_AT_S + 1);
    await expect.poll(replayedWidth).toBe(RESIZED.width);

    await seekTo(1);
    await expect.poll(replayedWidth).toBe(RECORDED.width);

    harness.assertClean();
  });
});
```

Notes for the implementer:
- `SessionDetail` passes no seek target, so the player opens at offset 0, where Meta has applied 1156. The slider's `@input` handler calls `Replayer.pause(ms)`, which applies events synchronously; `expect.poll` absorbs the async iframe rebuild.
- Seek targets (5s, 1s) sit ≥1s from every event, so the slider's 0.1s step cannot straddle one.
- The backward seek to 1s proves rrweb re-applies Meta on rewind and the player never keeps a stale width.

- [ ] **Step 2: Prove it fails without the fix**

Temporarily remove the `max-width: none;` line from `ReplayPlayer.vue`, then run:

```bash
pnpm --filter @opslane/dashboard build
(cd test-e2e && CHOKIDAR_USEPOLLING=true pnpm exec vitest run session-replay-viewport.test.ts)
```

Expected: FAIL at the first `expect.poll(replayedWidth)` with `expected 840 to be 1156` (840 may differ slightly by font metrics; it must be the container width, below 1156). If the suite reports **skipped**, Chromium or `dist/index.html` is missing: run `pnpm --filter @opslane/test-e2e exec playwright install chromium` and rebuild. A skip is not a pass. Then restore the line (`git checkout packages/dashboard/src/components/ReplayPlayer.vue` if Task 1 is already committed).

- [ ] **Step 3: Prove it passes with the fix**

```bash
pnpm --filter @opslane/dashboard build
(cd test-e2e && CHOKIDAR_USEPOLLING=true pnpm exec vitest run session-replay-viewport.test.ts)
```

Expected: PASS, 1 test, not skipped.

- [ ] **Step 4: Pin the test by name in CI**

In `.github/workflows/ci.yml`, inside `E2E_REQUIRED_PATTERNS: |` of the "Enforce zero unexpected skips" step, add one line directly after `^SDK environment browser contract > sends the configured name through real Chromium`:

```yaml
            ^session replay viewport in Chromium > keeps the recorded viewport width in a narrower container, across a mid-session resize$
```

Also append this sentence to the comment block above the patterns, after the sentence ending "work in a real browser.":

```yaml
          # The session replay viewport case is the only browser-level proof
          # that the replay iframe keeps its recorded width (#495).
```

Do not change `E2E_MIN_TESTS`; it is a floor (`scripts/check-e2e-results.mjs`), and adding a test keeps it satisfied.

- [ ] **Step 5: Validate the workflow edit and typecheck**

Run:

```bash
node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!y.includes('^session replay viewport in Chromium > keeps the recorded viewport width in a narrower container, across a mid-session resize$')) process.exit(1)"
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"
(cd test-e2e && pnpm exec tsc --noEmit 2>&1 | grep session-replay-viewport; test $? -eq 1)
```

Expected: all exit 0. The `tsc` grep must print nothing for the new file. Locally `tsc` may report unrelated errors from `friction-incidents.test.ts` and `packages/worker/src` when worker/shared `dist` is unbuilt; `pnpm -r build` clears them and is part of the full gate.

- [ ] **Step 6: Commit**

```bash
git add test-e2e/session-replay-viewport.test.ts .github/workflows/ci.yml
git commit -m "test(e2e): pin the replayed viewport width in Chromium"
```

---

### Task 3: Prove AC1–AC3 with a real recording (verification only, nothing committed)

Tasks 1–2 pin the width, including resize and rewind. This task proves the user-visible symptoms from #495 are gone: the responsive layout, container scrolling, and click alignment. It uses one real rrweb recording on the session page and compares the fixed build with a pre-fix build made in the same worktree (the mock harness always serves `packages/dashboard/dist` relative to its own checkout). Scratch files live in the session scratchpad.

Out of scope here, with reasons: IncidentDetail's two `ReplayPlayer` mounts render the same component and scoped CSS, and the harness's `mockIncident()` is private, so a legacy-incident fixture would mean copying the whole incident body for no new CSS path. A recording narrower than its container (scale 1) never reaches the `max-width` cap, so the fix cannot change it.

**Files:**
- Create (scratchpad only): `fixture.html`, `record.mjs`, `verify.mjs`, `report.md`, screenshots.
- No repo files change.

**Interfaces:**
- Consumes: built `packages/dashboard/dist`; `startDashboardMockHarness` with `responses` overrides (session detail with one chunk plus `.../chunks/0`, exactly as in Task 2); rrweb's UMD build `packages/dashboard/node_modules/rrweb/dist/rrweb.umd.cjs` (defines the `rrweb` global when loaded as a classic script).
- Produces: `report.md` with a build × AC table, measured values, and screenshot paths.

- [ ] **Step 1: Build a responsive, container-scrolling fixture page**

`fixture.html` must reproduce the failure geometry, not just a sidebar collapse:
- Wide layout (viewport > 1000px): `body { margin: 0; height: 100vh; overflow: hidden; display: flex }`, a 240px sidebar, and `#main { flex: 1; height: 100vh; overflow-y: auto }` holding ~3000px of content with a footer `<button id="save">` near the bottom (content offset ~2700px).
- `@media (max-width: 1000px)`: hide the sidebar, `body { height: auto; overflow: visible; display: block }`, `#main { height: auto; overflow: visible }`. In this layout `#main` is not a scroll container, so a replayed `#main` scroll has nothing to scroll.
- The 1000px breakpoint sits between the SessionDetail replay container (~840px at a 1440×1000 viewport) and the recorded width (1156px). If Step 3 measures a container width ≥ 1000, lower the breakpoint below it and re-record.

- [ ] **Step 2: Record one session with rrweb in Chromium (`record.mjs`)**

Viewport 1156×800. Every phase is separated by a quiet gap of at least 1500ms so every seek target in Step 3 is unambiguous:
1. Load `fixture.html` with rrweb's UMD script, start `rrweb.record({ emit: (e) => window.__events.push(e) })`. Wait 1500ms.
2. Hover `#main` and scroll with `page.mouse.wheel(0, 400)` every 150ms until `#main.scrollTop` ≥ 2300 and `#save` is inside the viewport. Wait 1500ms (rrweb throttles scroll events at 100ms, so the final value is flushed well before the gap ends).
3. Read `#save`'s `getBoundingClientRect()` and click its center with `page.mouse.click(x, y)`. Do not use `locator.click()`: it may auto-scroll and emit another scroll event. Wait 1500ms.
4. `page.setViewportSize({ width: 1300, height: 820 })`. Wait 1500ms. Save `window.__events` to JSON.
5. Validate the stream and write down these timestamps and values: `T0` = first event; `S1` / `Sn` = first / last scroll event (`type 3, data.source 3`) whose `data.id` is `#main`'s mirror id; `Y` = `Sn.data.y`, which must equal the live `#main.scrollTop` read before the click; `C` = the click (`type 3, data.source 2, data.type 2`) whose `x/y` fall inside `#save`'s rect; `R` = the resize (`data.source 4`, width 1300). Confirm Meta width is 1156, and that no scroll event exists between `Sn` and `R`.

- [ ] **Step 3: Drive the dashboard (`verify.mjs`)**

Harness viewport 1440×1000, overrides as in Task 2 with this recording's first and last timestamps. Open `/sessions/session-1` and wait for `.replay-container iframe`.

Seek only through the UI slider: set `input[type="range"].value` to `(target - T0) / 1000` and dispatch `input`. After each seek, poll (up to 5s, 100ms interval) for the expected condition rather than sleeping. Seek targets, all at least 250ms from any event other than the one being tested:
- `pre` = `S1 - 750` (≥ 750ms after `T0` because of the Step 2.1 gap)
- `post` = `Sn + 750` (the click is ≥ 1500ms after `Sn`)
- `click` = `C + 300` (the pointer's last recorded position is the click; the resize is ≥ 1200ms later)
- `resized` = `R + 750`

Measure:
- AC1: `.replay-container` `clientWidth` (must be < 1156), `iframe.contentWindow.innerWidth` at `pre` (must be 1156), and at `resized` (must be 1300).
- AC2 seek: at `pre`, `iframe.contentDocument.querySelector('#main').scrollTop === 0`. At `post`, it equals `Y` (±1px).
- AC2 play: seek to `pre`, click the Play button, poll `#main.scrollTop` (up to 10s) until it equals `Y` (±1px), then click Pause. Pass if reached; fail with the last observed value otherwise.
- AC3: at `click`, read `.replayer-mouse` computed `left`/`top` in px. rrweb places the recorded pointer coordinate at the element's `left`/`top`; its 20px box and click halo are drawn around that point, so do not use the bounding-box center. Map to host coordinates: `pointer = wrapperRect.origin + (left, top) × scale`, with `wrapperRect` from `.replayer-wrapper`'s `getBoundingClientRect()` and `scale` from `--replay-scale` on `.replay-container`. Map `#save`'s rect from the iframe document the same way: `iframeRect.origin + rect × scale`. The pointer must fall inside the mapped button rect.
- Screenshot the page at `post` and at `click`.

- [ ] **Step 4: Run against a pre-fix build**

In this worktree: remove the `max-width: none;` line from `ReplayPlayer.vue`, `pnpm --filter @opslane/dashboard build`, rerun `verify.mjs` into a separate results file, then restore the file with `git checkout packages/dashboard/src/components/ReplayPlayer.vue` and rebuild. Expected pre-fix: `innerWidth` equals the container width, AC2 `scrollTop` stays 0 at `post` and during play, and the AC3 pointer misses the button. If the pre-fix build passes AC2, the fixture did not reproduce #495: fix the fixture before trusting the post-fix result.

- [ ] **Step 5: Record the result**

Write `report.md`: build (fixed / pre-fix) × AC1 / AC2-seek / AC2-play / AC3, with measured values, the Step 2.5 timestamps, and screenshot paths. Confirm `git status` shows no scratch files in the repo and `dist` was rebuilt from the fixed source.

## Post-review changes

Review of the implemented plan found one gap in the same user path. rrweb 2.1.1's `Replayer` constructor applies the first Meta viewport on a 0ms timer, which overwrote the width set by `ReplayPlayer`'s synchronous initial `pause(seekMs)`. A replay opened past a mid-session resize (IncidentDetail at the error time, or a `?t=` cited-moment link) therefore laid out at the first recorded width. With the `max-width` cap gone, that wrong width became visible.

- `ReplayPlayer.vue` now defers the initial seek with `setTimeout(..., 0)`, registered after rrweb's constructor timers, and `destroyPlayer` clears it.
- `test-e2e/session-replay-viewport.test.ts` adds `opens a deep link past a mid-session resize at the resized viewport width` (failed with `expected 1156 to be 1300` before the fix) and asserts the rendered iframe still fits the container. CI pins the new test by name.
- Not changed: `E2E_MIN_TESTS` stays at 74. CI on main already collects 165 tests, so the value is a floor in practice.
