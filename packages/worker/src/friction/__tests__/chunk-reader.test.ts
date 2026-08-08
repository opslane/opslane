import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionChunkRow } from '../../db.js';

vi.mock('../../minio-client.js', () => ({
  getMinIOConfig: vi.fn(() => ({ endpoint: 'http://minio', accessKey: 'x', secretKey: 'y', bucket: 'b' })),
  fetchObject: vi.fn(),
}));

const { fetchObject } = await import('../../minio-client.js');
const {
  ChunkReadError,
  MAX_CHUNK_COMPRESSED_BYTES,
  readChunksBounded,
} = await import('../chunk-reader.js');

function row(overrides: Partial<SessionChunkRow> = {}): SessionChunkRow {
  return {
    session_id: 'session-1', seq: 0, object_key: 'chunks/0.json.gz',
    size_bytes: 100, has_full_snapshot: true, ...overrides,
  };
}

function envelope(padding = ''): Buffer {
  return gzipSync(JSON.stringify({
    events: [],
    meta: { sdk_version: 'test', has_full_snapshot: true, chunked_at: 1 },
    padding,
  }));
}

describe('readChunksBounded', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts an empty scrubbed session without requiring object storage', async () => {
    await expect(readChunksBounded([])).resolves.toEqual({
      envelopes: [], envelopeSeqs: [], inflatedBytes: 0, truncated: false, unreadableCount: 0,
    });
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', null],
    ['oversized', MAX_CHUNK_COMPRESSED_BYTES + 1],
  ])('refuses %s committed size before fetching', async (_label, size) => {
    await expect(readChunksBounded([row({ size_bytes: size })])).rejects.toBeInstanceOf(ChunkReadError);
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('rejects corrupt gzip bytes', async () => {
    vi.mocked(fetchObject).mockResolvedValue(Buffer.from('not gzip'));
    await expect(readChunksBounded([row()])).rejects.toThrow(/gunzip failed/);
  });

  it('skips chunk-local failures only when requested', async () => {
    vi.mocked(fetchObject)
      .mockResolvedValueOnce(envelope())
      .mockResolvedValueOnce(Buffer.from('not gzip'))
      .mockResolvedValueOnce(envelope());
    const result = await readChunksBounded([
      row(), row({ seq: 1, object_key: 'chunks/1.json.gz' }),
      row({ seq: 2, object_key: 'chunks/2.json.gz' }),
    ], { skipUnreadable: true });
    expect(result.envelopeSeqs).toEqual([0, 2]);
    expect(result.unreadableCount).toBe(1);
  });

  it('rethrows a transport failure even when skipping unreadable chunks', async () => {
    // A fetch failure says nothing about the chunk. Swallowing it would record
    // a permanent degraded-coverage analysis row for an intact replay, and
    // nothing re-analyzes that session. It has to fail so the job retries.
    vi.mocked(fetchObject)
      .mockResolvedValueOnce(envelope())
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED minio:9000'));

    await expect(readChunksBounded([
      row(), row({ seq: 1, object_key: 'chunks/1.json.gz' }),
    ], { skipUnreadable: true })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('bounds a gzip bomb during decompression', async () => {
    const bomb = gzipSync(Buffer.alloc(26 * 1024 * 1024));
    vi.mocked(fetchObject).mockResolvedValue(bomb);
    await expect(readChunksBounded([row({ size_bytes: bomb.length })])).rejects.toThrow(/over-cap/);
  });

  it('returns only the bounded prefix when the cumulative budget is exceeded', async () => {
    const first = envelope('a'.repeat(11 * 1024 * 1024));
    const second = envelope('b'.repeat(11 * 1024 * 1024));
    vi.mocked(fetchObject).mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const result = await readChunksBounded([
      row({ size_bytes: first.length }),
      row({ seq: 1, object_key: 'chunks/1.json.gz', size_bytes: second.length }),
    ]);

    expect(result.truncated).toBe(true);
    expect(result.envelopes).toHaveLength(1);
    expect(result.inflatedBytes).toBeGreaterThan(10 * 1024 * 1024);
  });
});
