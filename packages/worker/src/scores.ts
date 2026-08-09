import { resolveTracingConfig } from './tracing-config.js';

export interface ScoreInput {
  traceId: string;
  name: string;
  value: string | number;
  dataType: 'CATEGORICAL' | 'NUMERIC' | 'BOOLEAN';
  id?: string;
  comment?: string;
  /** Free-form; the scores API accepts metadata but has no timestamp field. */
  metadata?: Record<string, string>;
}

interface ScoreDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

const SCORE_TIMEOUT_MS = 5_000;

/**
 * Push a score to Langfuse. Disabled tracing is a permanent no-op; transport
 * and HTTP failures throw so queued callers can use normal retry semantics.
 */
export async function pushScore(input: ScoreInput, deps: ScoreDeps = {}): Promise<boolean> {
  const config = resolveTracingConfig(deps.env ?? process.env);
  if (config.status !== 'enabled') return false;

  const auth = Buffer.from(
    `${config.credentials.publicKey}:${config.credentials.secretKey}`,
  ).toString('base64');
  const response = await (deps.fetchImpl ?? fetch)(`${config.baseUrl}/api/public/scores`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Carry the response body: a retrying caller's logs must distinguish a
    // permanent 400 (bad payload) from a transient 5xx.
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Langfuse score rejected: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
    );
  }
  // Drain the body so undici can release the connection for reuse.
  await response.text().catch(() => {});
  return true;
}
