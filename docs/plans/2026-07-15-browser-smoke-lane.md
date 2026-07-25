# Deterministic Browser-Smoke CI Lane Implementation Plan

> **Superseded for replay chunks:** the presigned POST and commit flow was replaced by the single-call ingestion upload in `2026-07-24-replay-chunk-upload-r2.md`. This document remains a historical implementation record.

> **Execution:** Work task-by-task in order; each task ends in a verified state and a commit. Any agent or human can execute this — no tool-specific workflow assumed. Commit messages are intent-first sentences matching this repo's log style (e.g. "Keep deterministic reliability checks portable across CI").

**Goal:** A CI lane where a real Chromium browser drives Vue and React fixture apps with the real SDK pointed at the real (keyless) ingestion stack, deterministically asserting that a browser error becomes a `needs_human` incident and that browser rage-clicks become a `rage_click` friction signal.

**Architecture:** New browser tests live in `test-e2e/` and run inside the existing `e2e-keyless` CI job (the full compose stack is already booted there, keyless). A small harness boots a Vite dev server per fixture app, aliases `@opslane/sdk` to SDK source, and injects test config (seeded API key, real endpoint, fast flush) via the proven `inject-sdk-init` transform from `packages/sdk/src/__tests__/browser-contract.test.ts`. Assertions poll the real incidents API and the DB — no `waitForTimeout`-and-hope.

**Tech Stack:** Playwright (Chromium), Vite, Vitest, pg, existing compose stack (ingestion:8082, postgres:5434, minio:9012).

---

## Context an implementer must know (all verified against source)

**Error path (fully auto, deterministic keyless):**
browser click → SDK captures → `POST /api/v1/events` → ingestion groups → job created → keyless worker → `error_groups.status = 'needs_human'`, `reason.reason_code = 'missing_llm_key'`. This is exactly what `test-e2e/needs-human-contract.test.ts:143-226` asserts for a hand-built payload; the browser tests replace the hand-built payload with a real SDK one.

**Friction path (auto only up to signals — this is a product gap, not a plan bug):**
1. SDK: `init({ replay: { enabled: true } })` → `POST /api/v1/sessions/init` → chunk upload via presigned MinIO POST (`REPLAY_STORE_PUBLIC_ENDPOINT` = `http://localhost:9012`, reachable from a host browser) → `POST .../chunks/{seq}/commit`. Interaction telemetry (clicks) rides inside replay chunks as rrweb type-5 events tagged `opslane.telemetry` (`packages/sdk/src/replay.ts:205-211`) — replay must be enabled.
2. Chunks flush every 30s (`CHUNK_MS`, `replay.ts:13`) — **or immediately when an error event is accepted** (`flushReplayBufferForError`, `packages/sdk/src/transport.ts:133-135`). The tests use the error-trigger to avoid 30s waits.
3. Ingestion's scrubber claims chunks `uploaded_at <= now() - 30s`, every 15s (`packages/ingestion/main.go:128`, `db/sessions.go:218`). Worker reads only `scrubbed_at IS NOT NULL` chunks. Expect ~45–60s before a chunk is analyzable. Not tunable via env — poll with a generous deadline.
4. **Nothing auto-creates a `session_analysis` job in Batch 3** (`004_friction.sql:6-8`), and idle-close takes 30 min via an hourly sweeper. The test inserts the job row itself (`error_group_id` is nullable since `001_baseline.sql:449`). When auto-scheduling lands, delete the manual insert.
5. Worker (`session_analysis` handler, `packages/worker/src/index.ts:494-531`): sessions.status `analyzing` → `analyzed`; writes `friction_signals`. It does **not** create friction incidents. So the friction test asserts on `friction_signals`, not on an incident.

**Rage-click rule** (`packages/worker/src/friction/analyzer.ts:10-12, 253-257`): ≥3 clicks on the same selector, consecutive gaps ≤1000ms, and the **last** click "unanswered" — no DOM mutation (rrweb type 3 / source 0) and no click-attributed `request_start` within 1000ms after it. **Therefore: after rage-clicking, wait >1s before touching anything that mutates the DOM.**

**Selector shape:** `deriveSelector` returns `[data-testid="dead-button"]` when a `data-testid` is present (`packages/sdk/src/selector.ts:43-51`). Assert exact equality.

**CORS:** SDK endpoints (`/api/v1/events`, `/api/v1/sessions`, ...) reflect any Origin (`packages/ingestion/handler/routes.go:194-199`), so a fixture on a random localhost port can POST to `localhost:8082`. MinIO presigned POST from the browser is the one surface no test exercises today — Task 0 spikes it before anything else is built, so a CORS surprise can't invalidate later work.

