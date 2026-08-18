// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeDebugId } from '../packages/sdk/src/build/debug-id.js';
import { closePool, getConfig, getPool, seedTenant, type TestTenant } from './helpers.js';
import { isPlaywrightAvailable } from './browser-helpers.js';
import { startBuiltFixture } from './build-helpers.js';

// Two tenants seeded at run time, the way every other suite here gets its
// credentials. An earlier revision hardcoded the UUIDs and keys from
// scripts/seed-e2e.sql, which is a local-dev convenience applied by hand --
// nothing in CI runs it, so every upload came back 401 and the isolation
// assertion could only ever pass on a machine where someone had seeded first.
let tenantA: TestTenant;
let tenantB: TestTenant;

const FIXTURE = resolve(__dirname, '../test-fixtures/vue-app');
const playwrightAvailable = await isPlaywrightAvailable();

interface ResolutionRow {
  resolution_status: string;
  stack_trace_resolved: unknown;
}

async function pollResolution(
  projectID: string,
  startedAt: Date,
  timeoutMs = 90_000,
): Promise<ResolutionRow> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.query<ResolutionRow>(
      `SELECT resolution_status, stack_trace_resolved
       FROM error_events
       WHERE project_id = $1 AND created_at > $2
         AND resolution_status IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [projectID, startedAt],
    );
    if (result.rows[0]) return result.rows[0];
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 1_000));
  }
  throw new Error(`resolution did not complete for ${projectID}`);
}

async function postCraftedEvent(
  key: string,
  debugID: string,
  message: string,
): Promise<Response> {
  return fetch(`${getConfig().ingestionUrl}/api/v1/events`, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      error: {
        type: 'Error',
        message,
        stack: `Error: ${message}\n    at run (https://fixture.example/assets/known.js:1:1)`,
      },
      breadcrumbs: [],
      context: { url: 'https://fixture.example/' },
      sdk_version: 'e2e',
      debug_meta: {
        images: [{
          type: 'sourcemap',
          code_file: 'https://fixture.example/assets/known.js',
          debug_id: debugID,
        }],
      },
    }),
  });
}

