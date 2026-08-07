// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Breadcrumb } from '@opslane/shared';
import { clearBreadcrumbs } from '../breadcrumbs';
import { clearNetworkTimings, finalizeTiming, startTiming } from '../network-timing';
import { loadConfig } from '../config';
import { buildPayload, clearUser, setUser } from '../core';
import { resetSessionId } from '../session';
import { _resetThrottle } from '../throttle';
import { _resetQueue, enqueueEvent, flushEvents } from '../transport';
import { TEST_PK } from './test-keys';
import {
  COMMIT_SHA_GLOBAL,
  REGISTRY_GLOBAL,
} from '../build/registry-contract';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '../../../../test-fixtures/wire/events');
const WIRE_FIXTURE_VERSION = '4.1.0';

function loadFixture(kind: 'minimal' | 'full'): unknown {
  return JSON.parse(
    readFileSync(join(fixtureDir, `v${WIRE_FIXTURE_VERSION}-${kind}.json`), 'utf8'),
  );
}

const FIXTURE_MESSAGE = "Cannot read properties of null (reading 'name')";
const FIXTURE_STACK =
  "TypeError: Cannot read properties of null (reading 'name')\n    at UserCard (https://app.example.com/assets/index.js:8:20)";
const SENTINEL = '<volatile>';

// Replace values that legitimately vary between the authored fixture and this
// node test. Deep equality still locks every key, nesting level, and array shape.
function normalize(input: unknown): unknown {
  const value = structuredClone(input) as Record<string, unknown>;
  const context = value.context as Record<string, unknown> | undefined;
  // `sdk_version` is injected from package.json at build time, so a literal
  // comparison here is really a comparison between package.json and a number
  // we typed into the fixture by hand. It passes only while the two happen to
  // agree, and every release bump breaks it inside the release PR. The value
  // is asserted directly against package.json below instead, which is the
  // property worth holding; ingestion still replays each fixture literally, so
  // the frozen side is unchanged.
  if (typeof value.sdk_version === 'string') value.sdk_version = SENTINEL;
  if (typeof value.timestamp === 'string') value.timestamp = SENTINEL;
  if (typeof value.session_id === 'string') value.session_id = SENTINEL;
  if (context && typeof context.url === 'string') context.url = SENTINEL;
  if (context && typeof context.user_agent === 'string') context.user_agent = SENTINEL;
  if (Array.isArray(value.breadcrumbs)) {
    for (const breadcrumb of value.breadcrumbs as Array<Record<string, unknown>>) {
      if (breadcrumb && typeof breadcrumb.timestamp === 'string') breadcrumb.timestamp = SENTINEL;
    }
  }
  if (Array.isArray(value.network_timings)) {
    for (const timing of value.network_timings as Array<Record<string, unknown>>) {
      if (!timing) continue;
      if (typeof timing.started_at_ms === 'number') timing.started_at_ms = SENTINEL;
      if (typeof timing.duration_ms === 'number') timing.duration_ms = SENTINEL;
      if (typeof timing.ttfb_ms === 'number') timing.ttfb_ms = SENTINEL;
    }
  }
  return value;
}

async function captureWire(event: ReturnType<typeof buildPayload>): Promise<unknown> {
  let body = '';
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    body = init.body;
    return { ok: true } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    enqueueEvent(event);
    await flushEvents();
  } finally {
    vi.unstubAllGlobals();
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return JSON.parse(body);
}

describe('SDK emits the frozen wire shape', () => {
  beforeEach(() => {
    _resetQueue();
    _resetThrottle();
    clearBreadcrumbs();
    clearNetworkTimings();
    clearUser();
    delete (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
    delete (globalThis as Record<string, unknown>)[COMMIT_SHA_GLOBAL];
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
    delete (globalThis as Record<string, unknown>)[COMMIT_SHA_GLOBAL];
  });

  // The half of `sdk_version` worth testing: that the build really substitutes
  // it, rather than shipping the `0.0.0-dev` fallback. Checked against
  // package.json, the actual source of truth, so a release bump cannot break it.
  it('puts the package version on the wire', async () => {
    resetSessionId();
    loadConfig({
      apiKey: TEST_PK,
      endpoint: 'https://api.test',
      maxBreadcrumbs: 0,
      maxBatchSize: 100,
      errorThrottleMs: 0,
      release: '',
    });
    const declared = JSON.parse(
      readFileSync(join(here, '../../package.json'), 'utf8'),
    ) as { version: string };

    const breadcrumb: Breadcrumb = {
      type: 'error',
      timestamp: new Date().toISOString(),
      category: 'error',
      message: 'boot',
    };

    const wire = (await captureWire(
      buildPayload('TypeError', FIXTURE_MESSAGE, FIXTURE_STACK, breadcrumb),
    )) as Record<string, unknown>;

    expect(wire.sdk_version).toBe(declared.version);
    expect(wire.sdk_version).not.toBe('0.0.0-dev');
  });

  it('minimal payload matches the frozen fixture', async () => {
    resetSessionId();
    loadConfig({
      apiKey: TEST_PK,
      endpoint: 'https://api.test',
      maxBreadcrumbs: 0,
      maxBatchSize: 100,
      errorThrottleMs: 0,
      release: '',
    });
    const breadcrumb: Breadcrumb = {
      type: 'error',
      timestamp: new Date().toISOString(),
      category: 'error',
      message: 'boot',
    };

    const wire = await captureWire(buildPayload('TypeError', FIXTURE_MESSAGE, FIXTURE_STACK, breadcrumb));
    expect(normalize(wire)).toEqual(normalize(loadFixture('minimal')));
  });

  it('full payload matches the frozen fixture', async () => {
    (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL] = {
      'https://app.example.com/assets/index.js': [
        '01234567-89ab-cdef-0123-456789abcdef',
      ],
    };
    (globalThis as Record<string, unknown>)[COMMIT_SHA_GLOBAL] =
      'e60b4d1e113538d40f09e31717e949aaa08659f8';
    loadConfig({
      apiKey: TEST_PK,
      endpoint: 'https://api.test',
      maxBatchSize: 100,
      errorThrottleMs: 0,
      release: 'web@2026.07.16',
      environment: 'staging',
    });
    setUser({
      id: 'user-123',
      email: 'jane@example.com',
      account: { id: 'acct-42', name: 'Example Inc' },
    });
    const breadcrumb: Breadcrumb = {
      type: 'navigation',
      timestamp: new Date().toISOString(),
      category: 'navigation',
      message: 'https://app.example.com/dashboard',
    };

    const timingHandle = startTiming('fetch', 'POST', 'https://api.example.com/v1/assets/search');
    finalizeTiming(timingHandle, 'timeout');

    const wire = await captureWire(buildPayload('TypeError', FIXTURE_MESSAGE, FIXTURE_STACK, breadcrumb));
    expect(normalize(wire)).toEqual(normalize(loadFixture('full')));
  });
});
