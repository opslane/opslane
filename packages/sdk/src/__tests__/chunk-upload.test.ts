import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetChunkUploadState, flushInline, uploadChunk } from '../chunk-upload';
import { loadConfig, resetConfig } from '../config';

const ENDPOINT = 'https://ingest.example.com';

describe('uploadChunk', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetConfig();
    _resetChunkUploadState();
    loadConfig({ apiKey: 'test-key', endpoint: ENDPOINT });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends exactly one request carrying the gzip body', async () => {
    expect(await uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/api/v1/sessions/sess_abc/chunks/0?has_full_snapshot=1`);
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-API-Key': 'test-key' },
      keepalive: false,
    });
    expect((options.body as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  it('sends an explicit false query flag when there is no full snapshot', async () => {
    await uploadChunk('sess_abc', 1, [{ type: 3, timestamp: 1 }] as never, false);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${ENDPOINT}/api/v1/sessions/sess_abc/chunks/1?has_full_snapshot=0`,
    );
  });

  it('reports stop on 403 and 410', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).toBe('stop');
    _resetChunkUploadState();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 410 });
    expect(await uploadChunk('sess_abc', 1, [{ type: 2, timestamp: 1 }] as never, true)).toBe('stop');
  });

  it('never throws and skips empty chunks', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(
      uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true),
    ).resolves.toBe(false);
    fetchMock.mockClear();
    expect(await uploadChunk('sess_abc', 0, [] as never, true)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flushInline', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetConfig();
    _resetChunkUploadState();
    loadConfig({ apiKey: 'test-key', endpoint: ENDPOINT });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends one keepalive request to the same route', async () => {
    expect(await flushInline('sess_abc', 3, [{ type: 2, timestamp: 1 }] as never)).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/api/v1/sessions/sess_abc/chunks/3?has_full_snapshot=0`);
    expect(options).toMatchObject({
      keepalive: true,
      headers: { 'Content-Type': 'application/gzip', 'X-API-Key': 'test-key' },
    });
  });

  // Browsers cap keepalive request bodies at 64KiB. Over that the send would be
  // refused by the browser itself, so the caller must fall back to a normal
  // request. This is the only reason the 64KiB number exists.
  it('drops an over-budget tail and never throws', async () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => ({
      type: 3,
      timestamp: i,
      data: { text: `unique-${i}-${'x'.repeat(20)}` },
    }));
    expect(await flushInline('sess_abc', 4, huge as never)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error('page gone'));
    await expect(
      flushInline('sess_abc', 5, [{ type: 2, timestamp: 1 }] as never),
    ).resolves.toBe(false);
  });

  it('propagates stop from the tail path', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await flushInline('sess_abc', 6, [{ type: 2, timestamp: 1 }] as never)).toBe('stop');
  });
});
