import { computeDebugId } from '@opslane/sdk/build/debug-id';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedJob, ErrorEventData } from '../db.js';

const APP_FILE = 'https://app.example/assets/entry-index.CaWHNXv4.js';
const MAP = JSON.stringify({
  version: 3,
  sources: ['src/AssetDetails.vue'],
  sourcesContent: ['function deleteAsset() {}\n'],
  names: ['deleteAsset'],
  mappings: 'AAAAA',
});

let event: ErrorEventData | null;
let sourceMapRow: { debug_id: string; object_key: string; content_sha256: string } | null;
let resolution: { status: string; envelope: unknown; resolverVersion: number } | null;
let cachedPosition: {
  original_file: string;
  original_function: string;
  original_line: number;
} | null;

const query = vi.fn(async (sql: string, params: unknown[]) => {
  if (sql.includes('SELECT original_file')) {
    return { rows: cachedPosition ? [cachedPosition] : [] };
  }
  if (sql.includes('INSERT INTO sourcemap_position_cache')) {
    cachedPosition ??= {
      original_file: String(params[6]),
      original_function: String(params[7]),
      original_line: Number(params[8]),
    };
    return { rows: [] };
  }
  if (sql.includes('INSERT INTO error_event_resolutions')) {
    resolution = {
      status: String(params[2]),
      envelope: params[3],
      resolverVersion: Number(params[4]),
    };
    return { rows: [] };
  }
  throw new Error(`unexpected query: ${sql}`);
});

const getErrorEvent = vi.fn(async () => event);
const getSourceMapRows = vi.fn(async () => sourceMapRow ? [sourceMapRow] : []);
const fetchObject = vi.fn(async () => Buffer.from(MAP));

vi.mock('../db.js', () => ({
  getErrorEvent,
  getPool: () => ({ query }),
  getSourceMapRows,
}));

vi.mock('../minio-client.js', () => ({
  getMinIOConfig: () => ({ endpoint: 'http://minio.test' }),
  fetchObject,
}));

const { runStackResolve } = await import('../resolve/job.js');

function claimedJob(eventId = '10000000-0000-0000-0000-000000000001'): ClaimedJob {
  return {
    id: '20000000-0000-0000-0000-000000000001',
    workerId: 'worker-1',
    errorGroupId: null,
    eventId,
    sourceId: null,
    projectId: '00000000-0000-0000-0000-000000000001',
    jobType: 'stack_resolve',
    attempts: 0,
    guidance: null,
    leaseGeneration: '1',
    triggeredBy: null,
    sessionId: null,
  };
}

describe('stack_resolve job', () => {
  beforeEach(async () => {
    const artifact = await computeDebugId(new TextEncoder().encode(MAP));
    sourceMapRow = {
      debug_id: artifact.debugId,
      object_key: 'maps/asset.map',
      content_sha256: artifact.contentSha256,
    };
    event = {
      id: '10000000-0000-0000-0000-000000000001',
      error_type: 'TypeError',
      error_message: 'boom',
      stack_trace_raw: `TypeError: boom\n    at deleteAsset (${APP_FILE}:1:1)`,
      stack_trace_resolved: null,
      debug_meta: JSON.stringify({
        images: [{
          type: 'sourcemap',
          code_file: APP_FILE,
          debug_id: artifact.debugId,
        }],
      }),
      breadcrumbs: '[]',
      context: '{}',
      release: null,
      session_id: null,
      platform: 'javascript',
    };
    resolution = null;
    cachedPosition = null;
    query.mockClear();
    getErrorEvent.mockClear();
    getSourceMapRows.mockClear();
    fetchObject.mockClear();
  });

  it('writes a resolved v2 envelope and caches its original position', async () => {
    await runStackResolve(claimedJob());

    expect(resolution).toEqual({
      status: 'resolved',
      envelope: {
        version: 2,
        frames: [{
          original_file: 'src/AssetDetails.vue',
          original_function: 'deleteAsset',
          original_line: 1,
          generated: { line: 1, column: 1 },
        }],
      },
      resolverVersion: 2,
    });
    expect(cachedPosition).toEqual({
      original_file: 'src/AssetDetails.vue',
      original_function: 'deleteAsset',
      original_line: 1,
    });
  });

  it('publishes pending before checking for a late source map', async () => {
    getSourceMapRows.mockImplementationOnce(async () => {
      expect(resolution?.status).toBe('pending');
      return sourceMapRow ? [sourceMapRow] : [];
    });

    await runStackResolve(claimedJob());

    expect(resolution?.status).toBe('resolved');
  });

  it('produces the same envelope from a cached position without fetching the map', async () => {
    await runStackResolve(claimedJob());
    const uncached = resolution;
    fetchObject.mockClear();
    resolution = null;

    await runStackResolve(claimedJob());

    expect(resolution).toEqual(uncached);
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('records no_map when the event carries no debug id', async () => {
    event = { ...event!, debug_meta: '{"images":[]}' };

    await runStackResolve(claimedJob());

    expect(resolution).toEqual({ status: 'no_map', envelope: null, resolverVersion: 2 });
  });

  it('leaves the resolution pending when the source map has not arrived', async () => {
    sourceMapRow = null;

    await runStackResolve(claimedJob());

    expect(resolution).toEqual({ status: 'pending', envelope: null, resolverVersion: 2 });
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('records a retryable failure when object storage is unavailable', async () => {
    fetchObject.mockRejectedValueOnce(new Error('storage offline'));

    await expect(runStackResolve(claimedJob())).rejects.toThrow('resolution_failed');
    expect(resolution).toEqual({ status: 'failed', envelope: null, resolverVersion: 2 });
  });

  it('settles the explicit raw fallback when the final attempt fails', async () => {
    fetchObject.mockRejectedValueOnce(new Error('storage offline'));
    const job = { ...claimedJob(), attempts: 2, maxAttempts: 3 };

    await expect(runStackResolve(job)).rejects.toThrow('resolution_failed');
    expect(resolution).toEqual({ status: 'no_map', envelope: null, resolverVersion: 2 });
  });

  it('is idempotent across retries', async () => {
    await runStackResolve(claimedJob());
    await runStackResolve(claimedJob());

    expect(resolution?.status).toBe('resolved');
  });

  it('rejects an event outside the claimed project', async () => {
    getErrorEvent.mockResolvedValueOnce(null);

    await expect(runStackResolve(claimedJob())).rejects.toThrow('not found');
    expect(resolution).toBeNull();
  });
});
