export interface UploadEntry {
  debugId: string;
  mapSource: string;
  fileName: string;
}

export interface UploadOutcome {
  uploaded: number;
  failed: { fileName: string; reason: string }[];
}

const CONCURRENCY = 4;
const MAX_MAP_BYTES = 32 * 1024 * 1024;
const RETRY_AFTER_DEFAULT_SECONDS = 30;
const RETRY_AFTER_CAP_SECONDS = 120;
const MAX_ATTEMPTS = 8;

export async function uploadSourceMaps(
  entries: UploadEntry[],
  opts: { endpoint: string; key: string; fetchImpl?: typeof fetch },
): Promise<UploadOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.endpoint.replace(/\/+$/, '');
  const outcome: UploadOutcome = { uploaded: 0, failed: [] };
  const queue = [...entries];
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function putOnce(entry: UploadEntry): Promise<
    | { ok: true }
    | { ok: false; retryAfterSeconds?: number; reason?: string }
  > {
    try {
      const response = await fetchImpl(
        `${base}/api/v1/sourcemaps/${entry.debugId}`,
        {
          method: 'PUT',
          headers: {
            'X-API-Key': opts.key,
            'Content-Type': 'application/json',
          },
          body: entry.mapSource,
        },
      );
      if (response.status === 200 || response.status === 201) {
        return { ok: true };
      }
      if (response.status === 429) {
        // An absent header reads as `null`, and `Number(null)` is 0 — finite
        // and non-negative, so a naive parse would retry with no delay at all
        // and amplify the load the limiter is trying to shed. Only a header
        // that is actually present and numeric overrides the default.
        const header = response.headers.get('Retry-After');
        const parsed = header === null || header.trim() === ''
          ? Number.NaN
          : Number(header);
        return {
          ok: false,
          retryAfterSeconds: Math.min(
            Number.isFinite(parsed) && parsed >= 0
              ? parsed
              : RETRY_AFTER_DEFAULT_SECONDS,
            RETRY_AFTER_CAP_SECONDS,
          ),
        };
      }
      return { ok: false, reason: `HTTP ${response.status}` };
    } catch (error: unknown) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function worker(): Promise<void> {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      if (new TextEncoder().encode(entry.mapSource).byteLength > MAX_MAP_BYTES) {
        outcome.failed.push({
          fileName: entry.fileName,
          reason: 'over 32 MiB server limit',
        });
        continue;
      }

      let lastReason = 'unknown';
      let uploaded = false;
      let networkRetried = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const result = await putOnce(entry);
        if (result.ok) {
          outcome.uploaded += 1;
          uploaded = true;
          break;
        }
        if (result.retryAfterSeconds !== undefined) {
          lastReason = 'HTTP 429';
          if (attempt + 1 < MAX_ATTEMPTS) {
            await sleep(result.retryAfterSeconds * 1_000);
          }
          continue;
        }
        lastReason = result.reason ?? 'unknown';
        if (!lastReason.startsWith('HTTP') && !networkRetried) {
          networkRetried = true;
          continue;
        }
        break;
      }
      if (!uploaded) {
        outcome.failed.push({ fileName: entry.fileName, reason: lastReason });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker),
  );
  return outcome;
}
