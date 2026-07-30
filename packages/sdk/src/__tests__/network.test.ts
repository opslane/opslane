import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  patchFetch,
  unpatchFetch,
  patchXHR,
  unpatchXHR,
  sdkFetch,
} from '../network';
import { clearBreadcrumbs, getBreadcrumbs } from '../breadcrumbs';
import { loadConfig, resetConfig } from '../config';
import { TEST_PK } from './test-keys';

describe('Network Interceptor', () => {
  beforeEach(() => {
    clearBreadcrumbs();
    resetConfig();
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });
  });

  afterEach(() => {
    unpatchFetch();
    unpatchXHR();
    clearBreadcrumbs();
    resetConfig();
    vi.restoreAllMocks();
  });

  describe('fetch interceptor', () => {
    it('should record a breadcrumb for successful fetch calls', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      const originalFetch = vi.fn().mockResolvedValue(mockResponse);
      globalThis.fetch = originalFetch;

      patchFetch();

      await fetch('https://api.example.com/users', { method: 'GET' });

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].type).toBe('fetch');
      expect(crumbs[0].category).toBe('fetch');
      expect(crumbs[0].message).toBe('GET https://api.example.com/users');
      expect(crumbs[0].data).toEqual({
        method: 'GET',
        url: 'https://api.example.com/users',
        status_code: 200,
      });
      expect(crumbs[0].level).toBe('info');
    });

    it('should record a breadcrumb for failed fetch calls', async () => {
      const originalFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      globalThis.fetch = originalFetch;

      patchFetch();

      try {
        await fetch('https://api.example.com/down');
      } catch {
        // expected
      }

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].type).toBe('fetch');
      expect(crumbs[0].level).toBe('error');
      expect(crumbs[0].data!.error).toBe('Failed to fetch');
    });

    it('should default to GET when no method is specified', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      patchFetch();
      await fetch('https://api.example.com/data');

      const crumbs = getBreadcrumbs();
      expect(crumbs[0].data!.method).toBe('GET');
    });

    it('should handle Request objects as input', async () => {
      const mockResponse = new Response('ok', { status: 201 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      patchFetch();
      const req = new Request('https://api.example.com/items', {
        method: 'POST',
      });
      await fetch(req);

      const crumbs = getBreadcrumbs();
      expect(crumbs[0].data!.method).toBe('POST');
      expect(crumbs[0].data!.url).toBe('https://api.example.com/items');
    });

    it('should NOT intercept requests to the SDK endpoint', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      patchFetch();
      await fetch('https://ingest.example.com/api/v1/events', {
        method: 'POST',
      });

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(0);
    });

    it('should restore original fetch on unpatch', () => {
      const originalFetch = vi.fn();
      globalThis.fetch = originalFetch;

      patchFetch();
      unpatchFetch();

      expect(globalThis.fetch).toBe(originalFetch);
    });

    it('bypasses telemetry and breadcrumbs for SDK-owned storage traffic', async () => {
      const originalFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      globalThis.fetch = originalFetch;
      patchFetch();
      await sdkFetch('https://storage.example.com/chunk', { method: 'POST' });
      expect(originalFetch).toHaveBeenCalledTimes(1);
      expect(getBreadcrumbs()).toHaveLength(0);
    });

    it('should never throw even if breadcrumb adding fails', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      patchFetch();

      // Should not throw
      await expect(fetch('https://api.example.com/safe')).resolves.toBeTruthy();
    });
  });

  describe('XMLHttpRequest interceptor', () => {
    it('should record a breadcrumb for XHR requests', () => {
      patchXHR();

      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://api.example.com/data');

      // Simulate the load event
      Object.defineProperty(xhr, 'status', { value: 200, writable: true });
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true });
      xhr.dispatchEvent(new Event('loadend'));

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].type).toBe('xhr');
      expect(crumbs[0].category).toBe('xhr');
      expect(crumbs[0].message).toBe('GET https://api.example.com/data');
      expect(crumbs[0].data).toEqual({
        method: 'GET',
        url: 'https://api.example.com/data',
        status_code: 200,
      });
    });

    it('should NOT intercept XHR to the SDK endpoint', () => {
      patchXHR();

      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://ingest.example.com/api/v1/events');

      Object.defineProperty(xhr, 'status', { value: 200, writable: true });
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true });
      xhr.dispatchEvent(new Event('loadend'));

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(0);
    });

    it('should restore original XHR.open on unpatch', () => {
      const originalOpen = XMLHttpRequest.prototype.open;
      patchXHR();
      unpatchXHR();

      expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    });
  });
});
