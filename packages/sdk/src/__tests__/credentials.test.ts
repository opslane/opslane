import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, resetConfig } from '../config';
import { enqueueEvent, flushEvents, flushOnUnload, _resetQueue } from '../transport';
import { registerSession, resetSessionRegistrations } from '../replay';
import { uploadChunk, flushInline, _resetChunkUploadState } from '../chunk-upload';
import { TEST_PK } from './test-keys';

vi.mock('../gzip', () => ({ gzip: async () => new Uint8Array([1]), gzipSupported: () => true }));

afterEach(() => {
  resetConfig();
  _resetQueue();
  resetSessionRegistrations();
  _resetChunkUploadState();
  vi.unstubAllGlobals();
});

it('omits credentials for events, unload, session registration, and both chunk paths', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Response('{"recording":true}', { status: 202 });
  }));
  loadConfig({ apiKey: TEST_PK, endpoint: '/opslane', errorThrottleMs: 0 });
  const event = {
    timestamp: new Date().toISOString(),
    error: { type: 'Error', message: 'credentials', stack: '' },
    breadcrumbs: [],
    context: { url: location.href, user_agent: 'test' },
    sdk_version: 'test',
  };
  enqueueEvent(event);
  await flushEvents();
  enqueueEvent(event);
  flushOnUnload();
  expect(await registerSession('credentials')).toBe(true);
  const events = [{ type: 4 as const, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } }];
  expect(await uploadChunk('credentials', 0, events, true)).toBe(true);
  expect(await flushInline('credentials', 1, events)).toBe(true);
  expect(calls).toHaveLength(5);
  for (const { url, init } of calls) {
    expect(url).toMatch(new RegExp(`^${location.origin}/opslane/api/v1/`));
    expect(init.credentials).toBe('omit');
    const headers = new Headers(init.headers);
    expect(headers.has('Cookie')).toBe(false);
    expect(headers.has('Authorization')).toBe(false);
  }
});