**Replay readiness is asynchronous.** `init()` fire-and-forgets `startReplayCapture()` (`packages/sdk/src/index.ts:44`), which awaits a `POST /sessions/init` round-trip and then a dynamic `import('rrweb')` before installing the telemetry sink (`replay.ts:193-211`). Clicks before the sink exists are silently dropped. The friction test therefore gates on a test-only readiness hook (Task 3) instead of sleeping and hoping.

**SDK has no public `flush()`** — inject `flushInterval: 200, maxBatchSize: 1` like the SDK's own browser tests do.

**Recording is on by default** for new projects (`projects.recording_enabled DEFAULT TRUE`, `002_sessions.sql:153`) — `seedTenant` needs no change.

**Keyless gating:** copy the exact gate from `needs-human-contract.test.ts:153-156`: run only when `E2E_WORKER_NO_KEY === '1'` and no `ANTHROPIC_API_KEY`. Also skip if the Chromium **binary** is missing — detected via `chromium.executablePath()` + filesystem check, not just a successful import (an import-only check would make a missing binary explode in `beforeAll` instead of skipping). CI enforces the tests actually ran via `scripts/check-e2e-results.mjs` (unexpected skips fail; `E2E_MIN_TESTS` raised in Task 8 from a measured baseline).

---

### Task 0: Spike — browser presigned POST to MinIO (CORS)

This is the only transport seam in the whole design that nothing exercises today. Prove it works before building anything on top of it. Throwaway code; nothing is committed except (if needed) a compose/MinIO config fix.

**Step 1: Boot the stack** (recipe from Task 5 Step 1) and install Chromium.

**Step 2: Run a one-off probe script** (put it in your scratch dir, not the repo). It seeds a tenant, opens the Vue fixture through a minimal Vite server with the SDK pointed at the real stack and `replay: { enabled: true }`, triggers an error (which forces an immediate chunk upload), and then checks the DB:

```sql
SELECT seq, uploaded_at FROM session_chunks sc
  JOIN sessions s ON s.id = sc.session_id
 WHERE s.project_id = '<seeded project id>';
```

The fastest honest version: temporarily point the existing `packages/sdk/src/__tests__/replay-browser.test.ts` machinery at the real stack, or write a ~40-line script with `chromium.launch()` + `page.on('requestfailed')` logging.

**Step 3: Interpret.**
- Chunk row appears with `uploaded_at` set → the browser→MinIO presigned POST works. Proceed; delete the probe.
- Upload request fails with a CORS error in `page.on('requestfailed')` → fix MinIO CORS in compose (`MINIO_API_CORS_ALLOW_ORIGIN=*` env on the `minio` service, or `mc admin config set local api cors_allow_origin="*"` in `minio-setup`), commit that fix alone ("Let browsers upload replay chunks to compose MinIO"), and re-run the probe until green.

---

### Task 1: Vue fixture — dead-button view for friction

**Files:**
- Create: `test-fixtures/vue-app/src/components/DeadEnd.vue`
- Modify: `test-fixtures/vue-app/src/App.vue`

**Step 1: Create the component.** It must be static — no handlers, no reactive state — so clicks cause zero DOM mutations (a mutation within 1s of the last click suppresses the rage-click signal).

```vue
<script setup lang="ts">
// Intentionally inert: no handlers, no reactive state. Clicking must cause
// zero DOM mutations or the friction analyzer treats the click as "answered".
</script>

<template>
  <div>
    <p>This button does nothing.</p>
    <button data-testid="dead-button" type="button">Save changes</button>
  </div>
</template>
```

**Step 2: Wire it into `App.vue`.** Add to the nav (after the `nav-fetch` button):

```html
      <button data-testid="nav-dead" @click="currentView = 'dead'">DeadEnd</button>
```

Add the import `import DeadEnd from './components/DeadEnd.vue';` and to `<main>`:

```html
      <DeadEnd v-if="currentView === 'dead'" />
```

**Step 3: Verify the fixture builds**

Run from repo root: `pnpm --filter opslane-fixture-app build`
Expected: vite build succeeds.

**Step 4: Commit**

```bash
git add test-fixtures/vue-app
git commit -m "Give the Vue fixture an inert dead button so rage clicks stay unanswered"
```

---

### Task 2: React fixture app

