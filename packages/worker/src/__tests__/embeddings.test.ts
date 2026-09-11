import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_PRICING } from '../investigate.js';
import { pricingFor } from '../harness/agent-loop.js';
import { PhaseMeter } from '../metered.js';
import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EmbeddingsUnavailable,
  embedTexts,
  ticketText,
} from '../embeddings.js';

function vector(value: number): number[] {
  return Array.from({ length: EMBEDDING_DIMS }, () => value);
}

function response(inputs: string[], usage = inputs.length * 2): Response {
  return Response.json({
    object: 'list',
    model: EMBEDDING_MODEL,
    data: inputs.map((input, index) => ({
      object: 'embedding',
      index,
      embedding: vector(Number(input)),
    })),
    usage: { prompt_tokens: usage, total_tokens: usage },
  });
}

function erroredResponse(): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.error(new TypeError('transport reset while reading body'));
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('embedTexts', () => {
  it('fails cleanly when OpenAI is not configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');

    await expect(embedTexts(['one'])).rejects.toBeInstanceOf(EmbeddingsUnavailable);
  });

  it('aborts provider requests without retrying cancellation as an outage', async () => {
    vi.stubEnv('OPENAI_API_KEY','test-key');
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      controller.abort(new Error('job cancelled'));
      init?.signal?.throwIfAborted();
      return response(['1']);
    });
    vi.stubGlobal('fetch',fetchMock);
    await expect(embedTexts(['1'],null,controller.signal)).rejects.toThrow('job cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('batches at 100 and restores provider-indexed vectors to input order', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const texts = Array.from({ length: 201 }, (_, index) => String(index));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[]; model: string; dimensions: number; encoding_format: string };
      expect(body).toMatchObject({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMS,
        encoding_format: 'float',
      });
      const normal = response(body.input);
      const payload = await normal.json() as { data: unknown[] };
      payload.data.reverse();
      return Response.json(payload);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await embedTexts(texts);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.model).toBe(EMBEDDING_MODEL);
    expect(result.vectors).toHaveLength(texts.length);
    expect(result.vectors.map((item) => item[0])).toEqual(texts.map(Number));
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    expect(calls.map(([, init]) => (JSON.parse(String(init.body)) as { input: string[] }).input.length))
      .toEqual([100, 100, 1]);
    expect(calls[0]?.[0]).toBe('https://api.openai.com/v1/embeddings');
    expect(new Headers(calls[0]?.[1].headers).get('authorization')).toBe('Bearer test-key');
  });

  it('times out each request after 20 seconds and exhausts three attempts', async () => {
    vi.useFakeTimers();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const pending = embedTexts(['one']);
    const rejection = expect(pending).rejects.toBeInstanceOf(EmbeddingsUnavailable);
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries 429 and server failures before succeeding', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('down', { status: 500 }))
      .mockResolvedValueOnce(response(['7']));
    vi.stubGlobal('fetch', fetchMock);

    await expect(embedTexts(['7'])).resolves.toMatchObject({ model: EMBEDDING_MODEL });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries transport failures while reading a successful response body', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(erroredResponse())
      .mockResolvedValueOnce(erroredResponse())
      .mockResolvedValueOnce(response(['7']));
    vi.stubGlobal('fetch', fetchMock);

    await expect(embedTexts(['7'])).resolves.toMatchObject({ model: EMBEDDING_MODEL });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry malformed JSON from a successful response', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{not json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(embedTexts(['7'])).rejects.toBeInstanceOf(EmbeddingsUnavailable);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry other HTTP failures or expose the response body', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('secret provider details', { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await embedTexts(['private request text']).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmbeddingsUnavailable);
    expect(String(error)).not.toContain('secret provider details');
    expect(String(error)).not.toContain('private request text');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong count', [{ object: 'embedding', index: 0, embedding: vector(1) }]],
    ['duplicate indexes', [
      { object: 'embedding', index: 0, embedding: vector(1) },
      { object: 'embedding', index: 0, embedding: vector(2) },
    ]],
    ['out-of-range index', [
      { object: 'embedding', index: 0, embedding: vector(1) },
      { object: 'embedding', index: 2, embedding: vector(2) },
    ]],
    ['wrong dimensions', [
      { object: 'embedding', index: 0, embedding: vector(1) },
      { object: 'embedding', index: 1, embedding: [2] },
    ]],
    ['non-numeric value', [
      { object: 'embedding', index: 0, embedding: vector(1) },
      { object: 'embedding', index: 1, embedding: [...vector(2).slice(0, -1), 'bad'] },
    ]],
    ['non-finite value', [
      { object: 'embedding', index: 0, embedding: vector(1) },
      { object: 'embedding', index: 1, embedding: [...vector(2).slice(0, -1), null] },
    ]],
  ])('rejects invalid vectors: %s', async (_name, data) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      model: EMBEDDING_MODEL,
      data,
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })));

    await expect(embedTexts(['one', 'two'])).rejects.toBeInstanceOf(EmbeddingsUnavailable);
  });

  it('meters every successful billed batch even when a later batch fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const texts = Array.from({ length: 101 }, (_, index) => String(index));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(texts.slice(0, 100), 10_000_000))
      .mockResolvedValueOnce(new Response('bad request', { status: 400 })));
    const record = vi.fn().mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'job', execution: 1, phase: 'embeddings', record });

    await expect(embedTexts(texts, meter)).rejects.toBeInstanceOf(EmbeddingsUnavailable);

    expect(record).not.toHaveBeenCalled();
    await meter.flush();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'embeddings',
      model: EMBEDDING_MODEL,
      usage: { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.2,
    }));
  });
});

describe('embedding metadata', () => {
  it('prices embeddings consistently in both worker pricing tables', () => {
    const expected = { input: 0.02, output: 0, cacheWrite: 0, cacheRead: 0 };
    expect(MODEL_PRICING[EMBEDDING_MODEL]).toEqual(expected);
    expect(pricingFor(EMBEDDING_MODEL)).toEqual(expected);
  });

  it('builds ticket identity text only from immutable fields', () => {
    const base = {
      name: 'Checkout cannot finish',
      control: 'Place order button',
      what_happened: 'The button stays disabled after valid payment details.',
    };

    expect(ticketText({ ...base, steps: 'Old generated steps' }))
      .toBe(ticketText({ ...base, steps: 'Entirely different generated steps' }));
    expect(ticketText(base)).toContain(base.name);
    expect(ticketText(base)).toContain(base.control);
    expect(ticketText(base)).toContain(base.what_happened);
  });
});
