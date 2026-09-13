import type { PhaseMeter } from './metered.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

type Meter = Pick<PhaseMeter, 'add'>;

export class EmbeddingsUnavailable extends Error {
  constructor(message = 'Embeddings are unavailable') {
    super(message);
    this.name = 'EmbeddingsUnavailable';
  }
}

export interface EmbeddableTicket {
  name: string;
  control: string;
  what_happened: string;
  steps?: string | null;
}

export function ticketText(ticket: EmbeddableTicket): string {
  return [
    `Name: ${ticket.name}`,
    `Control: ${ticket.control}`,
    `What happened: ${ticket.what_happened}`,
  ].join('\n');
}

export async function embedTexts(
  texts: string[],
  meter?: Meter | null,
  signal?: AbortSignal,
): Promise<{ vectors: number[][]; model: string }> {
  signal?.throwIfAborted();
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new EmbeddingsUnavailable('OpenAI embeddings are not configured');

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    vectors.push(...await embedBatch(batch, apiKey, meter, signal));
  }
  return { vectors, model: EMBEDDING_MODEL };
}

async function embedBatch(texts: string[], apiKey: string, meter?: Meter | null, signal?: AbortSignal): Promise<number[][]> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMS,
          encoding_format: 'float',
        }),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) continue;
        throw new EmbeddingsUnavailable(`Embedding request failed (${response.status})`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          throw new EmbeddingsUnavailable('Embedding response was invalid');
        }
        throw error;
      }
      recordUsage(payload, meter);
      return vectorsFromResponse(payload, texts.length);
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (error instanceof EmbeddingsUnavailable) throw error;
      if (attempt === MAX_ATTEMPTS) {
        throw new EmbeddingsUnavailable('Embedding request failed after retries');
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new EmbeddingsUnavailable('Embedding request failed after retries');
}

function recordUsage(payload: unknown, meter?: Meter | null): void {
  if (!meter || !isRecord(payload)) return;
  const usage = payload['usage'];
  if (!isRecord(usage)) return;
  const promptTokens = usage['prompt_tokens'];
  meter.add(EMBEDDING_MODEL, {
    input: typeof promptTokens === 'number' && Number.isFinite(promptTokens) ? promptTokens : 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
}

function vectorsFromResponse(payload: unknown, expectedCount: number): number[][] {
  if (!isRecord(payload) || !Array.isArray(payload['data']) || payload['data'].length !== expectedCount) {
    throw new EmbeddingsUnavailable('Embedding response had an invalid vector count');
  }

  const ordered: Array<number[] | undefined> = Array.from({ length: expectedCount });
  for (const item of payload['data']) {
    if (!isRecord(item)) throw new EmbeddingsUnavailable('Embedding response had an invalid item');
    const index = item['index'];
    const embedding = item['embedding'];
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= expectedCount) {
      throw new EmbeddingsUnavailable('Embedding response had an invalid index');
    }
    if (ordered[index as number] !== undefined) {
      throw new EmbeddingsUnavailable('Embedding response had a duplicate index');
    }
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS
      || !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new EmbeddingsUnavailable('Embedding response had an invalid vector');
    }
    ordered[index as number] = embedding;
  }

  if (ordered.some((embedding) => embedding === undefined)) {
    throw new EmbeddingsUnavailable('Embedding response had a missing index');
  }
  return ordered as number[][];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