**Files:**
- Create: `test-fixtures/react-app/package.json`
- Create: `test-fixtures/react-app/tsconfig.json`
- Create: `test-fixtures/react-app/vite.config.ts`
- Create: `test-fixtures/react-app/index.html`
- Create: `test-fixtures/react-app/src/main.tsx`
- Create: `test-fixtures/react-app/src/App.tsx`
- Create: `test-fixtures/react-app/src/BuggyProfile.tsx`

`test-fixtures/*` is already a workspace glob (`pnpm-workspace.yaml`), so the package joins the workspace on `pnpm install`.

**Step 1: `package.json`** (mirror the vue fixture, `test-fixtures/vue-app/package.json`):

```json
{
  "name": "opslane-fixture-react",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "license": "AGPL-3.0-only",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "echo ok"
  },
  "dependencies": {
    "@opslane/sdk": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^6.0.0"
  }
}
```

**Step 2: `tsconfig.json`** — copy `test-fixtures/vue-app/tsconfig.json` and adjust `jsx`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

(Verify against the vue fixture's actual tsconfig and keep any extra flags it has.)

**Step 3: `vite.config.ts`:**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
```

**Step 4: `index.html`:**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Opslane React Fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 5: `src/main.tsx`** — the `init({...});` block MUST match the regex `/init\(\{[\s\S]*?\}\);/` that the harness transform replaces (same contract as `test-fixtures/vue-app/src/main.ts`):

```tsx
import { createRoot } from 'react-dom/client';
import { init } from '@opslane/sdk';
import { OpslaneErrorBoundary } from '@opslane/sdk/react';
import { App } from './App';

init({
  endpoint: 'http://localhost:8082',
  apiKey: 'e2e-test-key-plaintext',
  release: 'e2e-react-fixture-v1',
  replay: { enabled: true },
});

createRoot(document.getElementById('root')!).render(
  <OpslaneErrorBoundary fallback={<p data-testid="boundary-fallback">Something broke</p>}>
    <App />
  </OpslaneErrorBoundary>
);
```

**Step 6: `src/App.tsx` and `src/BuggyProfile.tsx`.** The bug: clicking sets state so the next render reads a property of `null` — a render-phase throw that `OpslaneErrorBoundary.componentDidCatch` captures (`packages/sdk/src/react.tsx:19-29`), covering the React integration path specifically.

```tsx
// App.tsx
import { useState } from 'react';
import { BuggyProfile } from './BuggyProfile';

export function App() {
  const [view, setView] = useState('home');
  return (
    <div>
      <nav>
        <button data-testid="nav-home" onClick={() => setView('home')}>Home</button>
        <button data-testid="nav-profile" onClick={() => setView('profile')}>Profile</button>
      </nav>
      <main>
        {view === 'home' && <p>Select a bug to trigger</p>}
        {view === 'profile' && <BuggyProfile />}
      </main>
    </div>
  );
}
```

```tsx
// BuggyProfile.tsx
import { useState } from 'react';

interface Profile { displayName: string }

export function BuggyProfile() {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  if (profile === null) {
    // Render-phase throw: TypeError reading 'displayName' of null.
    return <p>{(profile as unknown as Profile).displayName.toUpperCase()}</p>;
  }
  return (
    <button data-testid="load-profile-btn" onClick={() => setProfile(null)}>
      Load profile
    </button>
  );
}
```

**Step 7: Install and build**

Run: `pnpm install` then `pnpm --filter opslane-fixture-react build`
Expected: install links the workspace package; vite build succeeds.

**Step 8: Run the license boundary check** (fixtures are AGPL; this guards against accidental MIT leakage): `node scripts/check-licenses.mjs`
Expected: passes.

**Step 9: Commit**

```bash
git add test-fixtures/react-app pnpm-lock.yaml
git commit -m "Cover the React error-boundary capture path with a browser fixture"
```

---

### Task 3: SDK replay-ready hook + browser harness in test-e2e

**Files:**
- Modify: `packages/sdk/src/replay.ts`
- Modify: `test-e2e/package.json`
- Create: `test-e2e/browser-helpers.ts`

**Step 0a: Add a test-only readiness hook to the SDK.** Precedent: `transport.ts` already exports test-only hooks (`getQueueLength`, `_resetQueue`). Append to `packages/sdk/src/replay.ts`:

```ts
/** Test-only: true once rrweb record() is active and the telemetry sink is
 *  installed — i.e. clicks from this point on land in replay chunks. */
export function _replayStarted(): boolean {
  return replayInstalled && stopFn !== null;
}
```

(`stopFn` is assigned only after `record()` succeeded, which is after `setTelemetrySink` — so `stopFn !== null` implies the sink is live. Verify those lines still hold: `replay.ts:205-228`.)

**Step 0b: Verify the SDK:** `pnpm --filter @opslane/sdk build && pnpm --filter @opslane/sdk test` — green, including the real-browser contract tests executing rather than skipping (SDK `AGENTS.md` requirement).

**Step 0c: Commit:**

```bash
git add packages/sdk/src/replay.ts
git commit -m "Expose a test-only replay-readiness hook so browser tests can gate on it"
```

**Step 1: Add devDependencies** to `test-e2e/package.json` (versions matched to `packages/sdk/package.json` devDeps — check and mirror them exactly):

```json
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "@playwright/test": "<same major as packages/sdk>",
    "@vitejs/plugin-react": "^4.3.0",
    "@vitejs/plugin-vue": "^5.0.0",
    "vite": "^6.0.0",
    "vitest": "^3.2.0"
  }