describe.skipIf(!playwrightAvailable).sequential(
  'source maps resolve end to end',
  () => {
    beforeAll(async () => {
      // Fresh projects per run, so no cleanup is needed: their sourcemap_files
      // and error_events start empty by construction.
      tenantA = await seedTenant();
      tenantB = await seedTenant();
    });

    afterAll(async () => {
      await closePool();
    });

    // Capture boundary (Slice 2): resolution_status was stamped by the
    // investigate job, which ingest no longer enqueues. The dedicated
    // stack_resolve worker lands in Slice 3 and resumes this flow.
    it.skip('uploads build maps, removes public artifacts, and resolves a browser event [suspended until Slice 3]', async () => {
      const startedAt = new Date();
      const fixture = await startBuiltFixture({
        fixtureDir: FIXTURE,
        apiKey: tenantA.ingestKey,
        ingestionUrl: getConfig().ingestionUrl,
        sourcemapKey: tenantA.sourceMapKey,
      });
      const { chromium } = await import('@playwright/test');
      const browser = await chromium.launch();
      try {
        const rows = await getPool().query<{ debug_id: string }>(
          `SELECT debug_id FROM sourcemap_files
           WHERE project_id = $1 AND created_at > $2`,
          [tenantA.projectId, startedAt],
        );
        expect(rows.rowCount).toBeGreaterThan(0);

        const files = readdirSync(fixture.outDir, { recursive: true }) as string[];
        expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
        for (const file of files.filter((candidate) => /\.(?:js|mjs)$/.test(candidate))) {
          const hasSourceMapDirective = readFileSync(join(fixture.outDir, file), 'utf8')
            .split(/\r?\n/)
            .some((line) => /^(?:\/\/[@#]|\/\*[@#])\s*sourceMappingURL\s*=/.test(line.trim()));
          expect(
            hasSourceMapDirective,
            `${file} must not publish a sourceMappingURL directive`,
          ).toBe(false);
        }

        const page = await browser.newPage();
        await page.goto(fixture.url);
        const posted = page.waitForResponse(
          (response) => response.url().endsWith('/api/v1/events')
            && response.request().method() === 'POST',
          { timeout: 20_000 },
        );
        await page.click('[data-testid="debug-id-eager"]');
        expect((await posted).status()).toBe(202);

        const event = await pollResolution(tenantA.projectId, startedAt);
        expect(event.resolution_status).toBe('resolved');
        const envelope = event.stack_trace_resolved as {
          version: number;
          frames: {
            original_file: string;
            original_line: number;
            source_snippet: string | null;
          }[];
        };
        expect(envelope.version).toBe(1);
        expect(envelope.frames[0]?.original_file).toMatch(/^src\//);
        expect(envelope.frames[0]?.original_line).toBeGreaterThan(0);
        expect(envelope.frames[0]?.source_snippet).toBeTruthy();
        await page.close();
      } finally {
        await browser.close();
        await fixture.close();
      }
    }, 180_000);

    it('enforces the credential and no-read-path privacy floor', async () => {
      const map = JSON.stringify({
        version: 3, sources: ['src/a.ts'], sourcesContent: ['x'],
        names: [], mappings: 'AAAA',
      });
      const { debugId } = await computeDebugId(new TextEncoder().encode(map));
      const denied = await fetch(
        `${getConfig().ingestionUrl}/api/v1/sourcemaps/${debugId}`,
        { method: 'PUT', headers: { 'X-API-Key': tenantA.ingestKey }, body: map },
      );
      expect(denied.status).toBe(403);
      expect((await denied.json() as { code: string }).code).toBe('insufficient_scope');

      const eventDenied = await fetch(`${getConfig().ingestionUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'X-API-Key': tenantA.sourceMapKey, 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(eventDenied.status).toBe(403);

      const read = await fetch(
        `${getConfig().ingestionUrl}/api/v1/sourcemaps/${debugId}`,
      );
      expect([404, 405]).toContain(read.status);
    });

    // Capture boundary (Slice 2): see the resolution suspension above.
    it.skip('isolates identical debug IDs by project [suspended until Slice 3]', async () => {
      const map = JSON.stringify({
        version: 3,
        sources: ['src/known.ts'],
        sourcesContent: ['export function run() { throw new Error("known"); }'],
        names: [],
        mappings: 'AAAA',
      });
      const { debugId } = await computeDebugId(new TextEncoder().encode(map));
      const upload = async (key: string) => fetch(
        `${getConfig().ingestionUrl}/api/v1/sourcemaps/${debugId}`,
        { method: 'PUT', headers: { 'X-API-Key': key }, body: map },
      );

      expect([200, 201]).toContain((await upload(tenantA.sourceMapKey)).status);
      const firstStart = new Date();
      expect((await postCraftedEvent(tenantB.ingestKey, debugId, `isolation-before-${Date.now()}`)).status).toBe(202);
      expect((await pollResolution(tenantB.projectId, firstStart)).resolution_status).toBe('map_not_found');

      expect([200, 201]).toContain((await upload(tenantB.sourceMapKey)).status);
      const secondStart = new Date();
      expect((await postCraftedEvent(tenantB.ingestKey, debugId, `isolation-after-${Date.now()}`)).status).toBe(202);
      expect((await pollResolution(tenantB.projectId, secondStart)).resolution_status).toBe('resolved');

      const stored = await getPool().query<{ object_key: string }>(
        `SELECT object_key FROM sourcemap_files
         WHERE project_id = $1 AND debug_id = $2`,
        [tenantB.projectId, debugId],
      );
      expect(stored.rows[0]?.object_key).toContain(`sourcemaps/${tenantB.projectId}/`);
    }, 180_000);
  },
);
