import type { eventWithTime } from '@rrweb/types';
import { getConfig } from './config';
import { gzip } from './gzip';
import { sdkFetch } from './network';
import { SDK_VERSION } from './version';

const INLINE_BUDGET_BYTES = 64 * 1024;

export type UploadResult = boolean | 'stop';

let stopped = false;

export function _resetChunkUploadState(): void {
  stopped = false;
}

function buildBody(events: eventWithTime[], hasFullSnapshot: boolean): string {
  return JSON.stringify({
    events,
    meta: {
      sdk_version: SDK_VERSION,
      has_full_snapshot: hasFullSnapshot,
      chunked_at: Date.now(),
    },
  });
}

/**
 * One request per chunk. Ingestion validates the bytes, writes them to object
 * storage server-side, and commits the row. There is no presigned-URL
 * handshake: Cloudflare R2 does not implement the S3 POST Object API (#194).
 */
async function sendChunk(
  sessionID: string,
  seq: number,
  compressed: Uint8Array,
  hasFullSnapshot: boolean,
  keepalive: boolean,
): Promise<UploadResult> {
  const config = getConfig();
  const flag = hasFullSnapshot ? '1' : '0';
  const response = await sdkFetch(
    `${config.endpoint}/api/v1/sessions/${encodeURIComponent(sessionID)}/chunks/${seq}?has_full_snapshot=${flag}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-API-Key': config.apiKey },
      body: compressed as Uint8Array<ArrayBuffer>,
      keepalive,
    },
  );
  if (response.status === 403 || response.status === 410) {
    stopped = true;
    return 'stop';
  }
  return response.ok;
}

export async function uploadChunk(
  sessionID: string,
  seq: number,
  events: eventWithTime[],
  hasFullSnapshot: boolean,
): Promise<UploadResult> {
  if (stopped || events.length === 0) return false;
  try {
    const compressed = await gzip(buildBody(events, hasFullSnapshot));
    if (!compressed) return false;
    return await sendChunk(sessionID, seq, compressed, hasFullSnapshot, false);
  } catch {
    return false;
  }
}

/**
 * The page-is-closing path. keepalive lets the request outlive the document,
 * but browsers cap keepalive bodies at 64KiB — that limit belongs to keepalive,
 * not to the endpoint, which accepts full-size chunks. Over budget, the caller
 * falls back to uploadChunk.
 */
export async function flushInline(
  sessionID: string,
  seq: number,
  events: eventWithTime[],
): Promise<UploadResult> {
  if (stopped || events.length === 0 || seq < 0) return false;
  try {
    const compressed = await gzip(buildBody(events, false));
    if (!compressed || compressed.byteLength > INLINE_BUDGET_BYTES) return false;
    return await sendChunk(sessionID, seq, compressed, false, true);
  } catch {
    return false;
  }
}