```

Run `pnpm install`.

**Step 2: Create `test-e2e/browser-helpers.ts`.** This generalizes the proven pattern from `packages/sdk/src/__tests__/browser-contract.test.ts:84-126`: Vite dev server rooted at the fixture, `@opslane/sdk` aliased to SDK **source** (no build-order dependency; Vite compiles the TS), and an `inject-sdk-init` transform that swaps the fixture's `init({...});` block for test config with the seeded API key and real endpoint.

```ts
/**
 * Browser-smoke harness: boots a fixture app under Vite with the SDK aliased
 * to source and init() config injected (real ingestion endpoint + seeded key).
 */
import { resolve } from 'node:path';
import type { PluginOption } from 'vite';

const SDK_SRC = resolve(__dirname, '../packages/sdk/src');

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

export async function startFixture(opts: {
  fixtureDir: string;            // absolute path to the fixture app
  apiKey: string;                // seeded tenant key
  ingestionUrl: string;          // e.g. http://localhost:8082
  entryPattern: RegExp;          // /\/main\.tsx?$/ — file whose init() block gets replaced
  plugins: PluginOption[];       // [vue()] or [react()]
}): Promise<FixtureServer> {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: opts.fixtureDir,
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: [
        // Order matters: subpaths before the bare specifier.
        { find: '@opslane/sdk/react', replacement: resolve(SDK_SRC, 'react.tsx') },
        { find: '@opslane/sdk/_replay', replacement: resolve(SDK_SRC, 'replay.ts') },
        { find: '@opslane/sdk', replacement: resolve(SDK_SRC, 'index.ts') },
      ],
    },
    server: { port: 0 },
    plugins: [
      ...opts.plugins,
      {
        name: 'inject-sdk-init',
        transform(code: string, id: string) {
          if (opts.entryPattern.test(id)) {
            const replaced = code.replace(
              /init\(\{[\s\S]*?\}\);/,
              `init({
                endpoint: '${opts.ingestionUrl}',
                apiKey: '${opts.apiKey}',
                flushInterval: 200,
                maxBatchSize: 1,
                replay: { enabled: true },
              });`
            );
            // Replay starts asynchronously (session registration + dynamic
            // rrweb import) — expose readiness so tests can gate on it
            // instead of sleeping (see plan context; index.ts:44).
            return [
              `import { _replayStarted as __opslaneReplayStarted } from '@opslane/sdk/_replay';`,
              replaced,
              `const __opslaneReadyTimer = setInterval(() => {`,
              `  if (__opslaneReplayStarted()) {`,
              `    (window as unknown as { __opslaneReplayReady?: boolean }).__opslaneReplayReady = true;`,
              `    clearInterval(__opslaneReadyTimer);`,
              `  }`,
              `}, 50);`,
            ].join('\n');
          }
        },
      },
    ],
  });
  await server.listen();
  const port = server.config.server.port;
  return {
    url: `http://localhost:${port}`,
    close: () => server.close(),
  };
}

