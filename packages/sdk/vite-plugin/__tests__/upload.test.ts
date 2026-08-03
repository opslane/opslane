// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { uploadSourceMaps, type UploadEntry } from '../upload.js';

const ENTRY: UploadEntry = {
  debugId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  fileName: 'assets/app.js.map',
  mapSource: '{"version":3}',
};

describe('uploadSourceMaps', () => {
  it.each([200, 201])('treats HTTP %d as success', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', { status }),
    );
    const result = await uploadSourceMaps([ENTRY], {
      endpoint: 'https://ingestion.example/',
      key: 'opslane_sk_test',
      fetchImpl,
    });

    expect(result).toEqual({ uploaded: 1, failed: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://ingestion.example/api/v1/sourcemaps/${ENTRY.debugId}`,
      expect.objectContaining({
        method: 'PUT',
        headers: {
          'X-API-Key': 'opslane_sk_test',
          'Content-Type': 'application/json',
        },
        body: ENTRY.mapSource,
      }),
    );
  });

  it('collects HTTP failures without throwing', async () => {
    const result = await uploadSourceMaps([ENTRY], {
      endpoint: 'https://ingestion.example',
      key: 'opslane_sk_test',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('', { status: 403 }),
      ),
    });
    expect(result.uploaded).toBe(0);
    expect(result.failed).toEqual([
      { fileName: ENTRY.fileName, reason: 'HTTP 403' },
    ]);
  });

  it('retries one network failure and then reports it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error('connection refused'),
    );
    const result = await uploadSourceMaps([ENTRY], {
      endpoint: 'http://127.0.0.1:1',
      key: 'opslane_sk_test',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.failed[0]?.reason).toContain('connection refused');
  });

  it('paces on 429 and retries the same map', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', {
        status: 429,
        headers: { 'Retry-After': '0' },
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 429,
        headers: { 'Retry-After': '0' },
      }))
      .mockResolvedValueOnce(new Response('', { status: 201 }));
    const result = await uploadSourceMaps([ENTRY], {
      endpoint: 'https://ingestion.example',
      key: 'opslane_sk_test',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ uploaded: 1, failed: [] });
  });

  // A 429 from an intermediary (nginx, a CDN, a load balancer) often carries no
  // Retry-After at all. Retrying that with no delay turns the pacing loop into
  // an amplifier against the limiter it is meant to respect.
  it('waits the documented default when a 429 omits Retry-After', async () => {
    const delays: number[] = [];
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((callback: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );
    try {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(new Response('', { status: 201 }));
      const result = await uploadSourceMaps([ENTRY], {
        endpoint: 'https://ingestion.example',
        key: 'opslane_sk_test',
        fetchImpl,
      });
      expect(result).toEqual({ uploaded: 1, failed: [] });
      expect(delays).toEqual([30_000]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('skips maps over the server cap', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await uploadSourceMaps([
      { ...ENTRY, mapSource: 'x'.repeat(32 * 1024 * 1024 + 1) },
    ], {
      endpoint: 'https://ingestion.example',
      key: 'opslane_sk_test',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.failed[0]?.reason).toContain('32 MiB');
  });
});
