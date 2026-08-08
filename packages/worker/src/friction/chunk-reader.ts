import { gunzipSync } from 'node:zlib';
import type { SessionChunkEnvelope } from '@opslane/shared';
import type { SessionChunkRow } from '../db.js';
import { fetchObject, getMinIOConfig } from '../minio-client.js';

export const MAX_CHUNK_COMPRESSED_BYTES = 5 * 1024 * 1024;
export const MAX_CHUNK_INFLATED_BYTES = 25 * 1024 * 1024;
export const MAX_SESSION_INFLATED_BYTES = 20 * 1024 * 1024;

export class ChunkReadError extends Error {
  override readonly name = 'ChunkReadError';
}

export interface BoundedReadResult {
  envelopes: SessionChunkEnvelope[];
  envelopeSeqs: number[];
  inflatedBytes: number;
  truncated: boolean;
  unreadableCount: number;
}

/** The sole worker object-read path for scrubbed session chunks. */
export async function readChunksBounded(
  chunks: SessionChunkRow[],
  opts?: { skipUnreadable?: boolean },
): Promise<BoundedReadResult> {
  if (chunks.length === 0) {
    return { envelopes: [], envelopeSeqs: [], inflatedBytes: 0, truncated: false, unreadableCount: 0 };
  }
  const minio = getMinIOConfig();
  if (!minio) throw new ChunkReadError('MinIO not configured');

  const envelopes: SessionChunkEnvelope[] = [];
  const envelopeSeqs: number[] = [];
  let inflatedBytes = 0;
  let unreadableCount = 0;
  for (const chunk of chunks) {
    if (inflatedBytes >= MAX_SESSION_INFLATED_BYTES) {
      return { envelopes, envelopeSeqs, inflatedBytes, truncated: true, unreadableCount };
    }
    try {
      if (chunk.size_bytes == null || chunk.size_bytes > MAX_CHUNK_COMPRESSED_BYTES) {
        throw new ChunkReadError(
          `chunk ${chunk.session_id}/${chunk.seq}: compressed size ${chunk.size_bytes ?? 'unknown'} outside policy`,
        );
      }
      const compressed = await fetchObject(chunk.object_key, minio);
      let inflated: Buffer;
      try {
        inflated = gunzipSync(compressed, { maxOutputLength: MAX_CHUNK_INFLATED_BYTES });
      } catch (error: unknown) {
        throw new ChunkReadError(
          `chunk ${chunk.session_id}/${chunk.seq}: gunzip failed/over-cap: ${String(error)}`,
        );
      }
      if (inflatedBytes + inflated.length > MAX_SESSION_INFLATED_BYTES) {
        return { envelopes, envelopeSeqs, inflatedBytes, truncated: true, unreadableCount };
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(inflated.toString('utf8'));
      } catch {
        throw new ChunkReadError(`chunk ${chunk.session_id}/${chunk.seq}: invalid JSON envelope`);
      }
      if (!isSessionChunkEnvelope(envelope)) {
        throw new ChunkReadError(`chunk ${chunk.session_id}/${chunk.seq}: invalid envelope shape`);
      }
      envelopes.push(envelope);
      envelopeSeqs.push(chunk.seq);
      inflatedBytes += inflated.length;
    } catch (error: unknown) {
      // Only a chunk-local data defect is skippable, and every one of those is
      // raised here as a ChunkReadError. A fetch failure is not evidence about
      // the chunk: swallowing a MinIO outage would write a permanent
      // `coverage: partial` row for a session whose replay is intact, and
      // nothing re-analyzes it (the backfill skips rows already at this
      // rule_version). Transport errors must fail the job so it retries.
      if (!opts?.skipUnreadable || !(error instanceof ChunkReadError)) throw error;
      unreadableCount += 1;
    }
  }

  return { envelopes, envelopeSeqs, inflatedBytes, truncated: false, unreadableCount };
}

function isSessionChunkEnvelope(value: unknown): value is SessionChunkEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['events'])) return false;
  const meta = record['meta'];
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as Record<string, unknown>;
  return typeof m['sdk_version'] === 'string'
    && typeof m['has_full_snapshot'] === 'boolean'
    && typeof m['chunked_at'] === 'number';
}