export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    const pw = await import('@playwright/test');
    // Import success is not enough: the chromium BINARY may be missing, and
    // that would fail beforeAll instead of skipping. Check the executable.
    const { existsSync } = await import('node:fs');
    const path = pw.chromium.executablePath();
    return !!path && existsSync(path);
  } catch {
    return false;
  }
}
```

Note: this is deliberately stricter than the SDK's own import-only detection (`browser-contract.test.ts:6-16`) — a missing binary skips locally instead of exploding in `beforeAll`. In CI the skip is still caught: these tests are not in `E2E_ALLOWED_SKIP_PATTERN`, so `check-e2e-results.mjs` fails the job on any skip.

**Step 3: Type-check the package**

Run: `pnpm --filter @opslane/test-e2e exec tsc --noEmit`
Expected: clean. (If `test-e2e/tsconfig.json` excludes new files, add them.)

**Step 4: Commit**

```bash
git add test-e2e/package.json test-e2e/browser-helpers.ts pnpm-lock.yaml
git commit -m "Let E2E tests drive fixture apps through a real browser against the real stack"
```

---

### Task 4: DB helpers for the friction path

**Files:**
- Modify: `test-e2e/helpers.ts`

**Step 1: Add session/friction helpers** (append to `helpers.ts`; schemas verified against `002_sessions.sql`, `004_friction.sql`, `001_baseline.sql:111-124,371,449`):

```ts
// ---------------------------------------------------------------------------
// Session / friction helpers (browser smoke)
// ---------------------------------------------------------------------------

/** Polls until the project has a session (created by SDK /sessions/init). */
export async function pollSessionForProject(
  projectId: string,
  timeoutMs = 30_000
): Promise<string> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM sessions WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (rows[0]) return rows[0].id;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`No session appeared for project ${projectId} within ${timeoutMs}ms`);
}

/** Polls until at least one chunk for the session is scrubbed (analyzable).
 *  Scrubber cadence: eligible 30s after upload, swept every 15s — expect ~45-60s. */
export async function pollScrubbedChunk(
  sessionId: string,
  timeoutMs = 120_000
): Promise<void> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT 1 FROM session_chunks WHERE session_id = $1 AND scrubbed_at IS NOT NULL LIMIT 1`,
      [sessionId]
    );
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`No scrubbed chunk for session ${sessionId} within ${timeoutMs}ms`);
}

/** Batch 3 gap: the product does not yet auto-create session_analysis jobs
 *  (see 004_friction.sql header). Insert one directly; delete this helper when
 *  auto-scheduling lands. */
export async function insertSessionAnalysisJob(
  projectId: string,
  sessionId: string
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO error_group_jobs (project_id, session_id, job_type, status, triggered_by)
     VALUES ($1, $2, 'session_analysis', 'pending', 'auto')`,
    [projectId, sessionId]
  );
}

/** Polls sessions.status until it reaches one of the given values. */
export async function pollSessionStatus(
  sessionId: string,
  statuses: string[],
  timeoutMs = 60_000
): Promise<string> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM sessions WHERE id = $1`,
      [sessionId]
    );
    last = rows[0]?.status ?? '(missing)';
    if (statuses.includes(last)) return last;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Session ${sessionId} stuck at '${last}' after ${timeoutMs}ms`);
}

export interface FrictionSignalRow {
  signal_type: string;
  element_selector: string | null;
  occurrence_count: number;
}

/** Active (non-retracted, non-superseded) friction signals for a session. */
export async function getActiveFrictionSignals(
  sessionId: string
): Promise<FrictionSignalRow[]> {
  const db = getPool();
  const { rows } = await db.query<FrictionSignalRow>(
    `SELECT signal_type, element_selector, occurrence_count
       FROM friction_signals
      WHERE session_id = $1 AND retracted_at IS NULL AND superseded_by IS NULL`,
    [sessionId]
  );
  return rows;
}
```

**Step 2: Extend `cleanupTenant`.** Browser tests create `sessions` rows (with cascading `session_chunks` and `friction_signals`). In `cleanupTenant` (`helpers.ts:340`), after the `error_group_jobs` delete, add:

```ts
  // Sessions cascade to session_chunks and friction_signals (ON DELETE CASCADE).
  await db.query(
    `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
```

If the delete fails on an FK (e.g. `end_users`), inspect `002_sessions.sql` for the offending table and delete it in the same scoped style — do not disable constraints.

**Step 3: Type-check:** `pnpm --filter @opslane/test-e2e exec tsc --noEmit` — clean.

**Step 4: Commit**

```bash
git add test-e2e/helpers.ts
git commit -m "Make the friction pipeline pollable from E2E tests"
```

---

### Task 5: Browser error smoke — Vue

**Files:**
- Create: `test-e2e/browser-smoke.test.ts`

**Step 1: Boot the keyless stack locally** (same recipe as the `e2e-keyless` CI job, `ci.yml:178-184`):

```bash
docker compose up -d postgres minio minio-setup
docker compose run --rm migrate
docker compose up -d --build --wait ingestion worker
pnpm --filter @opslane/sdk exec playwright install --with-deps chromium
```

Confirm the worker is keyless: `docker compose exec -T worker sh -c '[ -z "$ANTHROPIC_API_KEY" ]'` (exit 0).

**Step 2: Write the test.** Gate identically to `needs-human-contract.test.ts` plus the Playwright check.

```ts
// @vitest-environment node
/**
 * Browser smoke: a real Chromium drives the fixture apps with the real SDK
 * pointed at the real keyless stack. Proves the whole seam the API-level E2E
 * suite can't: real SDK payloads are accepted, grouped, and driven to a
 * terminal state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import {
  getConfig, seedTenant, cleanupTenant, closePool,
  listIncidents, pollUntilTerminal,
  type TestTenant, type Incident,
} from './helpers.js';
import { startFixture, isPlaywrightAvailable, type FixtureServer } from './browser-helpers.js';

const hasLLMKey = !!process.env['ANTHROPIC_API_KEY'];
const keylessWorkerRunning = process.env['E2E_WORKER_NO_KEY'] === '1';
const playwrightAvailable = await isPlaywrightAvailable();

const VUE_FIXTURE = resolve(__dirname, '../test-fixtures/vue-app');

async function pollIncidentMatching(
  tenant: TestTenant,
  predicate: (i: Incident) => boolean,
  timeoutMs = 60_000
): Promise<Incident> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const incidents = await listIncidents(tenant.apiKey, tenant.projectId);
    const hit = incidents.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 2_000));
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
        apiKey: tenant.apiKey,
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

    it('real Vue SDK error reaches needs_human with missing_llm_key', async () => {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      await page.click('[data-testid="nav-usercard"]');
      await page.click('[data-testid="edit-profile-btn"]');

      // Incident appears via real grouping of the real SDK payload.
      const incident = await pollIncidentMatching(
        tenant,
        (i) => i.title.toLowerCase().includes('null')
      );
      expect(incident.status).toBeTruthy();

      const terminal = await pollUntilTerminal(
        tenant.apiKey, tenant.projectId, incident.id, ['needs_human'], 90_000
      );
      expect(terminal.status).toBe('needs_human');
      expect(terminal.reason?.reason_code).toBe('missing_llm_key');
      expect(terminal.reason?.reason_message).toBeTruthy();
      expect(terminal.reason?.remediation).toBeTruthy();
      await page.close();
    }, 180_000);
  }
);
```

Adjust the title predicate after the first live run: the fixture's UserCard bug throws a TypeError reading a property of `null` — verify the actual `title` the incident gets (it derives from the error message) and pin the predicate to something stable from it. Keep it a substring match, not exact.

**Step 3: Run it to verify it fails first** (before Tasks 1–4 land it fails on missing imports; after them, first run may fail on the title predicate — that's the calibration step):

```bash
DATABASE_URL=postgres://opslane:opslane_dev@localhost:5434/opslane \
INGESTION_URL=http://localhost:8082 \
E2E_WORKER_NO_KEY=1 \
pnpm --filter @opslane/test-e2e exec vitest run browser-smoke
```

**Step 4: Fix predicate if needed, re-run until PASS.** Paste the real terminal incident JSON into the PR description as evidence.

**Step 5: Commit**

```bash
git add test-e2e/browser-smoke.test.ts
git commit -m "Prove a real Vue browser error reaches needs_human keylessly"
```

---

### Task 6: Browser error smoke — React

**Files:**
- Modify: `test-e2e/browser-smoke.test.ts`

**Step 1: Add a second describe block** (same gates), booting the React fixture:

```ts
const REACT_FIXTURE = resolve(__dirname, '../test-fixtures/react-app');

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
        apiKey: tenant.apiKey,
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
      // closePool() is called once by the last suite teardown; harmless if repeated.
    });

    it('React error-boundary error reaches needs_human with missing_llm_key', async () => {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      await page.click('[data-testid="nav-profile"]');
      await page.click('[data-testid="load-profile-btn"]');
      // Boundary fallback proves componentDidCatch ran (the capture path under test).
      await page.waitForSelector('[data-testid="boundary-fallback"]');

      const incident = await pollIncidentMatching(
        tenant,
        (i) => i.title.toLowerCase().includes('displayname') || i.title.toLowerCase().includes('null')
      );
      const terminal = await pollUntilTerminal(
        tenant.apiKey, tenant.projectId, incident.id, ['needs_human'], 90_000
      );
      expect(terminal.status).toBe('needs_human');
      expect(terminal.reason?.reason_code).toBe('missing_llm_key');
      await page.close();
    }, 180_000);
  }
);
```

Note on `closePool()`: it lives in one shared module — make sure only the **final** `afterAll` in the file calls it, or make `closePool` idempotent-safe for repeated calls (it already nulls the pool; calling `getPool` again recreates it, so calling it in each suite is safe — verify once locally).

**Step 2: Run:** same command as Task 5. Expected: both suites PASS. Calibrate the React title predicate from the real incident on first run, same as Task 5.

**Step 3: Commit**

```bash
git add test-e2e/browser-smoke.test.ts
git commit -m "Prove a React boundary error reaches needs_human keylessly"
```

---

### Task 7: Friction smoke — rage click to friction signal

**Files:**
- Create: `test-e2e/friction-smoke.test.ts`

**Step 1: Write the test.** Sequence and the reasons for each wait:

```ts
// @vitest-environment node
/**
 * Friction smoke: real rage-clicks in Chromium produce rrweb telemetry inside
 * replay chunks; the real scrubber and the real analyzer turn them into a
 * rage_click friction signal.
 *
 * Batch 3 gap (004_friction.sql): nothing auto-creates the session_analysis
 * job yet, so this test inserts it directly. When auto-scheduling lands,
 * remove insertSessionAnalysisJob and let the product drive it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import {
  getConfig, seedTenant, cleanupTenant, closePool,
  pollSessionForProject, pollScrubbedChunk, insertSessionAnalysisJob,
  pollSessionStatus, getActiveFrictionSignals,
  type TestTenant,
} from './helpers.js';
import { startFixture, isPlaywrightAvailable, type FixtureServer } from './browser-helpers.js';

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
        apiKey: tenant.apiKey,
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
      await page.goto(fixture.url);

      // Gate on replay readiness: the telemetry sink installs only after the
      // async /sessions/init round-trip and the dynamic rrweb import
      // (replay.ts:193-211). Clicks before that are silently dropped — under
      // CI load a sleep is not a guarantee, so wait for the injected marker.
      await page.waitForFunction(
        () => (window as unknown as { __opslaneReplayReady?: boolean }).__opslaneReplayReady === true,
        undefined,
        { timeout: 30_000 }
      );

      // Navigate to the inert view, then let render mutations settle so the
      // rage cluster is clean.
      await page.click('[data-testid="nav-dead"]');
      await page.waitForTimeout(500);

      // Rage cluster: >=3 clicks, same selector, gaps <=1s (analyzer.ts:10-12).
      for (let i = 0; i < 5; i++) {
        await page.click('[data-testid="dead-button"]');
        await page.waitForTimeout(100);
      }

      // The LAST click must stay "unanswered": no DOM mutation and no
      // click-attributed request within 1s after it (analyzer.ts:231-257).
      await page.waitForTimeout(1_500);

      // Trigger an error: flushReplayBufferForError uploads the replay chunk
      // (with the telemetry above) immediately instead of on the 30s cadence.
      await page.click('[data-testid="nav-usercard"]');
      await page.click('[data-testid="edit-profile-btn"]');

      // Real chunk pipeline: presigned MinIO POST + commit, then the scrubber
      // (eligible 30s after upload, swept every 15s).
      const sessionId = await pollSessionForProject(tenant.projectId);
      await pollScrubbedChunk(sessionId, 120_000);

      // Batch 3 gap: drive the analysis ourselves (see file header).
      await insertSessionAnalysisJob(tenant.projectId, sessionId);
      const status = await pollSessionStatus(sessionId, ['analyzed', 'analysis_failed'], 90_000);
      expect(status).toBe('analyzed');

      const signals = await getActiveFrictionSignals(sessionId);
      const rage = signals.find((s) => s.signal_type === 'rage_click');
      expect(rage).toBeDefined();
      expect(rage!.element_selector).toBe('[data-testid="dead-button"]');
      await page.close();
    }, 300_000);
  }
);
```

**Step 2: Run it** (stack still up from Task 5):

```bash
DATABASE_URL=postgres://opslane:opslane_dev@localhost:5434/opslane \
INGESTION_URL=http://localhost:8082 \
E2E_WORKER_NO_KEY=1 \
pnpm --filter @opslane/test-e2e exec vitest run friction-smoke
```

Expected: PASS in roughly 60–120s (dominated by the scrubber's 30s+15s cadence).

**Debugging guide if it fails, in causal order:**
1. `waitForFunction` timeout → replay never became ready: check `page.on('console')` / `page.on('requestfailed')`; verify the injected config kept `replay: { enabled: true }` and `/sessions/init` returned `{recording: true}`.
2. Session but no chunk row → presigned MinIO POST from the browser failed: log network with `page.on('response')`. Task 0 proved this surface works, so suspect a regression in compose/MinIO config since the spike.
3. Chunk never scrubbed → scrubber not running or erroring: `docker compose logs ingestion | grep -i scrub`.
4. `analysis_failed` → worker logs: `docker compose logs worker`.
5. Signal missing or `dead_click` instead of `rage_click` → a mutation "answered" the last click (something in the fixture view isn't inert) or click gaps exceeded 1s (raise from 5 clicks / tighten the loop).

**Step 3: Commit**

```bash
git add test-e2e/friction-smoke.test.ts
git commit -m "Prove real rage clicks become a rage_click signal through the replay pipeline"
```

---

### Task 8: CI wiring and skip enforcement

**Files:**
- Modify: `.github/workflows/ci.yml` (the `e2e-keyless` job, lines 153–218)

**Step 1: Install Chromium in the keyless job.** After the `pnpm install --frozen-lockfile` step (`ci.yml:171`), add:

```yaml
      - name: Install Playwright chromium (browser smoke)
        run: pnpm --filter @opslane/test-e2e exec playwright install --with-deps chromium
```

**Step 2: Raise the floor from a MEASURED baseline — do not do arithmetic on the old floor.** The current floor of 15 is stale: the suite already collects 24 tests (12 plain `it(` plus 12 expanded from `it.each(REASON_CODES)` in `needs-human-contract.test.ts:31-92`), so a floor of 15+3 would pass even with every browser test silently uncollected. Instead:

1. Run the full suite locally with `--reporter=json` (Step 3 command) and read `numTotalTests` from the JSON — this is the authoritative baseline including the allowlisted skip. Expected: 27 (24 existing + 3 new).
2. Set `E2E_MIN_TESTS` at `ci.yml:198` to exactly that measured number, and record the measurement in the commit message.

Do NOT add the new tests to `E2E_ALLOWED_SKIP_PATTERN` — if they skip in CI (Playwright missing, gates wrong), `check-e2e-results.mjs` must fail the job. That guard is what makes silent-skip impossible.

**Step 3: Verify the results-check locally** against the JSON from a full local run:

```bash
DATABASE_URL=postgres://opslane:opslane_dev@localhost:5434/opslane \
INGESTION_URL=http://localhost:8082 \
E2E_WORKER_NO_KEY=1 \
pnpm --filter @opslane/test-e2e exec vitest run \
  --reporter=default --reporter=json --outputFile=/tmp/e2e-results.json
E2E_ALLOWED_SKIP_PATTERN='^pr_created pipeline \(full flow\)' E2E_MIN_TESTS=<measured> \
  node scripts/check-e2e-results.mjs /tmp/e2e-results.json
```

Expected: `OK` line, `numTotalTests` matching the measured baseline (expected 27), only the allowed skip.

**Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Gate CI on the browser smoke tests actually running"
```

---

### Task 9: Full verification and teardown

**Step 1: Full repo gate** (root `AGENTS.md`):

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
node scripts/check-licenses.mjs
```

**Step 2: Full keyless lane end-to-end** (Task 8 Step 3 commands, from a clean stack: `docker compose down -v` first, then the boot recipe from Task 5 Step 1). All 18+ tests pass, results-check OK.

**Step 3: Push the branch and confirm the `e2e-keyless` job passes in CI** — the local Docker environment and GitHub runners differ (this lane exists precisely to catch environment-shaped drift).

**Step 4: Teardown:** `docker compose down -v`

---

## Explicitly out of scope (follow-ups, do not do here)

1. **Auto-creating `session_analysis` jobs in the product** (ingestion, on session close or first scrub). When it lands, delete `insertSessionAnalysisJob` and let the friction test ride the product path — the test then gets strictly stronger.
2. **Friction incident creation** (signals → `error_groups` with `kind='friction'`) — Batch 4+. When it exists, extend the friction test to poll the incidents API for `kind === 'friction'` instead of reading `friction_signals`.
3. **AI-driven exploratory browser testing** — nightly, in `eval/`, never a merge gate.
4. Dead-click and form-abandon browser scenarios — add after rage_click proves stable in CI for a week.
